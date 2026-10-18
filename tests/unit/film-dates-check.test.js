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

mock.method(console, 'log', () => {});
mock.method(console, 'error', () => {});

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
    details = { ...NOT_OUT, release_date: '2026-01-13', status: 'Released', digital_release_date: null };
    rows = [
        row({ ru_premiere: '2026-01-15', ru_digital: '2026-02-27', ru_services: 'Okko, START', ru_checked_at: null })
    ];
    ru = { ...kinopoisk.NO_DATES, failed: true };
    sent.length = 0;
    await checkWatchlistReleases({});
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Премьера в России: <b>15 января 2026 г\.<\/b>/);
    assert.match(sent[0].text, /Цифровой релиз в России: <b>27 февраля 2026 г\.<\/b> · Okko, START/);
    details = NOT_OUT;
});
