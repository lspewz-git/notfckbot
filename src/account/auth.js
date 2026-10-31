/**
 * Signing in to the panel. Telegram already knows who writes to the bot, so every account is a
 * Telegram one; every way in ends in the same session, an httpOnly cookie:
 *
 * - "Войти через Telegram" on the sign-in page: the page gets a one-time code and opens the bot with
 *   it (t.me/<bot>?start=L<code>). The bot asks the user to confirm, and only then the page that
 *   holds the code's secret is let in. The question stops a planted link: someone who sends you
 *   their code can't get in as you without your "Да, это я".
 * - /login in the bot: a one-time link. The page behind it asks for a press before it spends the
 *   token (a POST): link previews and prefetchers only GET, so they can't use it up.
 * - login-link.js on the server makes such a link when Telegram itself is out of reach.
 * - A password the user set on their account page (src/account/password.js).
 *
 * Who may sign in: ADMIN_USERS (the whole panel) and ACCOUNT_USERS (their own chats only), Telegram
 * ids separated by commas in .env. Both lists are read on every request: taking an id off signs that
 * user out everywhere. Only hashes of tokens are stored.
 */
const crypto = require('crypto');
const { Op } = require('sequelize');
const { AccountSession, LoginLink } = require('../db');
const { lruCache } = require('../lru');
const { log } = require('../log');

const LINK_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE = 'nfb_session';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-Za-z0-9_-]{32}$/;

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

/** @returns {Set<string>} the Telegram ids in an .env list */
function idsIn(name) {
    return new Set(
        String(process.env[name] || '')
            .split(',')
            .map((id) => id.trim())
            .filter((id) => /^\d{1,20}$/.test(id))
    );
}

/** @returns {'admin' | 'user' | null} */
function roleOf(userId) {
    const id = String(userId);
    if (idsIn('ADMIN_USERS').has(id)) return 'admin';
    if (idsIn('ACCOUNT_USERS').has(id)) return 'user';
    return null;
}

const isAllowed = (userId) => roleOf(userId) !== null;

/** The first admin, for login-link.js run without an id. */
const firstAdmin = () => [...idsIn('ADMIN_USERS')][0] || null;

/** Where the panel is, for the link: PANEL_URL in .env, like http://192.168.2.112 */
const panelUrl = () => String(process.env.PANEL_URL || '').replace(/\/+$/, '');

// --- Sessions ---

async function startSession({ userId, userName = null }, now = Date.now()) {
    const token = newToken();
    await AccountSession.create({
        id: hash(token),
        userId,
        userName,
        expiresAt: new Date(now + SESSION_TTL_MS)
    });
    // Old sessions and links go now and then, not by a timer of their own
    const old = { where: { expiresAt: { [Op.lt]: new Date(now) } } };
    Promise.all([AccountSession.destroy(old), LoginLink.destroy(old)]).catch((err) =>
        log.warn(`[Account] Removing expired sessions failed: ${err.message}`)
    );
    log.info(`[Account] User ${userId} signed in`);
    return token;
}

/** The cookie's value from a Cookie header. */
function cookieToken(header) {
    for (const part of String(header || '').split(';')) {
        const [name, ...rest] = part.trim().split('=');
        if (name === COOKIE) return rest.join('=');
    }
    return null;
}

/** @returns {Promise<{ id: string, userId: string, userName: string | null, role: 'admin' | 'user' } | null>} */
async function sessionOf(req, now = Date.now()) {
    const token = cookieToken(req.headers.cookie);
    if (!TOKEN.test(String(token || ''))) return null;
    const row = await AccountSession.findByPk(hash(token));
    if (!row || new Date(row.expiresAt).getTime() <= now) return null;
    const role = roleOf(row.userId);
    if (!role) return null;
    return { id: row.id, userId: String(row.userId), userName: row.userName, role };
}

const endSession = (session) => AccountSession.destroy({ where: { id: session.id } });

/** Signs the user out everywhere but the session `keepId` (null: everywhere). */
const endOtherSessions = (userId, keepId = null) =>
    AccountSession.destroy({ where: keepId ? { userId, id: { [Op.ne]: keepId } } : { userId } });

/** Over HTTPS (directly, or behind a proxy that says so) the cookie is Secure too. */
const isHttps = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

