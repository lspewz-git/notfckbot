const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Chat, Series, Subscription, Watchlist } = require('../../src/db');
const tmdb = require('../../src/api/tmdb');
const events = require('../../src/chat-events');
const ops = require('../../src/chat-ops');
const kinopoisk = require('../../src/api/kinopoisk');

test('digital settings accept booleans only and start without a historical backlog', async (t) => {
    assert.equal(ops.settingsSchema.safeParse({ notify_digital: true }).success, true);
    assert.equal(ops.settingsSchema.safeParse({ notify_digital: 'true' }).success, false);
    const chat = {
        id: 1,
        timezone: 'Asia/Irkutsk',
        notify_digital: false,
        async update(fields) {
            Object.assign(this, fields);
        }
    };
    t.mock.method(Chat, 'findByPk', async () => chat);
    t.mock.method(events, 'record', () => {});
    await ops.updateSettings(1, { notify_digital: true });
    assert.match(chat.digital_since, /^\d{4}-\d{2}-\d{2}$/);
    const since = chat.digital_since;
    await ops.updateSettings(1, { notify_digital: true });
    assert.equal(chat.digital_since, since, 'saving an already enabled setting keeps its boundary');
    await ops.updateSettings(1, { notify_digital: false });
    assert.equal(chat.digital_since, null);
});

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
    const details = {
        title: 'Film',
        status: 'Released',
        release_date: '2020-01-02',
        cinema_release_date: '2020-01-02'
    };
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

test('adding a film: digital information does not change its cinema release status', async (t) => {
    const today = new Date().toISOString().slice(0, 10);
    t.mock.method(Chat, 'findByPk', async () => ({ id: 1, timezone: 'UTC' }));
    t.mock.method(Watchlist, 'findAll', async () => []);
    // In cinemas since today, no digital release on TMDB
    const details = { title: 'Film', status: 'Released', release_date: today, cinema_release_date: today };
    t.mock.method(tmdb, 'getDetails', async () => details);
    t.mock.method(Watchlist, 'create', async (fields) => fields);
    t.mock.method(events, 'record', () => {});
    assert.equal((await ops.addFilm(1, '1')).isReleased, true);
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
    assert.equal((await ops.addFilm(1, '1')).entry.notified, true);
    details.cinema_release_date = '2999-01-01';
    details.release_date = '2999-01-01';
    assert.equal((await ops.addFilm(1, '1')).entry.notified, false);
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

test('a title id of another shape is refused before anything is read or saved', async (t) => {
    const chat = t.mock.method(Chat, 'findByPk', async () => ({ id: 1 }));
    const details = t.mock.method(tmdb, 'getDetails', async () => ({ id: 1 }));
    const series = t.mock.method(Series, 'findOrCreate', async () => [{}, true]);
    const film = t.mock.method(Watchlist, 'findOrCreate', async () => [{}, true]);
    // "tv_1_2" would be a second row for series 1, asked about at TMDB on every update check
    for (const id of ['tv_1_2', 'tv_movie_550', 'tv_person_1', 'tv_0', 'tv_', 'tv_12345678901', '1 OR 1']) {
        await assert.rejects(ops.subscribe(1, id, 'episode'), { status: 400, message: 'Bad series id' }, id);
    }
    for (const id of ['tv_1399', 'movie_1_2', 'movie_0', 'movie_', 'person_1']) {
        await assert.rejects(
            ops.addFilm(1, id, {}, { details: { id: 1 }, waitingOnly: true }),
            { status: 400, message: 'Bad film id' },
            id
        );
    }
    for (const stub of [chat, details, series, film]) assert.equal(stub.mock.callCount(), 0);
});
