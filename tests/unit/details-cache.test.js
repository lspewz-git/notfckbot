/**
 * TMDB details kept in memory (src/api/tmdb.js on lru-cache): the update check always asks TMDB,
 * the panel and the bot answer from memory while it is fresh, concurrent callers share one
 * request, and a failed refresh keeps the previous answer. TMDB is a stub. Run: npm run test:unit
 */
const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

// Every request to the stub TMDB: answered by `answer`, released when `gate` resolves
let requests;
let answer;
let gate;
const realCreate = axios.create.bind(axios);
mock.method(axios, 'create', (options) =>
    realCreate({
        ...options,
        adapter: async (config) => {
            requests += 1;
            await gate;
            const data = answer(config.url);
            return { data, status: 200, statusText: 'OK', headers: {}, config };
        }
    })
);

const { getDetails, getDetailsCached } = require('../../src/api/tmdb');

let version;
beforeEach(() => {
    requests = 0;
    version = 1;
    gate = Promise.resolve();
    answer = () => ({ name: `v${version}` });
});

test('the update check always asks TMDB; the panel then answers from memory', async () => {
    assert.equal((await getDetails(101, 'tv')).name, 'v1');
    version = 2;
    assert.equal((await getDetails(101, 'tv')).name, 'v2');
    assert.equal(requests, 2);
    assert.equal((await getDetailsCached(101, 'tv')).name, 'v2');
    assert.equal(requests, 2);
});

test('callers asking at once share one request', async () => {
    const results = await Promise.all([
        getDetailsCached(102, 'tv'),
        getDetailsCached(102, 'tv'),
        getDetails(102, 'tv')
    ]);
    assert.equal(requests, 1);
    assert.deepEqual(
        results.map((r) => r.name),
        ['v1', 'v1', 'v1']
    );
});

test('while the check refreshes a title, the panel gets the fresh answer at once, not after TMDB', async () => {
    await getDetails(103, 'movie');
    let release;
    gate = new Promise((r) => (release = r));
    version = 2;
    const refresh = getDetails(103, 'movie');
    assert.equal((await getDetailsCached(103, 'movie')).name, 'v1');
    release();
    assert.equal((await refresh).name, 'v2');
    assert.equal((await getDetailsCached(103, 'movie')).name, 'v2');
});

test('a failed refresh: the error reaches the check, the previous answer stays for the panel', async () => {
    await getDetails(104, 'tv');
    answer = () => {
        throw new Error('TMDB down');
    };
    await assert.rejects(getDetails(104, 'tv'), /TMDB down/);
    assert.equal((await getDetailsCached(104, 'tv')).name, 'v1');
    assert.equal(requests, 2);
});

test('a failure is not remembered: the next call asks again', async () => {
    answer = () => {
        throw new Error('TMDB down');
    };
    await assert.rejects(getDetailsCached(105, 'tv'));
    answer = () => ({ name: 'back' });
    assert.equal((await getDetailsCached(105, 'tv')).name, 'back');
    assert.equal(requests, 2);
});

test('an expired answer is not served: the panel waits for a fresh one', async () => {
    await getDetails(106, 'tv');
    const realNow = Date.now;
    try {
        const later = realNow() + 7 * 24 * 3600e3;
        Date.now = () => later;
        version = 2;
        assert.equal((await getDetailsCached(106, 'tv')).name, 'v2');
        assert.equal(requests, 2);
    } finally {
        Date.now = realNow;
    }
});
