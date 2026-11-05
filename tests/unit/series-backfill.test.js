const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const tmdb = require('../../src/api/tmdb');
const { Series } = require('../../src/db');
const { log } = require('../../src/log');

const requests = [];
mock.method(tmdb, 'getDetailsCached', async (id, kind) => {
    requests.push([id, kind]);
    if (id === '1') throw new Error('TMDB unavailable');
    return { genres: [{ name: 'Drama' }], seasons: [] };
});

const { backfillAiredEpisodes } = require('../../src/cron/aired-episodes');
const { backfillReleaseSeasons } = require('../../src/cron/release-seasons');

for (const [run, field, label, query] of [
    [backfillAiredEpisodes, 'aired_episodes', '[Stats] Aired episodes', { where: { aired_episodes: null } }],
    [backfillReleaseSeasons, 'release_seasons', '[History] Release seasons', undefined]
]) {
    test(`${field}: fetch and write failures leave later titles running and keep accurate totals`, async (t) => {
        requests.length = 0;
        const writes = [];
        const rows = [1, 2, 3].map((id) => ({
            tmdb_id: `tv_${id}`,
            [field]: null,
            async update(changes) {
                writes.push([id, changes]);
                if (id === 2) throw new Error('write failed');
                Object.assign(this, changes);
            }
        }));
        t.mock.method(Series, 'findAll', async (options) => {
            assert.deepEqual(options, query);
            return rows;
        });
        const errors = [];
        const info = [];
        t.mock.method(log, 'error', (message) => errors.push(message));
        t.mock.method(log, 'info', (message) => info.push(message));
        await run();
        assert.deepEqual(requests, [
            ['1', 'tv'],
            ['2', 'tv'],
            ['3', 'tv']
        ]);
        assert.equal(rows[0][field], null);
        assert.equal(rows[1][field], null);
        assert.equal(rows[2][field], '');
        assert.deepEqual(errors, [
            `${label} for tv_1 failed: TMDB unavailable`,
            `${label} for tv_2 failed: write failed`
        ]);
        assert.deepEqual(info, [`${label} filled for 1 of 3 series`]);
        if (field === 'aired_episodes') {
            assert.equal(rows[2].genres, 'Drama', 'facts are filled before episode counts');
            assert.deepEqual(writes.at(-1), [3, { aired_episodes: '' }]);
        } else {
            assert.equal(rows[2].genres, undefined, 'release indexing does not fill title facts');
        }
    });

    test(`${field}: no pending titles means no requests or completion log`, async (t) => {
        requests.length = 0;
        t.mock.method(Series, 'findAll', async () => []);
        const info = t.mock.method(log, 'info', () => {});
        await run();
        assert.deepEqual(requests, []);
        assert.equal(info.mock.callCount(), 0);
    });
}
