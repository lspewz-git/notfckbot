/**
 * TVmaze client (src/api/tvmaze.js): lookup by IMDb, then TheTVDB; episode times with length; a
 * series TVmaze lacks is remembered, failures are not and pause it; one request at a time; a
 * view's shared deadline. The HTTP client is stubbed. Run: node --test tests/unit/tvmaze.test.js
 */
const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const tvmaze = require('../../src/api/tvmaze');

beforeEach(() => tvmaze.resetLimits());
const pending = () => ({ promise: new Promise(() => {}), passed: () => false });
const over = () => ({ promise: Promise.resolve(), passed: () => true });
const notFound = () => Object.assign(new Error('404'), { response: { status: 404 } });

function stub(routes) {
    const asked = [];
    mock.method(tvmaze.client, 'get', async (url, config = {}) => {
        const key = `${url}${config.params ? `?${new URLSearchParams(config.params)}` : ''}`;
        asked.push(key);
        const answer = routes[key];
        if (answer instanceof Error) throw answer;
        if (answer === undefined) throw notFound();
        return { data: answer };
    });
    return asked;
}

test('found by IMDb: times by "season:episode" with day and length; specials and undated left out', async () => {
    const asked = stub({
        '/lookup/shows?imdb=tt1': { id: 5 },
        '/shows/5/episodes': [
            // Aired long ago: left out (a soap's list runs to thousands)
            { season: 1, number: 0, airdate: '2020-01-01', airstamp: '2020-01-01T01:00:00+00:00', airtime: '20:00' },
            {
                season: 1,
                number: 1,
                airdate: '2099-11-13',
                airtime: '21:00',
                airstamp: '2099-11-14T02:00:00+00:00',
                runtime: 52
            },
            // Streaming: no time of day, TVmaze's 12:00 UTC stand-in
            { season: 1, number: 2, airdate: '2099-11-20', airtime: '', airstamp: '2099-11-20T12:00:00+00:00' },
            { season: 1, number: 3, airdate: '2099-11-27', airstamp: null, runtime: null },
            { season: 1, number: null, airdate: '2099-12-01' },
            { season: 1, number: 4, airdate: '', airstamp: null }
        ]
    });
    assert.deepEqual(await tvmaze.airTimes('tv_101', { imdb: 'tt1', tvdb: null }), {
        '1:1': { stamp: Date.parse('2099-11-14T02:00:00Z'), date: '2099-11-13', runtime: 52, timed: true },
        '1:2': { stamp: Date.parse('2099-11-20T12:00:00Z'), date: '2099-11-20', runtime: null, timed: false },
        '1:3': { stamp: null, date: '2099-11-27', runtime: null, timed: false }
    });
    await tvmaze.airTimes('tv_101', { imdb: 'tt1', tvdb: null });
    assert.deepEqual(asked, ['/lookup/shows?imdb=tt1', '/shows/5/episodes'], 'the second call comes from the caches');
});

test('not by IMDb: TheTVDB; on neither the series is remembered as missing', async () => {
    let asked = stub({ '/lookup/shows?thetvdb=77': { id: 6 }, '/shows/6/episodes': [] });
    assert.deepEqual(await tvmaze.airTimes('tv_102', { imdb: 'tt2', tvdb: 77 }), {});
    assert.deepEqual(asked, ['/lookup/shows?imdb=tt2', '/lookup/shows?thetvdb=77', '/shows/6/episodes']);

    asked = stub({});
    assert.equal(await tvmaze.airTimes('tv_103', { imdb: 'tt3', tvdb: null }), null);
    assert.equal(await tvmaze.airTimes('tv_103', { imdb: 'tt3', tvdb: null }), null);
    assert.deepEqual(asked, ['/lookup/shows?imdb=tt3']);
});

test('the update check asks for a fresh schedule; when TVmaze fails it keeps the cached one', async () => {
    const ids = { imdb: 'tt20', tvdb: null };
    stub({
        '/lookup/shows?imdb=tt20': { id: 20 },
        '/shows/20/episodes': [{ season: 1, number: 1, airdate: '2099-01-01' }]
    });
    await tvmaze.airTimes('tv_120', ids);
    let asked = stub({
        '/lookup/shows?imdb=tt20': { id: 20 },
        '/shows/20/episodes': [{ season: 1, number: 2, airdate: '2099-01-08' }]
    });
    assert.deepEqual(Object.keys(await tvmaze.airTimesForCheck('tv_120', ids)), ['1:2']);
    assert.deepEqual(asked, ['/shows/20/episodes']);
    asked = stub({ '/shows/20/episodes': Object.assign(new Error('503'), { response: { status: 503 } }) });
    assert.deepEqual(Object.keys(await tvmaze.airTimesForCheck('tv_120', ids)), ['1:2'], 'the cached one');
    assert.equal(await tvmaze.airTimesForCheck('tv_121', { imdb: 'tt21', tvdb: null }), null, 'paused, nothing cached');
});

