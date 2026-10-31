/**
 * Who may use the panel and as what.
 *
 * - The system account: login SYSTEM_LOGIN (default "admin") and the hash SYSTEM_PASSWORD_HASH in
 *   .env, not tied to Telegram; always an admin, the way back in when every other is lost. Its
 *   sessions carry the user id 0.
 * - Telegram users: a role an admin set (PanelRole: admin, user, or none for no access), else, while
 *   OPEN_SIGNUP=true, everyone the bot knows as a person (a "private" Chat row: made for anyone who
 *   wrote to it, also in a group) is a user. Signing in still goes through the bot's private chat.
 *
 * Read on every request: a role taken away signs that person out everywhere at once.
 */
const { Op } = require('sequelize');
const { PanelRole, Chat } = require('../db');
const { log } = require('../log');

const SYSTEM_ID = '0';
const ROLES = ['admin', 'user', 'none'];

const systemLogin = () => String(process.env.SYSTEM_LOGIN || 'admin').trim();
const systemHash = () => String(process.env.SYSTEM_PASSWORD_HASH || '');
const isSystem = (userId) => String(userId) === SYSTEM_ID;
const openSignup = () => process.env.OPEN_SIGNUP === 'true';

/** @returns {Promise<'admin' | 'user' | null>} */
async function roleOf(userId) {
    const id = String(userId);
    if (isSystem(id)) return systemHash() ? 'admin' : null;
    if (!/^[1-9]\d{0,19}$/.test(id)) return null;
    const row = await PanelRole.findByPk(id, { attributes: ['role'], raw: true });
    if (row) return row.role === 'none' ? null : row.role;
    if (!openSignup()) return null;
    const chat = await Chat.findOne({ where: { id, type: 'private' }, attributes: ['id'], raw: true });
    return chat ? 'user' : null;
}

const isAllowed = async (userId) => (await roleOf(userId)) !== null;

/**
 * The roles of private chats, for the Users list.
 * @returns {Promise<Map<string, 'admin' | 'user' | 'none' | null>>} 'none': taken away by an admin;
 *   null: no role while sign-up is closed
 */
async function rolesOf(ids) {
    const rows = ids.length
        ? await PanelRole.findAll({ where: { userId: { [Op.in]: ids } }, attributes: ['userId', 'role'], raw: true })
        : [];
    const set = new Map(rows.map((r) => [String(r.userId), r.role]));
    const fallback = openSignup() ? 'user' : null;
    return new Map(ids.map((id) => [String(id), set.get(String(id)) || fallback]));
}

/** @param {'admin' | 'user' | 'none'} role */
async function setRole(userId, role) {
    if (!ROLES.includes(role)) throw new Error(`Bad role ${role}`);
    await PanelRole.upsert({ userId: String(userId), role });
}

/** The first admin by id, for login-link.js without one. */
async function firstAdmin() {
    const row = await PanelRole.findOne({ where: { role: 'admin' }, order: [['userId', 'ASC']], raw: true });
    return row ? String(row.userId) : null;
}

/**
 * Once: the roles from before they lived in the database (ADMIN_USERS and ACCOUNT_USERS in .env,
 * Telegram ids separated by commas) go into it while it has none. The keys are not read after.
 */
async function importFromEnv() {
    const ids = (name) =>
        String(process.env[name] || '')
            .split(',')
            .map((id) => id.trim())
            .filter((id) => /^[1-9]\d{0,19}$/.test(id));
    const admins = ids('ADMIN_USERS');
    const users = ids('ACCOUNT_USERS').filter((id) => !admins.includes(id));
    if (!admins.length && !users.length) return 0;
    if (await PanelRole.count()) return 0;
    await PanelRole.bulkCreate([
        ...admins.map((userId) => ({ userId, role: 'admin' })),
        ...users.map((userId) => ({ userId, role: 'user' }))
    ]);
    log.info(
        `[Account] Roles moved from .env into the database: ${admins.length} admin(s), ${users.length} user(s). ` +
            'ADMIN_USERS and ACCOUNT_USERS are no longer read'
    );
    return admins.length + users.length;
}

module.exports = {
    SYSTEM_ID,
    ROLES,
    systemLogin,
    systemHash,
    isSystem,
    openSignup,
    roleOf,
    isAllowed,
    rolesOf,
    setRole,
    firstAdmin,
    importFromEnv
};
