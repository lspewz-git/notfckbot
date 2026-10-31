/**
 * Panel access (src/account/roles.js): a person's role from the Users list (Actions → Panel access),
 * and in Settings → Bot whether anyone who starts the bot may sign up, and the system account's
 * password. Roles live in the database, the other two in .env (written there and into process.env
 * at once); everything applies without a restart. An admin can't change their own role; two admins
 * taking each other's away at the same moment could leave none, and then the system account (always
 * an admin) is the way back.
 */
const { Chat } = require('../../db');
const roles = require('../../account/roles');
const { endOtherSessions } = require('../../account/auth');
const password = require('../../account/password');
const { writeEnv } = require('../env');
const { z, valid, idOf } = require('../validate');
const { log } = require('../../log');

const router = require('express').Router();

const settings = () => ({
    openSignup: roles.openSignup(),
    system: { login: roles.systemLogin(), passwordSet: Boolean(roles.systemHash()) }
});

router.get('/api/access', (req, res) => res.json(settings()));

// No leading zeros: "007" would be a second row that never matches the 7 Telegram sends
const USER_ID = idOf(/^[1-9]\d{0,19}$/, 'Bad user id');
const ACCESS = z.object({
    userId: USER_ID,
    role: z.enum(['admin', 'user', 'none'], { error: 'Pick admin, user or none' })
});

/** Body: { userId, role: 'admin' | 'user' | 'none' }. Answers the person's role as the list shows it. */
router.post('/api/access', async (req, res) => {
    const body = valid(ACCESS, req.body, res);
    if (!body) return;
    const { userId, role } = body;
    if (userId === String(req.user.userId)) {
        return res.status(400).json({ error: "You can't change your own access" });
    }
    try {
        // A role is for a person who wrote to the bot: that is the chat the panel knows them by
        const chat = await Chat.findOne({ where: { id: userId, type: 'private' }, attributes: ['id'] });
        if (!chat) return res.status(400).json({ error: "This person hasn't written to the bot yet" });
        // Taken off by another admin meanwhile: the guard let the request in, the handler doesn't
        if ((await roles.roleOf(req.user.userId)) !== 'admin') {
            return res.status(403).json({ error: 'Only for the panel admins' });
        }
        await roles.setRole(userId, role);
        // No access: their sessions and password go too, so a role given back doesn't revive them
        if (role === 'none') await Promise.all([endOtherSessions(userId), password.removePassword(userId)]);
        log.info(`[Access] User ${req.user.userId} set ${userId} to ${role}`);
        res.json({ userId, role: (await roles.rolesOf([userId])).get(userId) });
    } catch (err) {
        log.error(`[Access] Saving failed: ${err.message}`);
        res.status(500).json({ error: `Couldn't save: ${err.message}` });
    }
});

/** Body: { open: boolean }. Closing it signs out nobody: the people without a role just can't get in. */
router.put('/api/access/signup', (req, res) => {
    const body = valid(z.object({ open: z.boolean({ error: 'Bad value' }) }), req.body, res);
    if (!body) return;
    try {
        const value = String(body.open);
        writeEnv({ OPEN_SIGNUP: value });
        process.env.OPEN_SIGNUP = value;
        log.info(`[Access] User ${req.user.userId} turned sign-up ${body.open ? 'on' : 'off'}`);
        res.json(settings());
    } catch (err) {
        log.error(`[Access] Saving sign-up failed: ${err.message}`);
        res.status(500).json({ error: `Couldn't save: ${err.message}` });
    }
});

/** Body: { password }. The system account's other sessions end. */
router.put('/api/access/system-password', async (req, res) => {
    const body = valid(z.object({ password: password.PASSWORD }), req.body, res);
    if (!body) return;
    try {
        const hash = await password.hashPassword(body.password);
        writeEnv({ SYSTEM_PASSWORD_HASH: hash });
        process.env.SYSTEM_PASSWORD_HASH = hash;
        await endOtherSessions(roles.SYSTEM_ID, req.user.system ? req.user.id : null);
        log.info(`[Access] User ${req.user.userId} set the system account's password`);
        res.json(settings());
    } catch (err) {
        log.error(`[Access] Saving the system password failed: ${err.message}`);
        res.status(500).json({ error: `Couldn't save: ${err.message}` });
    }
});

/**
 * Someone's password removed, as when it may have leaked: their sessions end too (an admin's own,
 * but the one making the request), and the bot tells them.
 */
router.delete('/api/access/:userId/password', async (req, res) => {
    const params = valid(z.object({ userId: USER_ID }), req.params, res);
    if (!params) return;
    try {
        const self = params.userId === String(req.user.userId);
        if (await password.removePassword(params.userId)) {
            await endOtherSessions(params.userId, self ? req.user.id : null);
            if (!self) password.notifyPassword(req.app.get('bot'), params.userId, 'removed-by-admin');
            log.info(`[Access] User ${req.user.userId} removed the password of ${params.userId}`);
        }
        res.json({ userId: params.userId, hasPassword: false });
    } catch (err) {
        log.error(`[Access] Removing a password failed: ${err.message}`);
        res.status(500).json({ error: `Couldn't remove the password: ${err.message}` });
    }
});

module.exports = router;
