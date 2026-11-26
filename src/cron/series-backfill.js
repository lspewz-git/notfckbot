const { getDetailsCached } = require('../api/tmdb');
const { log } = require('../log');
const { derivedSeries } = require('./series-derived');

/** Rebuild selected series sequentially; one failed title must not stop the remaining titles. */
async function backfillSeries(pending, label, fill) {
    let failed = 0;
    for (const row of pending) {
        const series = derivedSeries(row);
        try {
            const details = await getDetailsCached(String(series.tmdb_id).replace('tv_', ''), 'tv');
            if (!details || details.seed_only || (details.tvmaze_primary && details.tvmaze_missing))
                throw new Error('Series schedule unavailable; keeping stored history');
            if (details.tvmaze_primary && series.last_episode > 0 && !details.last_episode_to_air)
                throw new Error('Series schedule has no aired progress; keeping stored history');
            const source = details.data_source || (details.tvmaze_primary ? 'tvmaze' : 'tmdb');
            if ((series.episode_source || 'tmdb') !== source)
                throw new Error('Series source migration pending; keeping stored history');
            if (
                source === 'tvmaze' &&
                series.tvmaze_id &&
                details.tvmaze_id &&
                Number(series.tvmaze_id) !== Number(details.tvmaze_id)
            )
                throw new Error('TVmaze ID migration pending; keeping stored history');
            await fill(series, details);
        } catch (err) {
            failed += 1;
            log.error(`${label} for ${series.tmdb_id} failed: ${err.message}`);
        }
    }
    if (pending.length) {
        log.info(`${label} filled for ${pending.length - failed} of ${pending.length} series`);
    }
}

module.exports = { backfillSeries };
