/**
 * Who may call what (mounted on /api after src/admin/panel-only.js). Everything needs a session,
 * except signing in. The users' own pages and posters answer any signed-in
 * user; the rest of the panel answers admins only.
 */
const auth = require('./auth');
const { log } = require('../log');

const OPEN = /^\/login(\/telegram(\/poll|\/cancel)?|\/password|\/miniapp)?$/;
const ANY_ROLE = /^\/(account\/|poster\/|logout$)/;

async function guard(req, res, next) {
    if (OPEN.test(req.path)) return next();
    try {
        const session = await auth.sessionOf(req);
        if (!session) {
            auth.clearCookie(res);
            return res.status(401).json({ error: 'Sign in: /login in the bot' });
        }
        req.user = session;
        if (!req.path.startsWith('/poster/')) auth.setCookie(req, res, auth.cookieToken(req.headers.cookie));
        if (session.role === 'admin' || ANY_ROLE.test(req.path)) return next();
        log.warn(`[Account] User ${session.userId} refused ${req.method} /api${req.path}: admins only`);
        res.status(403).json({ error: 'Only for the panel admins' });
    } catch (err) {
        log.error(`[Account] Session check failed: ${err.message}`);
        res.status(500).json({ error: 'Session check failed' });
    }
}

module.exports = { guard };
