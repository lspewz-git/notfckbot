// .env wins over the environment docker-compose baked in at container creation: the
// admin panel edits .env (tokens, proxy), and those edits must survive a restart.
require('dotenv').config({ override: true });
// Every axios request's timeout covers the connection to the proxy too (see http-deadline.js)
require('./http-deadline').installDeadline(require('axios'));
const { initDb } = require('./db');
const bot = require('./bot');
const { setupCron } = require('./cron');
const { startAdminServer } = require('./admin');
const { warmDetailsCache } = require('./warm-cache');
const { backfillReleaseSeasons } = require('./cron/release-seasons');

async function start() {
    try {
        console.log('Starting NotFckBot...');

        // Initialize Database
        await initDb();

        // Setup Cron Jobs
        setupCron(bot);

        // Launch Bot with explicit configuration
        console.log('Verifying bot token...');
        const botInfo = await bot.telegram.getMe();
        console.log(`Bot verified: @${botInfo.username}`);

        console.log('Cleaning up old webhooks...');
        await bot.telegram.deleteWebhook();

        // Start Admin Dashboard
        startAdminServer(bot);

        // In the background: the panel's cards are quick from the first one after a restart
        // Then the release history's years for series that have none yet (once per series)
        warmDetailsCache()
            .catch((err) => console.error('[Cache] Warm-up failed:', err.message))
            .then(backfillReleaseSeasons)
            .catch((err) => console.error('[History] Backfill failed:', err.message));

        console.log('Launching Telegram bot...');
        bot.launch({ dropPendingUpdates: true })
            .then(() => console.log('Bot is running! 🚀'))
            .catch((err) => console.error('Bot launch failed:', err));

        // Graceful stop (docker compose restart/stop): the day counts kept in memory are written
        // first, then the process ends without waiting for Docker to kill it
        for (const signal of ['SIGINT', 'SIGTERM']) {
            process.once(signal, async () => {
                // Throws when polling never started (a stop during startup)
                try {
                    bot.stop(signal);
                } catch {
                    // nothing to stop
                }
                await require('./stats-log')
                    .flushStats()
                    .catch(() => {});
                process.exit(0);
            });
        }
    } catch (err) {
        console.error('Fatal error during startup:', err);
        process.exit(1);
    }
}

start();
