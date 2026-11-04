/**
 * Signing in to the panel. Telegram already knows who writes to the bot, so every account is a
 * Telegram one; every way in ends in the same session, an httpOnly cookie:
 *
 * - "Войти через Telegram" on the sign-in page: the page gets a one-time code and opens the bot with
 *   it (t.me/<bot>?start=L<code>). The bot asks the user to confirm, and only then the page that
 *   holds the code's secret is let in. The question stops a planted link: someone who sends you
 *   their code can't get in as you without your "Да, это я".
 * - login-link.js on the server: a one-time link, when Telegram itself is out of reach. The page
 *   behind it asks for a press before it spends the token (a POST): link previews and prefetchers
 *   only GET, so they can't use it up.
 * - The Mini App: Telegram's signed launch data (src/account/miniapp.js).
 * - A password the user set on their account page (src/account/password.js).
 *
 * Who may sign in and as what: src/account/roles.js, read on every request, so a role taken away
 * signs that person out everywhere. Only hashes of tokens are stored.
 */
const crypto = require('crypto');
const { Op, Transaction, UniqueConstraintError } = require('sequelize');
const sequelize = require('../database');
const { AccountSession, LoginLink, MiniAppLaunch, AccountPassword } = require('../db');
const { lruCache } = require('../lru');
const { roleOf, isAllowed, isSystem, systemHash } = require('./roles');
const { log } = require('../log');

const LINK_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// The server enforces inactivity. Bot activity cannot update a closed browser's cookie.
const COOKIE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const COOKIE = 'nfb_session';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-Za-z0-9_-]{32}$/;

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
// A new namespace rejects tokens that could have been exposed on the old HTTP panel.
const tokenId = (kind, token, credential = '') => hash(`https:${kind}:${token}:${credential}`);

async function tokenRow(model, kind, token, credential) {
    const row = await model.findByPk(tokenId(kind, token));
    if (row && !isSystem(row.userId)) return row;
    if (!credential) return null;
    const systemRow = await model.findByPk(tokenId(kind, token, credential));
    return systemRow && isSystem(systemRow.userId) ? systemRow : null;
}

/** The HTTPS origin used in one-time links. */
function panelUrl() {
    try {
        const url = new URL(process.env.PANEL_URL || '');
        if (url.protocol === 'https:' && !url.username && !url.password && url.href === `${url.origin}/`)
            return url.origin;
    } catch {
        // No usable panel origin configured
    }
    return '';
}

// --- Sessions ---

async function startSession({ userId, userName = null }, now = Date.now(), credential = systemHash()) {
    const token = newToken();
    const system = isSystem(userId);
    if (system && !credential) return null;
    const id = tokenId('session', token, system ? credential : '');
    await insertSession(id, userId, userName, now);
    if (system && credential !== systemHash()) {
        await endSession({ id });
        return null;
    }
    signedIn(userId, now);
    return token;
}

const insertSession = (id, userId, userName, now, transaction) =>
    AccountSession.create({ id, userId, userName, expiresAt: new Date(now + SESSION_TTL_MS) }, { transaction });

async function redeemMiniAppLaunch(user, existing, now = Date.now()) {
    if (user.expiresAt.getTime() <= now) return null;
    const id = tokenId('miniapp', user.launchId);
    const token = existing ? null : newToken();
    try {
        await sequelize.transaction(async (transaction) => {
            await MiniAppLaunch.create({ id, expiresAt: user.expiresAt }, { transaction });
            if (token) await insertSession(tokenId('session', token), user.userId, user.userName, now, transaction);
        });
    } catch (err) {
        if (!(err instanceof UniqueConstraintError)) throw err;
        return existing ? { token: null } : null;
    }
    MiniAppLaunch.destroy({ where: { expiresAt: { [Op.lt]: new Date(now - LINK_TTL_MS) } } }).catch((err) =>
        log.warn(`[Account] Removing expired Mini App launches failed: ${err.message}`)
    );
    if (token) signedIn(user.userId, now);
    return { token };
}

