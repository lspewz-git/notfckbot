/**
 * What the panel's API accepts (zod schemas, src/admin/validate.js): a field of the wrong shape
 * gets 400 and its message before anything is looked up, stored or sent; a good request goes
 * through as before. The database models are stubbed. Run: npm run test:unit
 */
const { test, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Chat, Subscription, Watchlist } = require('../../src/db');

let base;
let server;
let updated;
let destroyed;
before(async () => {
    const app = express();
    app.use(express.json());
    app.set('bot', { telegram: {} });
    app.use(require('../../src/admin/routes/records'));
    app.use(require('../../src/admin/routes/actions'));
    app.use(require('../../src/admin/routes/details'));
    await new Promise((resolve) => {
        server = app.listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

beforeEach(() => {
    updated = null;
    destroyed = null;
    const chat = {
        get: () => ({}),
        update: async (changes) => {
            updated = changes;
        }
    };
    mock.method(Chat, 'findByPk', async () => chat);
    mock.method(Subscription, 'destroy', async (query) => {
        destroyed = query.where;
    });
    mock.method(Watchlist, 'destroy', async (query) => {
        destroyed = query.where;
    });
});

const call = (method, path, body) =>
    fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    }).then(async (res) => ({ status: res.status, body: await res.json() }));

test('a subscription with an unknown notification mode is refused, not stored', async () => {
    const res = await call('POST', '/api/subscription', { chatId: 1, tmdbId: 'tv_1', notify_type: 'hourly' });
    assert.deepEqual(res, { status: 400, body: { error: 'Bad notify_type' } });
    const missing = await call('POST', '/api/subscription', { chatId: 1 });
    assert.deepEqual(missing.body, { error: 'chatId and tmdbId are required' });
});

test('a message that is not text: 400, not a request left hanging', async () => {
    for (const message of [123, { text: 'hi' }, '   ', undefined]) {
        const res = await call('POST', '/api/chat/1/message', { message });
        assert.deepEqual(res, { status: 400, body: { error: 'Message is required' } }, JSON.stringify(message));
    }
    const broadcast = await call('POST', '/api/broadcast', { message: ['hi'] });
    assert.deepEqual(broadcast.body, { error: 'Message is required' });
});

test('a chat id that is not a number is refused before the database is asked', async () => {
    const res = await call('POST', '/api/chat/abc/unblock');
    assert.deepEqual(res, { status: 400, body: { error: 'Bad chat id' } });
    assert.equal(Chat.findByPk.mock.callCount(), 0);
});

test('deleting: the ids are checked, and good ones reach the database as before', async () => {
    assert.equal((await call('DELETE', '/api/subscription/-100123/tv_1399')).status, 200);
    assert.deepEqual(destroyed, { chatId: '-100123', seriesId: 'tv_1399' });
    assert.equal((await call('DELETE', '/api/subscription/1/1399')).body.error, 'Bad series id');
    assert.equal((await call('DELETE', '/api/watchlist/1;drop')).body.error, 'Bad id');
});

test('a block lasts 5 minutes unless told; a duration that is not a number is refused', async () => {
    const before = Date.now();
    assert.equal((await call('POST', '/api/chat/1/block', {})).status, 200);
    const minutes = (updated.blockedUntil - before) / 60000;
    assert.ok(minutes > 4.9 && minutes < 5.1, String(minutes));
    assert.equal((await call('POST', '/api/chat/1/block', { minutes: 'soon' })).status, 400);
    assert.equal((await call('POST', '/api/chat/1/block', { minutes: '30' })).status, 200);
});

test("a chat's settings: the same rules as before, only what was sent is changed", async () => {
    const quiet = await call('PATCH', '/api/chat/1/settings', { quiet_start: 22 });
    assert.deepEqual(quiet.body, { error: 'Quiet hours: two different hours from 0 to 23, or both off' });
    assert.equal((await call('PATCH', '/api/chat/1/settings', { quiet_start: 22, quiet_end: 22 })).status, 400);
    assert.equal(
        (await call('PATCH', '/api/chat/1/settings', { timezone: 'Mars/Base' })).body.error,
        'Unknown time zone'
    );
    assert.equal((await call('PATCH', '/api/chat/1/settings', { digest_week: 'yes' })).body.error, 'Bad digest_week');
    assert.equal((await call('PATCH', '/api/chat/1/settings', {})).body.error, 'Nothing to change');

    assert.equal((await call('PATCH', '/api/chat/1/settings', { quiet_start: null, quiet_end: null })).status, 200);
    assert.deepEqual(updated, { quiet_start: null, quiet_end: null });
    await call('PATCH', '/api/chat/1/settings', { buttons_mode: 'all', menu_enabled: false, other: 1 });
    assert.deepEqual(updated, { buttons_mode: 'all', menu_enabled: false });
});

test('a test notification needs the right id for its kind', async () => {
    const film = await call('POST', '/api/test-notification', { chatId: 1, mode: 'film', seriesId: 'tv_1' });
    assert.deepEqual(film.body, { error: 'filmId is required' });
    const mode = await call('POST', '/api/test-notification', { chatId: 1, mode: 'weekly', seriesId: 1 });
    assert.deepEqual(mode.body, { error: 'Unknown notification type: weekly' });
    const target = await call('POST', '/api/broadcast', { message: 'hi', target: 'everyone' });
    assert.deepEqual(target.body, { error: 'Unknown target "everyone"' });
});

test('the TMDB search takes one query', async () => {
    const res = await fetch(`${base}/api/tmdb/search?q=a&q=b`);
    assert.equal(res.status, 400);
    assert.equal((await fetch(`${base}/api/tmdb/search`)).status, 400);
});
