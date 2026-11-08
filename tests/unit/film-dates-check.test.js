/**
 * The update check keeps a waiting film's other dates for the panel (src/cron/films.js): TMDB's
 * digital release on every check, Kinopoisk's Russian dates at most once a day, and a failed
 * Kinopoisk lookup wipes nothing. TMDB, Kinopoisk and the database are stubbed.
 * Run: npm run test:unit
 */
const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const tmdb = require('../../src/api/tmdb');
const kinopoisk = require('../../src/api/kinopoisk');
const { Watchlist } = require('../../src/db');

// Not out yet: the check only keeps its dates, it sends nothing (a test may swap it for one out)
const NOT_OUT = {
    title: 'Пчеловод 2',
    release_date: '2027-01-13',
    status: 'Post Production',
    imdb_id: 'tt1',
    digital_release_date: '2027-02-06',
    digital_release_country: 'US'
};
let details = NOT_OUT;
mock.method(tmdb, 'getDetails', async () => details);
let ru;
let asked;
mock.method(kinopoisk, 'findKinopoiskId', async () => 7293756);
mock.method(kinopoisk, 'russianDates', async () => {
    asked += 1;
    return ru;
});

// The "film is out" message, recorded instead of sent
const outbox = require('../../src/cron/outbox');
const sent = [];
mock.method(outbox, 'notify', async (bot, chatId, text) => sent.push({ chatId, text }));

const { checkWatchlistReleases } = require('../../src/cron/films');

const row = (fields = {}) => ({
    tmdb_id: 'movie_1',
    title: 'Пчеловод 2',
    year: 2027,
    premiere_digital: '2027-01-13',
    notified: false,
    release_rule_version: 1,
    Chat: { id: 1 },
    async update(changes) {
        Object.assign(this, changes);
    },
    ...fields
});

let rows;
beforeEach(() => {
    details = NOT_OUT;
    asked = 0;
    sent.length = 0;
    ru = { premiere: '2027-01-16', digital: '2027-02-27', services: ['Okko', 'START'] };
    rows = [row(), row({ Chat: { id: 2 } })];
    mock.method(Watchlist, 'findAll', async () => rows);
});

test("the film's rows get TMDB's digital release and Kinopoisk's Russian dates", async () => {
    await checkWatchlistReleases({});
    for (const r of rows) {
        assert.equal(r.digital_date, '2027-02-06');
        assert.equal(r.digital_country, 'US');
        assert.equal(r.ru_premiere, '2027-01-16');
        assert.equal(r.ru_digital, '2027-02-27');
        assert.equal(r.ru_services, 'Okko, START');
        assert.ok(r.ru_checked_at instanceof Date);
    }
    assert.equal(asked, 1, 'once for the film, not per chat');
});

test('asked again only a day later', async () => {
    rows = [row({ ru_checked_at: new Date(Date.now() - 60 * 60 * 1000) })];
    await checkWatchlistReleases({});
    assert.equal(asked, 0);
    rows = [row({ ru_checked_at: new Date(Date.now() - 25 * 60 * 60 * 1000) })];
    await checkWatchlistReleases({});
    assert.equal(asked, 1);
});

test('Kinopoisk failing: the stored dates stay, and it is asked again on the next check', async () => {
    rows = [row({ ru_premiere: '2027-01-16', ru_digital: '2027-02-27', ru_checked_at: null })];
    ru = { ...kinopoisk.NO_DATES, failed: true };
    await checkWatchlistReleases({});
    assert.equal(rows[0].ru_premiere, '2027-01-16');
    assert.equal(rows[0].ru_digital, '2027-02-27');
    assert.equal(rows[0].ru_checked_at, null);
});

test('the "film is out" message carries the stored Russian dates, even with Kinopoisk failing then', async () => {
    details = {
        ...NOT_OUT,
        release_date: '2026-01-13',
        cinema_release_date: '2026-01-13',
        status: 'Released',
        digital_release_date: null
    };
    rows = [
        row({ ru_premiere: '2026-01-15', ru_digital: '2026-02-27', ru_services: 'Okko, START', ru_checked_at: null })
    ];
    ru = { ...kinopoisk.NO_DATES, failed: true };
    sent.length = 0;
    await checkWatchlistReleases({});
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Фильм вышел!/);
    assert.match(sent[0].text, /Цифровой релиз в России: <b>27 февраля 2026 г\.<\/b> · Okko, START/);
    details = NOT_OUT;
});

// A film in cinemas since two days ago, not online yet
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const IN_CINEMAS = () => ({
    ...NOT_OUT,
    status: 'Released',
    release_date: daysAgo(2),
    cinema_release_date: daysAgo(2),
    cinema_release_country: 'US',
    digital_release_date: null,
    digital_first_date: null
});

test('cinema release: once to every waiting chat, regardless of the old premiere setting', async () => {
    details = IN_CINEMAS();
    ru = { ...kinopoisk.NO_DATES, failed: true };
    rows = [row({ Chat: { id: 1, premieres: 'all' } }), row({ Chat: { id: 2, premieres: 'off' } })];
    await checkWatchlistReleases({});
    assert.deepEqual(
        sent.map((s) => s.chatId),
        [1, 2]
    );
    assert.ok(sent.every((s) => /Фильм вышел!/.test(s.text)));
    assert.match(sent[0].text, /Дата цифрового релиза неизвестна/);
    assert.doesNotMatch(sent[0].text, /SSPoisk/);
    assert.ok(rows.every((r) => r.notified));
    await checkWatchlistReleases({});
    assert.equal(sent.length, 2);
});