function signedIn(userId, now) {
    // Old sessions and links go now and then, not by a timer of their own
    const old = { where: { expiresAt: { [Op.lt]: new Date(now) } } };
    Promise.all([AccountSession.destroy(old), LoginLink.destroy(old)]).catch((err) =>
        log.warn(`[Account] Removing expired sessions failed: ${err.message}`)
    );
    log.info(`[Account] User ${userId} signed in`);
}

/** The cookie's value from a Cookie header. */
function cookieToken(header) {
    for (const part of String(header || '').split(';')) {
        const [name, ...rest] = part.trim().split('=');
        if (name === COOKIE) return rest.join('=');
    }
    return null;
}

/**
 * @returns {Promise<{ id: string, userId: string, userName: string | null, role: 'admin' | 'user',
 *   system: boolean } | null>} system: the system account, not a Telegram user
 */
async function sessionOf(req, now = Date.now()) {
    const token = cookieToken(req.headers.cookie);
    if (!TOKEN.test(String(token || ''))) return null;
    const credential = systemHash();
    const row = await tokenRow(AccountSession, 'session', token, credential);
    if (!row || new Date(row.expiresAt).getTime() <= now) return null;
    const role = await roleOf(row.userId);
    if (!role || (isSystem(row.userId) && credential !== systemHash())) return null;
    return { id: row.id, userId: String(row.userId), userName: row.userName, role, system: isSystem(row.userId) };
}

const endSession = (session) => AccountSession.destroy({ where: { id: session.id } });

/** Signs the user out everywhere but the session `keepId` (null: everywhere). */
async function endOtherSessions(userId, keepId = null) {
    invalidateCodes(userId);
    await LoginLink.destroy({ where: { userId } });
    return AccountSession.destroy({ where: keepId ? { userId, id: { [Op.ne]: keepId } } : { userId } });
}

/** Only existing, unexpired sessions may be renewed. A concurrent revocation cannot recreate one. */
const touchSessions = (where, now = Date.now()) =>
    AccountSession.update(
        { expiresAt: new Date(now + SESSION_TTL_MS) },
        { where: { ...where, expiresAt: { [Op.gt]: new Date(now), [Op.lt]: new Date(now + SESSION_TTL_MS) } } }
    );

/** Cap legacy 30-day sessions once at startup; never extend a shorter deadline. */
const capSessionLifetimes = (now = Date.now()) =>
    AccountSession.update(
        { expiresAt: new Date(now + SESSION_TTL_MS) },
        { where: { expiresAt: { [Op.gt]: new Date(now + SESSION_TTL_MS) } } }
    );

