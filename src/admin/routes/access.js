/**
 * Panel access (Settings → Bot): who may sign in and with which role. The lists are ADMIN_USERS
 * and ACCOUNT_USERS in .env; a change is written there and into process.env at once, and the
 * guard reads them on every request, so it applies without a restart. An admin can't change their
 * own role: that is how the last admin stays one.
 */
const { Chat, AccountSession } = require('../../db');
const { idsIn, roleOf, endOtherSessions } = require('../../account/auth');
const { withPasswords, removePassword, notifyPassword } = require('../../account/password');
const { writeEnv } = require('../env');
const { z, valid, idOf } = require('../validate');
const { log } = require('../../log');

const router = require('express').Router();

const LISTS = { admin: 'ADMIN_USERS', user: 'ACCOUNT_USERS' };

/** A person: their id, their role and the name of their private chat with the bot, if any. */
const personOf = (id, chat) => ({ id, role: roleOf(id), name: chat ? chat.username || null : null });

/** Everyone with a role, and the private chats that could get one. */
async function currentAccess(selfId) {
    const ids = [...new Set([...idsIn('ADMIN_USERS'), ...idsIn('ACCOUNT_USERS')])];
    const [chats, passwords] = await Promise.all([
        Chat.findAll({ where: { type: 'private' }, attributes: ['id', 'username'], raw: true }),
        withPasswords()
    ]);
    const byId = new Map(chats.map((c) => [String(c.id), c]));
    const people = ids
        .map((id) => ({ ...personOf(id, byId.get(id)), you: id === String(selfId), password: passwords.has(id) }))
        // Admins first, then by name
        .sort((a, b) =>
            a.role === b.role
                ? String(a.name || a.id).localeCompare(String(b.name || b.id))
                : a.role === 'admin'
                  ? -1
                  : 1
        );
    const candidates = chats
        .filter((c) => !roleOf(c.id))
        .map((c) => ({ id: String(c.id), name: c.username || null }))
        .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    return { people, candidates };
}

router.get('/api/access', async (req, res) => {
    try {
        res.json(await currentAccess(req.user.userId));
    } catch (err) {
        log.error(`[Access] Reading failed: ${err.message}`);
        res.status(500).json({ error: "Couldn't read the access list" });
    }
});

const ACCESS = z.object({
    // No leading zeros: "007" would be an entry that never matches the 7 Telegram sends
    userId: idOf(/^[1-9]\d{0,19}$/, 'Bad user id'),
    role: z.enum(['admin', 'user', 'none'], { error: 'Pick admin, user or none' })
});

/** Body: { userId, role: 'admin' | 'user' | 'none' }. */
router.post('/api/access', async (req, res) => {
    const body = valid(ACCESS, req.body, res);
    if (!body) return;
    const { userId, role } = body;
    if (userId === String(req.user.userId)) {
        return res.status(400).json({ error: "You can't change your own access" });
    }
    try {
        // A new person must have written to the bot: that is the chat the panel knows them by,
        // and /login only answers there
        if (role !== 'none' && !roleOf(userId)) {
            const chat = await Chat.findOne({ where: { id: userId, type: 'private' }, attributes: ['id'] });
            if (!chat) return res.status(400).json({ error: "This person hasn't written to the bot yet" });
        }
        // After the wait, from here to the write nothing else runs: two admins taking each other
        // off at once can't both get through, and the panel always keeps an admin
        if (roleOf(req.user.userId) !== 'admin') {
            return res.status(403).json({ error: 'Only for the panel admins' });
        }
        const changes = {};
        for (const [name, key] of Object.entries(LISTS)) {
            const ids = idsIn(key);
            if (name === role) ids.add(userId);
            else ids.delete(userId);
            const value = [...ids].join(',');
            if (value !== String(process.env[key] || '')) changes[key] = value;
        }
        if (Object.keys(changes).length) {
            writeEnv(changes);
            Object.assign(process.env, changes);
            log.info(`[Access] User ${req.user.userId} set ${userId} to ${role}`);
        }
        // Taken off: their sessions and password go too, so adding them back later doesn't revive them
        if (role === 'none') await Promise.all([AccountSession.destroy({ where: { userId } }), removePassword(userId)]);
        res.json(await currentAccess(req.user.userId));
    } catch (err) {
        log.error(`[Access] Saving failed: ${err.message}`);
        res.status(500).json({ error: `Couldn't save: ${err.message}` });
    }
});

/**
 * Someone's password removed, as when it may have leaked: their sessions end too (an admin's own,
 * but the one making the request), and the bot tells them.
 */
router.delete('/api/access/:userId/password', async (req, res) => {
    const params = valid(z.object({ userId: ACCESS.shape.userId }), req.params, res);
    if (!params) return;
    try {
        const self = params.userId === String(req.user.userId);
        if (await removePassword(params.userId)) {
            await endOtherSessions(params.userId, self ? req.user.id : null);
            if (!self) notifyPassword(req.app.get('bot'), params.userId, 'removed-by-admin');
            log.info(`[Access] User ${req.user.userId} removed the password of ${params.userId}`);
        }
        res.json(await currentAccess(req.user.userId));
    } catch (err) {
        log.error(`[Access] Removing a password failed: ${err.message}`);
        res.status(500).json({ error: `Couldn't remove the password: ${err.message}` });
    }
});

module.exports = router;
module.exports.currentAccess = currentAccess;
