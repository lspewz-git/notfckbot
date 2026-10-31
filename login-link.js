/**
 * Getting into the panel without the bot, on the server (src/account/auth.js):
 *
 *   docker compose exec app node login-link.js [userId]
 *       a one-time sign-in link, for when Telegram is out of reach and the panel is needed to fix it
 *   docker compose exec app node login-link.js --session [userId]
 *       a session token (30 days) for the browser tests on the live panel:
 *       ADMIN_SESSION=<token> ADMIN_URL=http://192.168.2.112 npx playwright test
 *
 * Without an id: the system account (src/account/roles.js), or the first admin when it has no
 * password. Only people with a role.
 *
 *   docker compose exec app node login-link.js --system-password
 *       asks for the system account's new password (SYSTEM_PASSWORD_HASH in .env), for when it is
 *       lost, and signs the account out everywhere; the running app reads it after a restart
 *       (docker compose restart app)
 */
require('dotenv').config({ override: true, quiet: true });
const readline = require('node:readline/promises');
const sequelize = require('./src/database');
const auth = require('./src/account/auth');
const roles = require('./src/account/roles');
const { hashPassword, MIN_LENGTH } = require('./src/account/password');
const { writeEnv } = require('./src/admin/env');

async function main() {
    const args = process.argv.slice(2);
    const at = args.indexOf('--system-password');
    if (at !== -1) {
        // Asked for, not an argument: that would stay in the shell's history and the process list
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const password = await rl.question('New password for the system account: ');
        rl.close();
        if (password.length < MIN_LENGTH) throw new Error(`The password needs at least ${MIN_LENGTH} characters`);
        writeEnv({ SYSTEM_PASSWORD_HASH: await hashPassword(password) });
        // A session started with the old (maybe leaked) password must not outlive it
        await sequelize.authenticate();
        const ended = await sequelize.models.AccountSession.destroy({ where: { userId: roles.SYSTEM_ID } });
        console.log(
            `The system account's password is set, ${ended} session(s) ended. ` +
                `Restart the app (docker compose restart app), then sign in as "${roles.systemLogin()}".`
        );
        return;
    }
    const session = args.includes('--session');
    await sequelize.authenticate();
    await sequelize.models.AccountSession.sync();
    await sequelize.models.LoginLink.sync();
    await sequelize.models.PanelRole.sync();
    const fallback = roles.systemHash() ? roles.SYSTEM_ID : await roles.firstAdmin();
    const userId = args.find((a) => /^\d+$/.test(a)) || fallback;
    if (!userId || !(await auth.isAllowed(userId))) {
        throw new Error('No such user: give them a role in the panel, or set --system-password');
    }
    if (session) {
        console.log(
            await auth.startSession({
                userId,
                userName: roles.isSystem(userId) ? roles.systemLogin() : 'login-link.js'
            })
        );
    } else {
        const link = await auth.createLink({ id: userId, name: 'login-link.js' });
        if (!link) throw new Error('PANEL_URL is not set in .env');
        console.log(`${link}\n(works once, for ${auth.LINK_TTL_MS / 60000} minutes)`);
    }
}

main()
    .then(() => sequelize.close())
    .catch(async (err) => {
        console.error(err.message);
        await sequelize.close().catch(() => {});
        process.exitCode = 1;
    });