function setCookie(req, res, token) {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${COOKIE_TTL_MS / 1000}`];
    if (req.secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

function clearCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// --- One-time links ---

/**
 * A one-time sign-in link, or null when the user isn't allowed in or PANEL_URL is unset.
 * @param {{ id: number | string, name?: string | null }} user
 * @param {number | string | null} chatId a chat to open first (none from login-link.js)
 */
async function createLink(user, chatId = null, now = Date.now()) {
    const origin = panelUrl();
    if (!origin) return null;
    const token = newToken();
    const credential = isSystem(user.id) ? systemHash() : '';
    return sequelize.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
        async (transaction) => {
            // Hold the role row until the link exists so role removal can revoke it.
            if (!(await isAllowed(user.id, { transaction, lock: transaction.LOCK.UPDATE }))) return null;
            await LoginLink.create(
                {
                    id: tokenId('link', token, credential),
                    userId: user.id,
                    userName: user.name || null,
                    chatId,
                    expiresAt: new Date(now + LINK_TTL_MS)
                },
                { transaction }
            );
            return `${origin}/login/${token}`;
        }
    );
}

/**
 * Spends a link's token and starts a session.
 * @returns {Promise<{ token: string, chatId: string | null } | null>} null for a used, expired,
 *   made-up or no longer allowed one
 */
async function redeemLink(token, now = Date.now()) {
    if (!TOKEN.test(String(token || ''))) return null;
    const credential = systemHash();
    const candidate = await tokenRow(LoginLink, 'link', token, credential);
    if (!candidate) return null;
    const session = await sequelize.transaction(async (transaction) => {
        const id = candidate.id;
        const link = await LoginLink.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!link || new Date(link.expiresAt).getTime() <= now || !(await isAllowed(link.userId, { transaction })))
            return null;
        const system = isSystem(link.userId);
        if (system && credential !== systemHash()) return null;
        if (!(await LoginLink.destroy({ where: { id }, transaction }))) return null;
        const sessionToken = newToken();
        const sessionId = tokenId('session', sessionToken, system ? credential : '');
        await insertSession(sessionId, link.userId, link.userName, now, transaction);
        return { token: sessionToken, chatId: link.chatId === null ? null : String(link.chatId) };
    });
    if (session) signedIn(candidate.userId, now);
    return session;
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
function startCode(boundUser = null, passwordHash = null, now = Date.now()) {
    const code = crypto.randomBytes(24).toString('base64url');
    const secret = newToken();
    const expiresAt = now + LINK_TTL_MS;
    codes.set(code, { secretHash: hash(secret), boundUser, passwordHash, user: null, refused: false, expiresAt });
    return { code, secret, check: checkWord(code), expiresAt };
}

const codeOf = (code, now = Date.now()) => {
    const entry = CODE.test(String(code || '')) ? codes.get(code) : null;
    return entry && entry.expiresAt > now ? entry : null;
};

function invalidateCodes(userId) {
    for (const [code, entry] of codes) {
        if (String((entry.boundUser || entry.user)?.userId) === String(userId)) codes.delete(code);
    }
}

function cancelCode(code, secret) {
    const entry = codeOf(code);
    if (!entry || !TOKEN.test(String(secret || '')) || hash(secret) !== entry.secretHash) return false;
    return codes.delete(code);
}

/** Whether a code is still waiting for the bot's question (it may be asked once). */
const isWaiting = (code) => {
    const entry = codeOf(code);
    return Boolean(entry && !entry.user && !entry.refused && !entry.redeeming);
};

/**
 * The user's answer in the bot.
 * @returns {Promise<boolean>} false: the code is gone (expired, used, answered) or the user isn't allowed
 */
async function answerCode(code, user, yes) {
    if (!isWaiting(code) || !(await isAllowed(user.id)) || !isWaiting(code)) return false;
    const entry = codes.get(code);
    if (entry.boundUser && String(entry.boundUser.userId) !== String(user.id)) return false;
    if (yes) entry.user = { userId: user.id, userName: user.name || null };
    else entry.refused = true;
    return true;
}

/**
 * The sign-in page asking how its code stands; once confirmed, the session starts (once).
 * @returns {Promise<{ state: 'waiting' | 'refused' | 'gone' } | { state: 'in', token: string }>}
 */
async function pollCode(code, secret, now = Date.now()) {
    const entry = codeOf(code, now);
    if (!entry || entry.redeeming || !TOKEN.test(String(secret || '')) || hash(secret) !== entry.secretHash)
        return { state: 'gone' };
    if (entry.refused) {
        codes.delete(code);
        return { state: 'refused' };
    }
    if (!entry.user) return { state: 'waiting' };
    entry.redeeming = true;
    try {
        if (!(await isAllowed(entry.user.userId))) return { state: 'gone' };
        if (entry.passwordHash) {
            const current = await AccountPassword.findByPk(entry.user.userId);
            if (!current || current.hash !== entry.passwordHash) return { state: 'gone' };
        }
        if (codeOf(code) !== entry) return { state: 'gone' };
        const token = await startSession(entry.user, now);
        if (codeOf(code) !== entry) {
            await endSession({ id: tokenId('session', token) });
            return { state: 'gone' };
        }
        return { state: 'in', token };
    } finally {
        codes.delete(code);
    }
}

module.exports = {
    COOKIE,
    LINK_TTL_MS,
    SESSION_TTL_MS,
    COOKIE_TTL_MS,
    roleOf,
    isAllowed,
    panelUrl,
    startSession,
    redeemMiniAppLaunch,
    cookieToken,
    sessionOf,
    endSession,
    endOtherSessions,
    touchSessions,
    capSessionLifetimes,
    setCookie,
    clearCookie,
    createLink,
    redeemLink,
    startCode,
    invalidateCodes,
    cancelCode,
    checkWord,
    isWaiting,
    answerCode,
    pollCode
};
