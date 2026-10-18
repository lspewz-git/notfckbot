/**
 * Looking up a title's Kinopoisk ID: Wikidata first, the Kinopoisk API second. A found ID is
 * kept, a failure is not asked again for a while, and two lookups at once make one.
 * Run: npm run test:unit
 */
const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.KINOPOISK_API_KEY = 'test-key';

// What each source does, set per test: Wikidata knows nothing, the API rejects the key
let requests;
let wikidataKnows;
mock.method(axios, 'get', async (url) => {
    requests.push(url.includes('wikidata') ? 'wikidata' : 'kinopoisk');
    if (url.includes('wikidata')) {
        const bindings = wikidataKnows ? [{ kp: { value: String(wikidataKnows) } }] : [];
        return { data: { results: { bindings } } };
    }
    throw Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } });
});

const { findKinopoiskId, knownKinopoiskId } = require('../../src/api/kinopoisk');

beforeEach(() => {
    requests = [];
    wikidataKnows = null;
});

test('a lookup that failed is not repeated right away (a page of search results asks often)', async () => {
    assert.equal(await findKinopoiskId('movie_1001', 'tt1'), null);
    assert.deepEqual(requests, ['wikidata', 'kinopoisk']);
    assert.equal(await findKinopoiskId('movie_1001', 'tt1'), null);
    assert.deepEqual(requests, ['wikidata', 'kinopoisk'], 'answered from memory');
});

test('two lookups of one title at once make one', async () => {
    await Promise.all([findKinopoiskId('movie_1002', 'tt2'), findKinopoiskId('movie_1002', 'tt2')]);
    assert.deepEqual(requests, ['wikidata', 'kinopoisk']);
});

test('a found ID is kept: no second request', async () => {
    wikidataKnows = 435;
    assert.equal(await findKinopoiskId('movie_1003', 'tt3'), 435);
    assert.equal(await findKinopoiskId('movie_1003', 'tt3'), 435);
    assert.deepEqual(requests, ['wikidata']);
});

test('the history asks again once a miss has expired, instead of keeping the search link for good', async () => {
    const realNow = Date.now;
    try {
        assert.equal(knownKinopoiskId('movie_3003'), null);
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(requests, ['wikidata'], 'looked up in the background');
        assert.equal(knownKinopoiskId('movie_3003'), null);
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(requests, ['wikidata'], 'a fresh miss is not asked again');

        // Seven hours on, Wikidata has learned the film
        wikidataKnows = 4004;
        Date.now = () => realNow() + 7 * 60 * 60 * 1000;
        assert.equal(knownKinopoiskId('movie_3003'), null);
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(knownKinopoiskId('movie_3003'), 4004);
    } finally {
        Date.now = realNow;
    }
});
