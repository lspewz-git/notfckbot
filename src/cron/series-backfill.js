const { getDetailsCached } = require('../api/tmdb');
const { log } = require('../log');

/** Rebuild selected series sequentially; one failed title must not stop the remaining titles. */
async function backfillSeries(pending, label, fill) {
    let failed = 0;
    for (const series of pending) {
        try {
            const details = await getDetailsCached(String(series.tmdb_id).replace('tv_', ''), 'tv');
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
