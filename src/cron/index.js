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
const stats = require('../stats-log');

const checkUpdates = async (bot) => {
    if (!beginRun()) {
        console.log('[Cron] Update check already in progress. Skipping.');
        return;
    }
    console.log('[Cron] Running update check...');
    let fatal = null;

    try {
        // What the previous checks couldn't send goes first, so news arrives in order
        await flushPending(bot).catch((err) => console.error('[Cron] Queued messages failed:', err.message));
        // Load all series WITH their subscribers in one single query
        const allSeries = await Series.findAll({ include: [{ model: Chat }] });
        await checkSeriesUpdates(bot, allSeries);
        await checkWatchlistReleases(bot);
    } catch (error) {
        fatal = error.message;
        console.error('[Cron] Fatal error during update check:', error);
    } finally {
        endRun(fatal);
        const { lastRun } = getCronStatus();
        stats.count('checks');
        if (fatal || (lastRun && lastRun.errors)) stats.count('check_errors');
        await stats.flushStats();
        console.log('[Cron] Update check complete.');
    }
};

const setupCron = (bot) => {
    cron.schedule(`0 */${UPDATE_INTERVAL_HOURS} * * *`, () => checkUpdates(bot));
    // What quiet hours held goes out soon after they end, whatever hour that is; then the
    // weekly and monthly digests that are due
    cron.schedule('*/10 * * * *', async () => {
        await releaseHeld(bot);
        await sendDigests(bot);
        await stats.flushStats();
    });
    console.log(`[Cron] Scheduled: every ${UPDATE_INTERVAL_HOURS === 1 ? 'hour' : `${UPDATE_INTERVAL_HOURS} hours`}.`);
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
