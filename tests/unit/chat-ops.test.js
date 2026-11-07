const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Chat, Series, Subscription, Watchlist } = require('../../src/db');
const tmdb = require('../../src/api/tmdb');
const events = require('../../src/chat-events');
const ops = require('../../src/chat-ops');
const kinopoisk = require('../../src/api/kinopoisk');

// No Kinopoisk unless a test gives one
let kpDates = kinopoisk.NO_DATES;
mock.method(kinopoisk, 'kinopoiskQuick', async () => ({ kinopoiskId: null, ru: kpDates }));

test('a repeated mode is silent; a changed mode records its actor and preserves the episode cursor', async (t) => {
    const series = { tmdb_id: 'tv_1', title: 'Series', last_episode: 7 };
    const subscription = { chatId: -10, notify_type: 'episode', update: async () => {} };
    t.mock.method(Chat, 'findByPk', async () => ({ id: -10 }));
    t.mock.method(Series, 'findByPk', async () => series);
    t.mock.method(Subscription, 'findOrCreate', async () => [subscription, false]);
    const update = t.mock.method(subscription, 'update', async (fields) => Object.assign(subscription, fields));
    const record = t.mock.method(events, 'record', () => {});
    const who = { userId: 5, userName: 'User', source: 'bot' };
    await ops.subscribe(-10, 'tv_1', 'episode', who);
    assert.equal(update.mock.callCount(), 0);
    assert.equal(record.mock.callCount(), 0);
    await ops.setSubscriptionMode(subscription, series, 'season', who);
    assert.equal(series.last_episode, 7);
    assert.deepEqual(record.mock.calls[0].arguments, [
        -10,
        {
            kind: 'mode',
            detail: 'season',
            tmdb_id: 'tv_1',
            title: 'Series',
            ...who
        }
    ]);
});

test('a released film goes to Released from the panel but an old bot action still queues it once', async (t) => {
    t.mock.method(Chat, 'findByPk', async () => ({ id: 1 }));
    t.mock.method(Watchlist, 'findAll', async () => []);
    const details = { title: 'Film', status: 'Released', release_date: '2020-01-02' };
    t.mock.method(tmdb, 'getDetails', async () => details);
    const create = t.mock.method(Watchlist, 'create', async (fields) => fields);
    let waiting;
    t.mock.method(Watchlist, 'findOrCreate', async ({ where, defaults }) => {
        if (waiting) return [waiting, false];
        waiting = { ...where, ...defaults };
        return [waiting, true];
    });
    const record = t.mock.method(events, 'record', () => {});
    const panel = await ops.addFilm(1, '1');
    assert.equal(panel.entry.notified, true);
    const bot = await ops.addFilm(1, 'movie_1', {}, { details, waitingOnly: true });
    assert.equal(bot.entry.notified, false);
    assert.equal(bot.entry.title, panel.entry.title);
    assert.equal((await ops.addFilm(1, '1', {}, { details, waitingOnly: true })).created, false);
    assert.equal(create.mock.callCount(), 1);
    assert.equal(record.mock.callCount(), 2, 'a duplicate bot callback adds no event');
});

test("adding a film: Russia's online date from Kinopoisk counts, as in the update check", async (t) => {
    const today = new Date().toISOString().slice(0, 10);
    t.mock.method(Chat, 'findByPk', async () => ({ id: 1, timezone: 'UTC' }));
    t.mock.method(Watchlist, 'findAll', async () => []);
    // In cinemas since today, no digital release on TMDB
    const details = { title: 'Film', status: 'Released', release_date: today, cinema_release_date: today };
    t.mock.method(tmdb, 'getDetails', async () => details);
    t.mock.method(Watchlist, 'create', async (fields) => fields);
    t.mock.method(events, 'record', () => {});
    assert.equal((await ops.addFilm(1, '1')).isReleased, false);
    kpDates = { ...kinopoisk.NO_DATES, digital: today, services: ['Okko'] };
    t.after(() => (kpDates = kinopoisk.NO_DATES));
    const { entry, isReleased } = await ops.addFilm(1, '1');
    assert.equal(isReleased, true);
    assert.equal(entry.ru_digital, today);
    assert.equal(entry.ru_services, 'Okko');
});

test('a film added after its cinema premiere gets no premiere message (nor again after re-adding)', async (t) => {
    const today = new Date().toISOString().slice(0, 10);
    t.mock.method(Chat, 'findByPk', async () => ({ id: 1, timezone: 'UTC' }));
    t.mock.method(Watchlist, 'findAll', async () => []);
    const details = { title: 'Film', status: 'Released', release_date: today, cinema_release_date: today };
    t.mock.method(tmdb, 'getDetails', async () => details);
    t.mock.method(Watchlist, 'create', async (fields) => fields);
    t.mock.method(events, 'record', () => {});
    assert.equal((await ops.addFilm(1, '1')).entry.premiere_notified, true);
    details.cinema_release_date = '2999-01-01';
    details.release_date = '2999-01-01';
    assert.equal((await ops.addFilm(1, '1')).entry.premiere_notified, false);
});

test('film removal retains the chat boundary and removes only that row by default', async (t) => {
    const entry = { chatId: -10, tmdb_id: 'movie_1', title: 'Film', destroy: async () => {} };
    t.mock.method(Watchlist, 'findByPk', async () => entry);
    const destroy = t.mock.method(entry, 'destroy', async () => {});
    const record = t.mock.method(events, 'record', () => {});
    assert.equal(await ops.removeFilm(7, { chatId: -20 }), false);
    assert.equal(destroy.mock.callCount(), 0);
    assert.equal(await ops.removeFilm(7, { chatId: '-10' }), true);
    assert.equal(destroy.mock.callCount(), 1);
    assert.equal(record.mock.callCount(), 1);
});
