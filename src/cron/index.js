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

const checkUpdates = async (bot) => {
    if (!beginRun()) {
        console.log('[Cron] Update check already in progress. Skipping.');
        return;
    }
    console.log('[Cron] Running update check...');
    let fatal = null;

    try {
        // Load all series WITH their subscribers in one single query
        const allSeries = await Series.findAll({ include: [{ model: Chat }] });
        await checkSeriesUpdates(bot, allSeries);
        await checkWatchlistReleases(bot);
    } catch (error) {
        fatal = error.message;
        console.error('[Cron] Fatal error during update check:', error);
    } finally {
        endRun(fatal);
        console.log('[Cron] Update check complete.');
    }
};

const setupCron = (bot) => {
    cron.schedule(`0 */${UPDATE_INTERVAL_HOURS} * * *`, () => checkUpdates(bot));
    console.log(`[Cron] Scheduled: every ${UPDATE_INTERVAL_HOURS} hours.`);
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
