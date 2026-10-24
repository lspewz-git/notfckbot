/**
 * The scheduled update check. Every UPDATE_INTERVAL_HOURS it looks for new episodes, finished
 * seasons and status changes (series.js) and released films (films.js), and tells the
 * subscribed chats. The texts are in messages.js, the dashboard's run status in status.js.
 */
const cron = require('node-cron');
const { Series, Chat } = require('../db');
const { UPDATE_INTERVAL_HOURS } = require('../constants');
const { beginRun, endRun, getCronStatus, nextRunAt } = require('./status');
const { checkSeriesUpdates, notifyNewEpisodes, notifyStatusChange, isSeasonComplete } = require('./series');
const { checkWatchlistReleases, isMovieReleased } = require('./films');
const { buildSeriesMessages, buildFilmMessage } = require('./messages');
const { flushPending } = require('./outbox');
const { releaseHeld } = require('./held');
const { sendDigests } = require('./digests');
const { processQueue: sendRecaps } = require('../recap/send');
const { runSchedule } = require('../recap/schedule');
const stats = require('../stats-log');
const { flushEvents } = require('../chat-events');
const { log } = require('../log');

const checkUpdates = async (bot) => {
    if (!beginRun()) {
        log.info('[Cron] Update check already in progress. Skipping.');
        return;
    }
    log.info('[Cron] Running update check...');
    let fatal = null;

    try {
        // What the previous checks couldn't send goes first, so news arrives in order
        await flushPending(bot).catch((err) => log.error(`[Cron] Queued messages failed: ${err.message}`));
        // Load all series WITH their subscribers in one single query
        const allSeries = await Series.findAll({ include: [{ model: Chat }] });
        await checkSeriesUpdates(bot, allSeries);
        await checkWatchlistReleases(bot);
    } catch (error) {
        fatal = error.message;
        log.error({ err: error }, '[Cron] Fatal error during update check');
    } finally {
        endRun(fatal);
        const { lastRun } = getCronStatus();
        stats.count('checks');
        if (fatal || (lastRun && lastRun.errors)) stats.count('check_errors');
        await stats.flushStats();
        await flushEvents();
        log.info('[Cron] Update check complete.');
    }
};

const setupCron = (bot) => {
    cron.schedule(`0 */${UPDATE_INTERVAL_HOURS} * * *`, () => checkUpdates(bot));
    // What quiet hours held goes out soon after they end, whatever hour that is; then the
    // weekly and monthly digests that are due
    cron.schedule('*/10 * * * *', async () => {
        await releaseHeld(bot);
        await sendDigests(bot);
        // The year's recap by date: the chats whose hour has come join the queue
        await runSchedule().catch((err) => log.error(`[Recap] Scheduled sending failed: ${err.message}`));
        // The year's recap queued from the panel or by date: chats whose quiet hours have ended,
        // and retries. In the background: a long queue mustn't hold up the counts below (it logs
        // its own errors)
        sendRecaps(bot);
        await stats.flushStats();
        await flushEvents();
    });
    log.info(`[Cron] Scheduled: every ${UPDATE_INTERVAL_HOURS === 1 ? 'hour' : `${UPDATE_INTERVAL_HOURS} hours`}.`);
};

module.exports = {
    setupCron,
    checkUpdates,
    buildSeriesMessages,
    getCronStatus,
    // The decisions behind each notification, for tests/unit
    notifyNewEpisodes,
    notifyStatusChange,
    isSeasonComplete,
    isMovieReleased,
    buildFilmMessage,
    nextRunAt
};