function setCookie(req, res, token) {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_TTL_MS / 1000}`];
    if (isHttps(req)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

function clearCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// --- One-time links ---

/**
 * A one-time sign-in link, or null when the user isn't allowed in or PANEL_URL is unset.
 * @param {{ id: number | string, name?: string | null }} user
 * @param {number | string | null} chatId the chat /login was sent from, opened first
 */
async function createLink(user, chatId = null, now = Date.now()) {
    if (!isAllowed(user.id) || !panelUrl()) return null;
    const token = newToken();
    await LoginLink.create({
        id: hash(token),
        userId: user.id,
        userName: user.name || null,
        chatId,
        expiresAt: new Date(now + LINK_TTL_MS)
    });
    return `${panelUrl()}/login/${token}`;
}

/**
 * Spends a link's token and starts a session.
 * @returns {Promise<{ token: string, chatId: string | null } | null>} null for a used, expired,
 *   made-up or no longer allowed one
 */
async function redeemLink(token, now = Date.now()) {
    if (!TOKEN.test(String(token || ''))) return null;
    const id = hash(token);
    const link = await LoginLink.findByPk(id);
    if (!link) return null;
    // Whoever removes the row spends it: two presses at once can't both get in
    if (!(await LoginLink.destroy({ where: { id } }))) return null;
    if (new Date(link.expiresAt).getTime() <= now || !isAllowed(link.userId)) return null;
    const session = await startSession({ userId: link.userId, userName: link.userName }, now);
    return { token: session, chatId: link.chatId === null ? null : String(link.chatId) };
}

// --- "Войти через Telegram": a code the bot confirms ---

// Codes waiting for the bot: code → { secret's hash, the user once confirmed, refused }
const codes = lruCache({ max: 2000, ttl: LINK_TTL_MS });

/**
 * Four digits the page and the bot both show for a code: a t.me link someone else started and sent
 * you shows a number that isn't on your screen.
 */
const checkWord = (code) => String(parseInt(hash(`check:${code}`).slice(0, 8), 16) % 10000).padStart(4, '0');

/** A new code for the sign-in page, the secret only that page knows, and the number to compare. */
function startCode() {
    const code = crypto.randomBytes(24).toString('base64url');
    const secret = newToken();
    codes.set(code, { secretHash: hash(secret), user: null, refused: false });
    return { code, secret, check: checkWord(code) };
}

/** Whether a code is still waiting for the bot's question (it may be asked once). */
const isWaiting = (code) => {
    const entry = CODE.test(String(code || '')) ? codes.get(code) : null;
    return Boolean(entry && !entry.user && !entry.refused);
};

/**
 * The user's answer in the bot.
 * @returns {boolean} false: the code is gone (expired, used, answered) or the user isn't allowed
 */
function answerCode(code, user, yes) {
    if (!isWaiting(code) || !isAllowed(user.id)) return false;
    const entry = codes.get(code);
    if (yes) entry.user = { userId: user.id, userName: user.name || null };
    else entry.refused = true;
    return true;
}

/**
 * The sign-in page asking how its code stands; once confirmed, the session starts (once).
 * @returns {Promise<{ state: 'waiting' | 'refused' | 'gone' } | { state: 'in', token: string }>}
 */
async function pollCode(code, secret, now = Date.now()) {
    const entry = CODE.test(String(code || '')) ? codes.get(code) : null;
    if (!entry || !TOKEN.test(String(secret || '')) || hash(secret) !== entry.secretHash) return { state: 'gone' };
    if (entry.refused) {
        codes.delete(code);
        return { state: 'refused' };
    }
    if (!entry.user) return { state: 'waiting' };
    codes.delete(code);
    if (!isAllowed(entry.user.userId)) return { state: 'gone' };
    return { state: 'in', token: await startSession(entry.user, now) };
}

module.exports = {
    COOKIE,
    LINK_TTL_MS,
    SESSION_TTL_MS,
    idsIn,
    roleOf,
    isAllowed,
    firstAdmin,
    panelUrl,
    startSession,
    cookieToken,
    sessionOf,
    endSession,
    endOtherSessions,
    setCookie,
    clearCookie,
    createLink,
    redeemLink,
    startCode,
    checkWord,
    isWaiting,
    answerCode,
    pollCode
};
