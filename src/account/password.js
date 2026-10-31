/**
 * Signing in with a password: a way in when Telegram isn't answering. A user sets it on their
 * account page after signing in with Telegram, so the password is always tied to a Telegram id and
 * its role (src/account/roles.js). They sign in with that id or their @username (the private chat
 * with the bot knows it). The system account signs in here too, with its login and the hash in
 * .env (roles.js).
 *
 * Hashes are Node's scrypt (no dependency), salted per password. Guessing is slowed by the rate
 * limits on the route (src/account/routes.js).
 */
const crypto = require('crypto');
const { promisify } = require('util');
const { AccountPassword, Chat } = require('../db');
const { startSession } = require('./auth');
const roles = require('./roles');
const { deliver } = require('../delivery');
const { z } = require('../admin/validate');
const { log } = require('../log');

const scrypt = promisify(crypto.scrypt);

const MIN_LENGTH = 8;
const MAX_LENGTH = 128;
// N = 2^14: 16 MB and ~50 ms per hash on the server
const COST = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;

/** A new password, for the routes that set one */
const PASSWORD = z
    .string({ error: 'Enter a password' })
    .min(MIN_LENGTH, { error: `At least ${MIN_LENGTH} characters` })
    .max(MAX_LENGTH, { error: `At most ${MAX_LENGTH} characters` });

/**
 * @returns {Promise<string>} `scrypt:N:r:p:salt:key`, base64url parts; no "$", which Docker
 *   Compose would read as a variable in .env
 */
async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, KEY_LENGTH, COST);
    return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

async function matches(password, stored) {
    // "$" between the parts in the first hashes (31.10)
    const [kind, N, r, p, salt, key] = String(stored || '').split(/[:$]/);
    if (kind !== 'scrypt' || !salt || !key) return false;
    const expected = Buffer.from(key, 'base64url');
    const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
        N: Number(N),
        r: Number(r),
        p: Number(p)
    });
    return crypto.timingSafeEqual(actual, expected);
}

// Compared against when there is no such user, so a wrong name takes as long as a wrong password
let dummy = null;
const dummyHash = async () => (dummy ||= await hashPassword(crypto.randomBytes(16).toString('hex')));

/** The login as typed, for the rate limit: "@Name", "name" and " name " are one key. */
const loginKey = (login) =>
    String(login || '')
        .trim()
        .replace(/^@/, '')
        .toLowerCase();

/**
 * The user id behind a login: the system account's login (id 0), a Telegram id, or the @username
 * of a private chat with the bot.
 * @returns {Promise<string | null>}
 */
async function userIdFor(login) {
    const key = loginKey(login);
    if (key && key === roles.systemLogin().toLowerCase()) return roles.SYSTEM_ID;
    if (/^[1-9]\d{0,19}$/.test(key)) return key;
    if (!/^[a-z0-9_]{4,32}$/.test(key)) return null;
    // Private chats keep "@username" (or a plain name when there is none: never matched here);
    // the column's collation ignores case
    const chats = await Chat.findAll({
        where: { type: 'private', username: `@${key}` },
        attributes: ['id'],
        limit: 2,
        raw: true
    });
    return chats.length === 1 ? String(chats[0].id) : null;
}

/**
 * @returns {Promise<{ token: string } | null>} a session, or null for a wrong login or password and
 *   for someone no longer on the lists
 */
async function signInWithPassword(login, password, now = Date.now()) {
    const userId = await userIdFor(login);
    const system = userId !== null && roles.isSystem(userId);
    let hash = null;
    if (system) hash = roles.systemHash() || null;
    else if (userId && (await roles.isAllowed(userId))) {
        const row = await AccountPassword.findByPk(userId);
        hash = row ? row.hash : null;
    }
    if (!hash) {
        await matches(password, await dummyHash());
        return null;
    }
    if (!(await matches(password, hash))) {
        log.warn(`[Account] Wrong password for ${system ? 'the system account' : `user ${userId}`}`);
        return null;
    }
    if (system) return { token: await startSession({ userId, userName: roles.systemLogin() }, now) };
    const chat = await Chat.findByPk(userId, { attributes: ['username'], raw: true });
    return { token: await startSession({ userId, userName: chat ? chat.username : null }, now) };
}

async function setPassword(userId, password) {
    await AccountPassword.upsert({ userId, hash: await hashPassword(password) });
    log.info(`[Account] User ${userId} set a password`);
}

async function removePassword(userId) {
    const removed = await AccountPassword.destroy({ where: { userId } });
    if (removed) log.info(`[Account] Password of user ${userId} removed`);
    return removed > 0;
}

const IF_NOT_YOU =
    'Если это были не вы, войдите в панель через Telegram и удалите пароль в My account → Settings: остальные устройства выйдут из панели.';
const NOTICES = {
    set: `🔑 Для входа в панель задан пароль.\n\n${IF_NOT_YOU}`,
    changed: `🔑 Пароль для входа в панель изменён, остальные устройства вышли из панели.\n\n${IF_NOT_YOU}`,
    removed: '🔑 Пароль для входа в панель удалён, остальные устройства вышли из панели.',
    'removed-by-admin': '🔑 Администратор панели удалил ваш пароль и завершил ваши сессии. Входите через Telegram.'
};

/**
 * Tells the user in their private chat that their password changed: a session someone else got
 * hold of can't quietly turn into a password of their own. Not waited for; a failure is logged.
 * @param {keyof NOTICES} kind
 */
function notifyPassword(bot, userId, kind) {
    if (!bot || roles.isSystem(userId)) return;
    deliver(bot, userId, NOTICES[kind]).catch((err) =>
        log.warn(`[Account] Password notice to ${userId} failed: ${err.message}`)
    );
}

const hasPassword = async (userId) => Boolean(await AccountPassword.findByPk(userId, { attributes: ['userId'] }));

/** @returns {Promise<Set<string>>} the ids that have a password, for the access list */
async function withPasswords() {
    const rows = await AccountPassword.findAll({ attributes: ['userId'], raw: true });
    return new Set(rows.map((r) => String(r.userId)));
}

module.exports = {
    MIN_LENGTH,
    MAX_LENGTH,
    PASSWORD,
    hashPassword,
    matches,
    loginKey,
    userIdFor,
    signInWithPassword,
    setPassword,
    removePassword,
    hasPassword,
    withPasswords,
    notifyPassword
};
