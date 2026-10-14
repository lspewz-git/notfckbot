/**
 * Fills the TMDB details cache in the background after a start. The cache lives in memory,
 * so every restart (a deploy, a crash) empties it, and until the next update check (up to
 * UPDATE_INTERVAL_HOURS away) each card the panel opens would wait for TMDB through the proxy.
 *
 * One title at a time: a burst of parallel requests through the proxy would hold up the bot's
 * own TMDB calls (searches, cards) that arrive meanwhile. An update check starting at the same
 * moment is no problem: concurrent requests for a title share one fetch (see tmdb.js).
 */
const { Series, Watchlist } = require('./db');
const { getDetailsCached, getSeasonDetailsCached } = require('./api/tmdb');
const { findKinopoiskId } = require('./api/kinopoisk');

/** Every title the panel can show a card for: the tracked series and the films on any list. */
async function trackedTitles() {
    const [series, films] = await Promise.all([
        Series.findAll({ attributes: ['tmdb_id'] }),
        Watchlist.findAll({ attributes: ['tmdb_id'], group: ['tmdb_id'] })
    ]);
    return [...new Set([...series, ...films].map((row) => row.tmdb_id))];
}

async function warmDetailsCache() {
    const started = Date.now();
    const ids = await trackedTitles();
    let failed = 0;
    for (const tmdbId of ids) {
        const [mediaType, numericId] = String(tmdbId).split('_');
        if (!numericId) continue;
        try {
            const details = await getDetailsCached(numericId, mediaType);
            // Films keep no Kinopoisk ID in the database (series do): find it now, so the
            // History page links straight to their pages from the first view
            if (mediaType === 'movie') await findKinopoiskId(tmdbId, details.imdb_id);
            // The bot's 📅 week and month read episode dates from the current season (and the
            // next, once announced): the first view after a start shouldn't wait for TMDB
            if (mediaType === 'tv') {
                const last = details.last_episode_to_air && details.last_episode_to_air.season_number;
                const next = details.next_episode_to_air && details.next_episode_to_air.season_number;
                for (const season of new Set([last, next].filter(Boolean))) {
                    await getSeasonDetailsCached(numericId, season).catch(() => {});
                }
            }
        } catch {
            // Already logged by tmdb.js; that card will just ask TMDB when opened
            failed += 1;
        }
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(
        `[Cache] Warmed TMDB details for ${ids.length - failed} of ${ids.length} titles in ${seconds} s` +
            (failed ? ` (${failed} failed)` : '')
    );
}

module.exports = { warmDetailsCache };
