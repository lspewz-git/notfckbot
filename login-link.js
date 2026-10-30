/**
 * Getting into the panel without the bot, on the server (src/account/auth.js):
 *
 *   docker compose exec app node login-link.js [userId]
 *       a one-time sign-in link, for when Telegram is out of reach and the panel is needed to fix it
 *   docker compose exec app node login-link.js --session [userId]
 *       a session token (30 days) for the browser tests on the live panel:
 *       ADMIN_SESSION=<token> ADMIN_URL=http://192.168.2.112 npx playwright test
 *
 * Without an id: the first of ADMIN_USERS. Only users in ADMIN_USERS or ACCOUNT_USERS.
 */
require('dotenv').config({ override: true, quiet: true });
const sequelize = require('./src/database');
const auth = require('./src/account/auth');

async function main() {
    const args = process.argv.slice(2);
    const session = args.includes('--session');
    const userId = args.find((a) => /^\d+$/.test(a)) || auth.firstAdmin();
    if (!userId || !auth.isAllowed(userId)) {
        throw new Error('No such user: put the id into ADMIN_USERS or ACCOUNT_USERS in .env');
    }
    await sequelize.authenticate();
    await sequelize.models.AccountSession.sync();
    await sequelize.models.LoginLink.sync();
    if (session) {
        console.log(await auth.startSession({ userId, userName: 'login-link.js' }));
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
