/**
 * Errors outside the API (src/admin/index.js): a short answer, never Express's own page, which
 * carries the error's stack and the server's paths to anyone who asks. Run: npm run test:unit
 */
const { listenForTest } = require('./http-server');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../../src/admin/index');

let base;
let close;
before(async () => {
    ({ base, close } = await listenForTest(app));
});
after(() => close());

const noStack = (text) => {
    assert.doesNotMatch(text, /\n\s+at |node_modules|\.js:\d+/, 'no stack and no file paths');
};

test('a sign-in link whose token cannot be decoded: 400 in a few words, signed out', async () => {
    const res = await fetch(`${base}/login/%E0%A4%A`);
    const text = await res.text();
    assert.equal(res.status, 400);
    assert.equal(text, 'Bad request');
    noStack(text);
});

test('a malformed JSON body outside the API is not read at all', async () => {
    const res = await fetch(`${base}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"broken'
    });
    assert.equal(res.status, 404);
    noStack(await res.text());
});

test('a malformed JSON body in the API: the same short answer as before, as JSON', async () => {
    const res = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-By': 'notfckbot-panel' },
        body: '{"broken'
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Bad request' });
});
