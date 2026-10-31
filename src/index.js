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
const { backfillAiredEpisodes } = require('./cron/aired-episodes');
const { backfillFilmFacts } = require('./cron/films');
const { startAlerts, markShutdown, lastShutdown } = require('./alerts/watch');
const { getVersion } = require('./admin/version');
const { waitForTelegram, telegramReady } = require('./telegram-ready');
const { setTimeout: sleep } = require('node:timers/promises');
const { log } = require('./log');

async function start() {
    try {
        log.info('Starting NotFckBot...');
        // How the last run ended, read (and the mark cleared) before anything here can fail: a
        // start that dies early must not leave the old mark for the next crash to hide behind
        const ended = lastShutdown();

        // Graceful stop (docker compose restart/stop), set first: a stop during startup isn't a
        // crash either (node is PID 1 and ignores SIGTERM without a handler). The day counts and
        // chat events kept in memory are written first, then the process ends without waiting for
        // Docker to kill it
        for (const signal of ['SIGINT', 'SIGTERM']) {
            process.once(signal, async () => {
                // Not a crash: the next start says so (a restart from the panel has marked it already)
                markShutdown('signal', { keep: true });
                // Throws when polling never started (a stop during startup)
                try {
                    bot.stop(signal);
                } catch {
                    // nothing to stop
                }
                await require('./stats-log')
                    .flushStats()
                    .catch(() => {});
                await require('./send-failures').flushFailures();
                await require('./chat-events')
                    .flushEvents()
                    .catch(() => {});
                process.exit(0);
            });
        }

        // Initialize Database
        await initDb();
        // Panel roles from .env, once, into the database (src/account/roles.js)
        await require('./account/roles')
            .importFromEnv()
            .catch((err) => log.error(`[Account] Moving roles from .env failed: ${err.message}`));

        // The panel needs no Telegram: it starts first, so a Telegram out of reach (the network, a
        // block, a revoked token) leaves it up to see why and to set a proxy or a new token
        startAdminServer(bot);

        // Alerts to the people in Settings → Alerts: the minute's look starts now, the alert on
        // how the last run ended once Telegram answers
        startAlerts(bot, { version: getVersion().short, ended, ready: telegramReady });

        // In the background: the panel's cards are quick from the first one after a restart
        // Then the release history's years for series that have none yet (once per series)
        warmDetailsCache()
            .catch((err) => log.error(`[Cache] Warm-up failed: ${err.message}`))
            .then(backfillReleaseSeasons)
            .catch((err) => log.error(`[History] Backfill failed: ${err.message}`))
            // And for the chats' statistics: episodes by month, what each title is (once per title)
            .then(backfillAiredEpisodes)
            .then(backfillFilmFacts)
            .catch((err) => log.error(`[Stats] Backfill failed: ${err.message}`));

        startBot();
    } catch (err) {
        log.error({ err }, 'Fatal error during startup');
        process.exit(1);
    }
}

/**
 * Telegram first, then what needs it: the update check (its sends would be refused and lost with a
 * revoked token) and polling. A launch that fails (the network again) is tried again, not left
 * dead. Never throws: the process stays up for the panel.
 */
async function startBot() {
    for (let pass = 1; ; pass += 1) {
        // Polling refused over and over (a second copy of the bot on the token: 409) is logged
        // now and then, not twice a minute
        const loud = pass <= 3 || pass % 10 === 0;
        // Tried until Telegram answers: the process doesn't exit over it. The updates sent while
        // the bot was down are dropped at the start only: a relaunch keeps them
        const botInfo = await waitForTelegram(bot, { dropPending: pass === 1, quiet: !loud });
        // launch() would ask getMe again otherwise
        bot.botInfo = botInfo;
        if (pass === 1) {
            setupCron(bot);
            // Groups that added the bot back while it was down: their update was dropped just now
            require('./bot/membership')
                .recheckRemoved(bot, botInfo.id)
                .catch((err) => log.error(`[Status] Rechecking removed groups failed: ${err.message}`));
        }
        try {
            if (loud) log.info('Launching Telegram bot...');
            // Settles when polling stops: on a signal (bot.stop), or on Telegram's refusal. Its own
            // deleteWebhook finds nothing left: waitForTelegram removed the webhook in its deadline
            await bot.launch({}, () => loud && log.info('Bot is running! 🚀'));
            return;
        } catch (err) {
            if (loud) log.error(`[Telegram] Polling stopped (pass ${pass}): ${err.message}. Starting again in 30 s`);
            await sleep(30 * 1000);
        }
    }
}

start();
