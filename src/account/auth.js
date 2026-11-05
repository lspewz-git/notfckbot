/**
 * Signing in to the panel. Telegram already knows who writes to the bot, so every account is a
 * Telegram one; every way in ends in the same session, an httpOnly cookie:
 *
 * - "Войти через Telegram" on the sign-in page: the page gets a one-time code and opens the bot with
 *   it (t.me/<bot>?start=L<code>). The bot asks the user to confirm, and only then the page that
 *   holds the code's secret is let in. The question stops a planted link: someone who sends you
 *   their code can't get in as you without your "Да, это я". Without Telegram on that device, the
 *   six digits on the page sent to the bot from another one (/code) sign it in directly.
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
const devices = require('./devices');
const { cookieValue } = require('./cookies');
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

async function startSession(
    { userId, userName = null },
    now = Date.now(),
    credential = systemHash(),
    { trusted = true } = {}
) {
    const token = newToken();
    const system = isSystem(userId);
    if (system && !credential) return null;
    const id = tokenId('session', token, system ? credential : '');
    await insertSession(id, userId, userName, now, undefined, trusted);
    if (system && credential !== systemHash()) {
        await endSession({ id });
        return null;
    }
    signedIn(userId, now);
    return token;
}

const insertSession = (id, userId, userName, now, transaction, trusted = true, name = null) =>
    AccountSession.create(
        { id, userId, userName, trusted, name, expiresAt: new Date(now + SESSION_TTL_MS) },
        { transaction }
    );

/** name: what the Devices list calls the Mini App ("Telegram, iPhone"), from devices.telegramName(). */
async function redeemMiniAppLaunch(user, existing, now = Date.now(), name = null) {
    if (user.expiresAt.getTime() <= now) return null;
    const id = tokenId('miniapp', user.launchId);
    const token = existing ? null : newToken();
    try {
        await sequelize.transaction(async (transaction) => {
            await MiniAppLaunch.create({ id, expiresAt: user.expiresAt }, { transaction });
            if (token)
                await insertSession(
                    tokenId('session', token),
                    user.userId,
                    user.userName,
                    now,
                    transaction,
                    true,
                    name
                );
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
const cookieToken = (header) => cookieValue(header, COOKIE);

/**
 * @returns {Promise<{ id: string, userId: string, userName: string | null, role: 'admin' | 'user',
 *   system: boolean, since: Date }  | null>} system: the system account, not a Telegram user; since: when it started
 */
async function sessionOf(req, now = Date.now()) {
    const token = cookieToken(req.headers.cookie);
    if (!TOKEN.test(String(token || ''))) return null;
    const credential = systemHash();
    const row = await tokenRow(AccountSession, 'session', token, credential);
    if (!row || new Date(row.expiresAt).getTime() <= now) return null;
    const role = await roleOf(row.userId);
    if (!role || (isSystem(row.userId) && credential !== systemHash())) return null;
    return {
        id: row.id,
        userId: String(row.userId),
        userName: row.userName,
        role,
        system: isSystem(row.userId),
        since: row.createdAt,
        trusted: row.trusted !== false,
        name: row.name || null,
        seenAt: row.seenAt || null
    };
}

// --- The Devices list ---

// How often a signed-in browser's place and time are written: not on every request
const NOTE_EVERY_MS = 5 * 60 * 1000;
// Sessions noted lately: a page's parallel requests all read the old seenAt, only the first writes
const noted = lruCache({ max: 5000, ttl: NOTE_EVERY_MS });

/**
 * The guard's note of a signed-in browser for the Devices list: its name once (a session started
 * before the list existed, or by a page that didn't name it), its latest country and network, and when.
 */
async function noteSession(req, session, now = Date.now()) {
    const seenAt = session.seenAt ? new Date(session.seenAt).getTime() : 0;
    if ((seenAt <= now && now - seenAt < NOTE_EVERY_MS) || noted.has(session.id)) return;
    noted.set(session.id, true);
    const place = devices.placeOf(devices.ipOf(req));
    const name = session.name || devices.deviceName(req.get('user-agent'));
    await AccountSession.update({ name, ...place, seenAt: new Date(now) }, { where: { id: session.id } });
}

// What the page gets instead of a session's id: the id is a hash of the cookie, but still the table's key
const publicId = (id) => hash(`device-list:${id}`).slice(0, 24);

/**
 * The user's signed-in browsers, this one first, then the latest seen.
 * @returns {Promise<Array<{ id: string, name: string | null, country: string | null,
 *   network: string | null, seenAt: Date, current: boolean }>>}
 */
async function listSessions(session, now = Date.now()) {
    const rows = await AccountSession.findAll({
        where: { userId: session.userId, expiresAt: { [Op.gt]: new Date(now) } },
        raw: true
    });
    return rows
        .map((row) => ({
            id: publicId(row.id),
            name: row.name || null,
            country: row.country || null,
            network: row.network || null,
            seenAt: new Date(row.seenAt || row.createdAt || now),
            current: row.id === session.id
        }))
        .sort((a, b) => Number(b.current) - Number(a.current) || b.seenAt.getTime() - a.seenAt.getTime());
}

/**
 * Signs out one of the user's other browsers by its id in the list.
 * @returns {Promise<'ended' | 'current' | 'missing'>}
 */
async function endListedSession(session, listedId) {
    const rows = await AccountSession.findAll({ where: { userId: session.userId }, attributes: ['id'], raw: true });
    const row = rows.find((r) => publicId(r.id) === listedId);
    if (!row) return 'missing';
    if (row.id === session.id) return 'current';
    return (await AccountSession.destroy({ where: { id: row.id } })) ? 'ended' : 'missing';
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

/** The session cookie, keeping any other cookie already set on the response (the device mark). */
function putCookie(res, value) {
    const others = [].concat(res.getHeader?.('Set-Cookie') || []).filter((c) => !c.startsWith(`${COOKIE}=`));
    res.setHeader('Set-Cookie', others.length ? [...others, value] : value);
}

function setCookie(req, res, token) {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${COOKIE_TTL_MS / 1000}`];
    if (req.secure) parts.push('Secure');
    putCookie(res, parts.join('; '));
}

function clearCookie(res) {
    putCookie(res, `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
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

const codeOf = (code, now = Date.now()) => {
    const entry = CODE.test(String(code || '')) ? codes.get(code) : null;
    return entry && entry.expiresAt > now ? entry : null;
};

/**
 * Six digits the page and the bot both show for a code: a t.me link someone else started and sent
 * you shows a number that isn't on your screen. Sent to the bot (/code), they sign that page in, so no
 * two live codes share them, and digits just given out aren't given out again for a while: someone who
 * sends the digits of a page they closed doesn't sign a stranger's page in.
 */
const checkWord = (code) => codeOf(code)?.check ?? '';

const CHECK_SPACE = 1000000;
// Every number given out, kept past its code's life (5 min) for as long again
const recentChecks = lruCache({ max: 20000, ttl: 2 * LINK_TTL_MS });

// At most 2000 live codes and 20000 recent numbers among a million: a free one is always found
function newCheck(now) {
    // Live codes too: the recent list may have dropped one under a flood of sign-ins
    const live = new Set();
    for (const entry of codes.values()) if (entry.expiresAt > now) live.add(entry.check);
    for (;;) {
        const check = String(crypto.randomInt(CHECK_SPACE)).padStart(6, '0');
        if (!recentChecks.has(check) && !live.has(check)) {
            recentChecks.set(check, true);
            return check;
        }
    }
}

/**
 * A new code for the sign-in page, the secret only that page knows, and the number to compare.
 * @param {ReturnType<typeof devices.clientOf> | null} [device] the browser that asked (devices.clientOf), for
 *   the bot's question and its reply to /code
 */
function startCode(boundUser = null, passwordHash = null, now = Date.now(), device = null) {
    const check = newCheck(now);
    const code = crypto.randomBytes(24).toString('base64url');
    const secret = newToken();
    const expiresAt = now + LINK_TTL_MS;
    codes.set(code, {
        secretHash: hash(secret),
        boundUser,
        passwordHash,
        user: null,
        refused: false,
        expiresAt,
        check,
        device
    });
    return { code, secret, check, expiresAt };
}

// Wrong /code digits per Telegram user, like an iPhone's passcode: after CODE_TRIES misses the bot
// pauses 1 minute, after the next miss 5, then 15 for every further one. Kept an hour after the last
// miss; a right code starts over.
const CODE_TRIES = 5;
const CODE_PAUSES_MIN = [1, 5, 15];
const codeMisses = lruCache({ max: 5000, ttl: 60 * 60 * 1000 });

// Who signed a page in with digits: "🚫 Это не я" in the bot's reply ends that sign-in. Kept as long as
// the reply is likely to be pressed
const claims = lruCache({ max: 5000, ttl: 24 * 60 * 60 * 1000 });

/** Minutes until the pause ends, or 0 when there is none. */
const pausedFor = (misses, now) => (misses?.until > now ? Math.ceil((misses.until - now) / 60000) : 0);

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

/** The live code whose page shows these digits. */
function waitingWith(check, now) {
    for (const entry of codes.values()) if (entry.check === check && entry.expiresAt > now) return entry;
    return null;
}

/** The browser that asked for a code, while it waits (for the bot's question). */
const deviceOf = (code) => codeOf(code)?.device || null;

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
 * The six digits from the sign-in page, sent to the bot (/code): they sign that page in as the sender,
 * without the "Да, это я" question (the user's choice, 04.11); the reply offers "Это не я" afterwards
 * (denyClaim). A sign-in bound to another account (a password) doesn't take them, and wrong digits
 * count towards a pause.
 * @returns {Promise<{ state: 'in', device: object | null, seen: 'known' | 'new' | 'odd', claim: string } |
 *   { state: 'wrong', left: number } |
 *   { state: 'paused', minutes: number } | { state: 'closed' }>}
 */
async function answerCheck(digits, user, now = Date.now()) {
    const key = String(user.id);
    let paused = pausedFor(codeMisses.get(key), now);
    if (paused) return { state: 'paused', minutes: paused };
    const wanted = String(digits || '');
    // Whether the browser is new to this user, asked alongside the access: once the digits are taken
    // below, the page signs in and remembers the browser, so asking later would always say 'known'
    const candidate = /^\d{6}$/.test(wanted) ? waitingWith(wanted, now) : null;
    const [allowed, seen] = await Promise.all([
        isAllowed(user.id),
        candidate ? devices.judge(user.id, candidate.device).catch(() => 'new') : 'new'
    ]);
    if (!allowed) return { state: 'closed' };
    // Read after the await: from here to the count below nothing waits, so tries sent at once each
    // see the misses of the ones before them and can't get past the limit together
    const misses = codeMisses.get(key) || { count: 0, until: 0 };
    paused = pausedFor(misses, now);
    if (paused) return { state: 'paused', minutes: paused };
    let found = null;
    if (/^\d{6}$/.test(wanted)) {
        for (const [code, entry] of codes.entries()) {
            if (entry.check === wanted && entry.expiresAt > now) {
                found = code;
                break;
            }
        }
    }
    const entry = found && codes.get(found);
    // The same digits sent again (twice, or as /code and as text): already in, not a miss
    if (entry && entry.claim && !entry.denied && String(entry.user?.userId) === key) return { state: 'again' };
    // ...also once the page has signed in and its code is gone
    for (const claim of claims.values()) {
        if (claim.check === wanted && claim.userId === key && claim.at > now - LINK_TTL_MS) return { state: 'again' };
    }
    const own = entry && (!entry.boundUser || String(entry.boundUser.userId) === String(user.id));
    if (own && isWaiting(found)) {
        const claim = crypto.randomBytes(16).toString('base64url');
        entry.user = { userId: user.id, userName: user.name || null };
        entry.claim = claim;
        const device = entry.device || null;
        claims.set(claim, { code: found, userId: key, sessionId: null, check: wanted, at: now, device });
        codeMisses.delete(key);
        // Judged for another code with the same digits (it ended during the await): ask as for a new one
        return { state: 'in', device, seen: entry === candidate ? seen : 'new', claim };
    }
    const count = misses.count + 1;
    if (count < CODE_TRIES) {
        codeMisses.set(key, { count, until: 0 });
        return { state: 'wrong', left: CODE_TRIES - count };
    }
    const minutes = CODE_PAUSES_MIN[Math.min(count - CODE_TRIES, CODE_PAUSES_MIN.length - 1)];
    codeMisses.set(key, { count, until: now + minutes * 60000 });
    return { state: 'paused', minutes };
}

/**
 * "🚫 Это не я" under the bot's "Вход выполнен": the sign-in those digits made ends, whether the page
 * already has its session (it is ended) or not yet (the page is told it was cancelled).
 * @returns {Promise<boolean>} false: not this person's sign-in, or nothing left to end
 */
async function denyClaim(claimId, userId) {
    const claim = claims.get(String(claimId || ''));
    if (!claim || claim.userId !== String(userId)) return false;
    claims.delete(claimId);
    const entry = codes.get(claim.code);
    if (entry && entry.claim === claimId && !claim.sessionId) {
        // Not in yet: the page's next poll says it was cancelled, and a poll already creating the
        // session ends it (pollCode checks the claim after startSession)
        entry.refused = true;
        entry.user = null;
        entry.denied = true;
    }
    if (claim.sessionId) await endSession({ id: claim.sessionId });
    await devices.forget(userId, claim.device?.deviceId);
    log.info(`[Account] Code sign-in denied by ${userId}`);
    return true;
}

/**
 * The sign-in page asking how its code stands; once confirmed, the session starts (once).
 * @returns {Promise<{ state: 'waiting' | 'refused' | 'gone' } | { state: 'in', token: string, userId: string }>}
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
    // Taken now: "Это не я" (denyClaim) may clear entry.user while this waits below
    const { user } = entry;
    try {
        if (!(await isAllowed(user.userId))) return { state: 'gone' };
        if (entry.passwordHash) {
            const current = await AccountPassword.findByPk(user.userId);
            if (!current || current.hash !== entry.passwordHash) return { state: 'gone' };
        }
        if (entry.denied) return { state: 'refused' };
        if (codeOf(code) !== entry) return { state: 'gone' };
        // Signed in by digits: the session and its browsers stay untrusted (devices.judge); a sign-in
        // confirmed in Telegram trusts them
        const token = await startSession(user, now, undefined, { trusted: !entry.claim });
        if (codeOf(code) !== entry || entry.denied) {
            await endSession({ id: tokenId('session', token) });
            return { state: entry.denied ? 'refused' : 'gone' };
        }
        // Signed in with digits: "Это не я" in the bot can still end this session
        const claim = entry.claim && claims.get(entry.claim);
        if (claim) claim.sessionId = tokenId('session', token);
        return { state: 'in', token, userId: user.userId, trusted: !entry.claim };
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
    noteSession,
    listSessions,
    endListedSession,
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
    deviceOf,
    answerCode,
    answerCheck,
    denyClaim,
    pollCode
};
