const { Series } = require('../db');

/** A calculation's row snapshot, with writes conditional on its original catalog and cursor. */
function derivedSeries(row) {
    const snapshot = row.toJSON ? row.toJSON() : { ...row };
    const where = Object.fromEntries(
        ['tmdb_id', 'episode_source', 'tvmaze_id', 'last_season', 'last_episode'].map((key) => [
            key,
            snapshot[key] ?? null
        ])
    );
    snapshot.update = async (changes) => {
        const [affected] = await Series.update(changes, { where });
        // MariaDB reports changed rows: another worker may already have saved these values.
        if (!affected && !(await Series.count({ where: { ...where, ...changes } })))
            throw new Error('Series catalog or cursor changed during calculation; discarding stale result');
        Object.assign(snapshot, changes);
        Object.assign(row, changes);
        return snapshot;
    };
    return snapshot;
}

module.exports = { derivedSeries };