test('an opted-in digital alert still runs after the film is already in Released', async () => {
    details = { ...IN_CINEMAS(), digital_first_date: daysAgo(0), digital_first_country: 'US' };
    ru = { ...kinopoisk.NO_DATES, failed: true };
    rows = [row({ notified: true, Chat: { id: 1, notify_digital: true, digital_since: daysAgo(0) } })];
    await checkWatchlistReleases({});
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Фильм вышел онлайн!/);
    assert.equal(rows[0].digital_notified, true);
    await checkWatchlistReleases({});
    assert.equal(sent.length, 1);
});

test('digital alerts default off, and enabling does not send a past-date backlog', async () => {
    details = { ...IN_CINEMAS(), digital_first_date: daysAgo(1) };
    ru = { ...kinopoisk.NO_DATES, failed: true };
    rows = [
        row({ notified: true, Chat: { id: 1 } }),
        row({ notified: true, Chat: { id: 2, notify_digital: true, digital_since: daysAgo(0) } })
    ];
    await checkWatchlistReleases({});
    assert.equal(sent.length, 0);
    assert.ok(rows.every((r) => r.digital_notified));
});

test('a simultaneous cinema/digital release sends one combined notification', async () => {
    details = { ...IN_CINEMAS(), digital_first_date: daysAgo(0) };
    ru = { ...kinopoisk.NO_DATES, failed: true };
    rows = [row({ Chat: { id: 1, notify_digital: true, digital_since: daysAgo(0) } })];
    await checkWatchlistReleases({});
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Фильм вышел!/);
    assert.equal(rows[0].notified, true);
    assert.equal(rows[0].digital_notified, true);
});

test('legacy rows are baselined silently, including past films not yet notified under the old online rule', async () => {
    details = IN_CINEMAS();
    ru = { ...kinopoisk.NO_DATES, failed: true };
    rows = [row({ release_rule_version: 0 })];
    await checkWatchlistReleases({});
    assert.equal(sent.length, 0);
    assert.equal(rows[0].notified, true);
    assert.equal(rows[0].release_rule_version, 1);
});

test('legacy premature Released rows with future cinema dates are reopened without a message', async () => {
    details = { ...NOT_OUT, status: 'Released', cinema_release_date: '2999-01-01' };
    rows = [row({ release_rule_version: 0, notified: true })];
    await checkWatchlistReleases({});
    assert.equal(sent.length, 0);
    assert.equal(rows[0].notified, false);
    assert.equal(rows[0].release_rule_version, 1);
});

test('startup date refresh never sends or silently consumes a new-rule pending alert', async () => {
    details = IN_CINEMAS();
    rows = [row()];
    await checkWatchlistReleases(null, { datesOnly: true });
    assert.equal(sent.length, 0);
    assert.equal(rows[0].notified, false);
});

test('the date is evaluated in each chat timezone, and Released alone cannot send early', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T18:00:00Z') });
    details = { ...IN_CINEMAS(), cinema_release_date: '2026-11-09' };
    ru = { ...kinopoisk.NO_DATES, failed: true };
    rows = [row({ Chat: { id: 1, timezone: 'UTC' } }), row({ Chat: { id: 2, timezone: 'Asia/Irkutsk' } })];
    await checkWatchlistReleases({});
    assert.deepEqual(
        sent.map((s) => s.chatId),
        [2]
    );
});

test('duplicate waiting rows send one primary event and one later digital event per chat', async () => {
    details = IN_CINEMAS();
    ru = { ...kinopoisk.NO_DATES, failed: true };
    rows = [row(), row()];
    await checkWatchlistReleases({});
    assert.equal(sent.length, 1);
    assert.ok(rows.every((r) => r.notified));
    details = { ...IN_CINEMAS(), digital_first_date: daysAgo(0) };
    rows.forEach((r) => {
        r.Chat.notify_digital = true;
        r.Chat.digital_since = daysAgo(0);
    });
    await checkWatchlistReleases({});
    assert.equal(sent.length, 2);
    assert.ok(rows.every((r) => r.digital_notified));
});

test('a missing source date does not erase historical dates or reopen an already notified film', async () => {
    details = { title: 'Film', status: 'Released', release_dates: { results: [] } };
    ru = { ...kinopoisk.NO_DATES, failed: true };
    rows = [
        row({
            notified: true,
            release_rule_version: 0,
            premiere_digital: '2020-01-01',
            cinema_date: '2020-01-01',
            cinema_country: 'US'
        })
    ];
    await checkWatchlistReleases({});
    assert.equal(sent.length, 0);
    assert.equal(rows[0].notified, true);
    assert.equal(rows[0].premiere_digital, '2020-01-01');
    assert.equal(rows[0].cinema_date, '2020-01-01');
});

test('digital-only primary release includes digital information once, without a second opt-in alert', async () => {
    details = { status: 'Released', digital_first_date: daysAgo(0), digital_first_country: 'US' };
    ru = { ...kinopoisk.NO_DATES, failed: true };
    rows = [row({ Chat: { id: 1, notify_digital: true, digital_since: daysAgo(0) } })];
    await checkWatchlistReleases({});
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Фильм вышел!/);
    assert.equal(rows[0].notified, true);
    assert.equal(rows[0].digital_notified, true);
});