test('a failure is not kept, and pauses TVmaze: nothing is asked until the pause ends', async () => {
    const tt4 = { imdb: 'tt4', tvdb: null };
    let asked = stub({ '/lookup/shows?imdb=tt4': Object.assign(new Error('429'), { response: { status: 429 } }) });
    assert.equal(await tvmaze.airTimesQuick('tv_104', tt4, pending()), null);
    await assert.rejects(tvmaze.airTimes('tv_104', tt4), /paused/);
    assert.equal(asked.length, 1, 'paused: no second request');

    tvmaze.resetLimits();
    asked = stub({
        '/lookup/shows?imdb=tt4': { id: 7 },
        '/shows/7/episodes': [{ season: 2, number: 1, airdate: '2099-01-01' }]
    });
    assert.deepEqual(await tvmaze.airTimesQuick('tv_104', tt4, pending()), {
        '2:1': { stamp: null, date: '2099-01-01', runtime: null, timed: false }
    });
});

test('one request at a time, with a gap between them', async () => {
    tvmaze.resetLimits({ gapMs: 50 });
    let running = 0;
    let most = 0;
    const starts = [];
    mock.method(tvmaze.client, 'get', async () => {
        starts.push(Date.now());
        most = Math.max(most, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        throw notFound();
    });
    await Promise.all(['tt11', 'tt12', 'tt13'].map((imdb, i) => tvmaze.airTimes(`tv_11${i}`, { imdb, tvdb: null })));
    assert.equal(most, 1);
    assert.ok(starts[2] - starts[0] >= 2 * 50 - 5, `${starts}`);
});

test("a view's shared deadline: past it, cached times still come and nothing new is asked", async () => {
    stub({
        '/lookup/shows?imdb=tt5': { id: 8 },
        '/shows/8/episodes': [{ season: 1, number: 1, airdate: '2099-02-02' }]
    });
    await tvmaze.airTimes('tv_106', { imdb: 'tt5', tvdb: null });
    assert.deepEqual(Object.keys(await tvmaze.airTimesQuick('tv_106', { imdb: 'tt5', tvdb: null }, over())), ['1:1']);
    stub({});
    await tvmaze.airTimes('tv_107', { imdb: 'tt6', tvdb: null });
    assert.equal(await tvmaze.airTimesQuick('tv_107', { imdb: 'tt6', tvdb: null }, over()), null);
    const asked = stub({});
    assert.equal(await tvmaze.airTimesQuick('tv_108', { imdb: 'tt7', tvdb: null }, over()), null);
    assert.deepEqual(asked, []);
    mock.method(tvmaze.client, 'get', () => new Promise(() => {}));
    const soon = tvmaze.viewDeadline(20);
    assert.equal(await tvmaze.airTimesQuick('tv_109', { imdb: 'tt8', tvdb: null }, soon), null);
    assert.equal(soon.passed(), true);
});

test('no IDs to ask by: nothing asked; requests go through the proxy setting', async () => {
    const asked = stub({});
    assert.equal(await tvmaze.airTimes('tv_105', tvmaze.externalsOf(null)), null);
    assert.deepEqual(tvmaze.externalsOf({ external_ids: { imdb_id: 'tt9', tvdb_id: 9 } }), { imdb: 'tt9', tvdb: 9 });
    assert.deepEqual(asked, []);
    // The interceptor puts the proxy's agent (none here) on every request
    const [interceptor] = tvmaze.client.interceptors.request.handlers.filter(Boolean).slice(-1);
    const config = await interceptor.fulfilled({ headers: {} });
    assert.ok('httpsAgent' in config);
});

test('a long queue: views add no requests of their own (the update check is not held up)', async () => {
    let asked = 0;
    mock.method(tvmaze.client, 'get', () => {
        asked += 1;
        return new Promise(() => {});
    });
    // Four requests waiting (the check, or other views)
    for (const n of [31, 32, 33, 34]) tvmaze.airTimes(`tv_${n}`, { imdb: `tt${n}`, tvdb: null }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const before = asked;
    assert.equal(await tvmaze.airTimesQuick('tv_35', { imdb: 'tt35', tvdb: null }, pending()), null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(asked, before, 'nothing queued for the view');
});
