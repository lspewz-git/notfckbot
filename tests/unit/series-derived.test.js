const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Series } = require('../../src/db');
const { fakeSeries, mockSeriesWrites } = require('./fakes');
const { derivedSeries } = require('../../src/cron/series-derived');

for (const [name, before, after] of [
    ['legacy source', { episode_source: null, tvmaze_id: null }, { episode_source: 'tvmaze', tvmaze_id: 7 }],
    ['primary ID', { episode_source: 'tvmaze', tvmaze_id: 7 }, { tvmaze_id: 8 }],
    ['episode cursor', { episode_source: 'tvmaze', tvmaze_id: 7 }, { last_episode: 2 }]
]) {
    test(`eight late workers cannot overwrite a changed ${name}`, async (t) => {
        const row = fakeSeries({ ...before, aired_episodes: 'saved', release_seasons: 'saved' });
        mockSeriesWrites(t.mock, [row]);
        let release;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        const workers = Array.from({ length: 8 }, () => {
            const snapshot = derivedSeries({ ...row });
            return held.then(async () => {
                await snapshot.update({ aired_episodes: 'stale' });
                await snapshot.update({ release_seasons: 'stale' });
            });
        });
        Object.assign(row, after);
        release();
        const results = await Promise.allSettled(workers);
        assert.equal(results.filter((r) => r.status === 'rejected').length, 8);
        assert.equal(row.aired_episodes, 'saved');
        assert.equal(row.release_seasons, 'saved');
        assert.equal(row.updates.length, 0);
    });
}

test('a live ORM row keeps its snapshot and uses conditional SQL for both derived fields', async (t) => {
    const row = Series.build(
        {
            tmdb_id: 'tv_7',
            episode_source: null,
            tvmaze_id: null,
            last_season: 1,
            last_episode: 1,
            aired_episodes: null,
            release_seasons: null
        },
        { isNewRecord: false }
    );
    const writes = [];
    t.mock.method(Series.sequelize.getQueryInterface(), 'bulkUpdate', async (table, values, where, options, attrs) => {
        const sql = Series.sequelize.dialect.queryGenerator.updateQuery(table, values, where, options, attrs);
        writes.push(sql.query);
        return 1;
    });
    const snapshot = derivedSeries(row);
    await snapshot.update({ aired_episodes: '2020-01:1=1/45' });
    await snapshot.update({ release_seasons: '2020:1' });
    assert.equal(row.aired_episodes, '2020-01:1=1/45');
    assert.equal(snapshot.release_seasons, '2020:1');
    for (const sql of writes) {
        assert.match(
            sql,
            /WHERE .*`tmdb_id` = .*`episode_source` IS NULL.*`tvmaze_id` IS NULL.*`last_season` = .*`last_episode` =/
        );
    }
    assert.equal(writes.length, 2);
});

test('a MariaDB no-op is successful only when the requested state still matches the saved row', async (t) => {
    const row = fakeSeries({ aired_episodes: 'already saved', release_seasons: null });
    mockSeriesWrites(t.mock, [row]);
    t.mock.method(Series, 'update', async () => [0]);
    const snapshot = derivedSeries({ ...row });
    await snapshot.update({ aired_episodes: 'already saved' });
    assert.equal(snapshot.aired_episodes, 'already saved');
    await assert.rejects(snapshot.update({ release_seasons: 'never saved' }), /discarding stale result/);
    row.last_episode += 1;
    await assert.rejects(snapshot.update({ aired_episodes: 'already saved' }), /discarding stale result/);
    assert.equal(row.release_seasons, null);
});
