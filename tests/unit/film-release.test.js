/**
 * When a film counts as out (src/film-release.js): online for "Фильм вышел", the cinema premiere
 * for chats that asked for it. Pure. Run: npm run test:unit
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isOnline, onlineDate, premiereDue } = require('../../src/film-release');

const TODAY = '2026-11-11';

describe('online', () => {
    test('Released with a future release date is not out (How to Rob a Bank, 07.11)', () => {
        const film = { status: 'Released', release_date: '2026-11-11', cinema_release_date: '2026-11-11' };
        assert.equal(isOnline(film, {}, '2026-11-07'), false);
    });

    test('a cinema release is not online: without a digital date, 45 days after it', () => {
        const film = { status: 'Released', release_date: '2026-11-11', cinema_release_date: '2026-11-11' };
        assert.equal(isOnline(film, {}, TODAY), false);
        assert.deepEqual(onlineDate(film), { date: '2026-12-26', fallback: true });
        assert.equal(isOnline(film, {}, '2026-12-25'), false);
        assert.equal(isOnline(film, {}, '2026-12-26'), true);
    });

    test('a festival screening alone starts no 45-day wait; a limited release does', () => {
        const festival = {
            status: 'Released',
            release_date: '2026-05-20',
            release_dates: { results: [{ iso_3166_1: 'FR', release_dates: [{ type: 1 }] }] }
        };
        assert.equal(onlineDate(festival), null);
        assert.equal(isOnline(festival, {}, TODAY), false);
        const limited = { ...festival, limited_release_date: '2026-09-01' };
        assert.deepEqual(onlineDate(limited), { date: '2026-10-16', fallback: true });
        // No releases listed at all (an old film): the main date
        assert.equal(isOnline({ status: 'Released', release_date: '1999-03-31' }, {}, TODAY), true);
    });

    test('the first digital release decides, TMDB anywhere or Russia from Kinopoisk', () => {
        const film = { status: 'Released', release_date: '2026-10-01', digital_first_date: '2026-11-20' };
        assert.equal(isOnline(film, {}, '2026-11-19'), false);
        assert.equal(isOnline(film, {}, '2026-11-20'), true);
        assert.equal(isOnline(film, { digital: '2026-11-15' }, '2026-11-15'), true);
        assert.deepEqual(onlineDate(film, { digital: '2026-11-15' }), { date: '2026-11-15', fallback: false });
    });

    test('both signs: the date alone waits for Released, but only 7 days', () => {
        const film = { status: 'Post Production', digital_first_date: '2026-11-01' };
        assert.equal(isOnline(film, {}, '2026-11-01'), false);
        assert.equal(isOnline(film, {}, '2026-11-07'), false);
        assert.equal(isOnline(film, {}, '2026-11-08'), true);
        assert.equal(isOnline({ ...film, status: 'Released' }, {}, '2026-11-01'), true);
    });

    test('a cancelled film never; with no date at all, Released decides', () => {
        assert.equal(isOnline({ status: 'Canceled', digital_first_date: '2020-01-01' }, {}, TODAY), false);
        assert.equal(isOnline({ status: 'Released', release_date: '' }, {}, TODAY), true);
        assert.equal(isOnline({ status: 'Planned', release_date: 'soon' }, {}, TODAY), false);
    });
});

describe('the cinema premiere', () => {
    const film = {
        status: 'Released',
        release_date: '2026-11-11',
        cinema_release_date: '2026-11-11',
        cinema_release_country: 'US',
        cinema_ru_date: '2026-11-19'
    };

    test('off: never', () => {
        assert.equal(premiereDue(film, {}, 'off', TODAY), null);
        assert.equal(premiereDue(film, {}, undefined, TODAY), null);
    });

    test('anywhere: the first wide cinema release, with its country', () => {
        assert.equal(premiereDue(film, {}, 'all', '2026-11-10'), null);
        assert.deepEqual(premiereDue(film, {}, 'all', TODAY), { date: '2026-11-11', country: 'US' });
    });

    test('a festival or limited release alone is no cinema release', () => {
        const festival = { status: 'Released', release_date: '2026-09-01', cinema_release_date: null };
        assert.equal(premiereDue(festival, {}, 'all', TODAY), null);
    });

    test("Russia only: Kinopoisk's day, else TMDB's cinema release there; a month alone doesn't count", () => {
        assert.equal(premiereDue(film, {}, 'ru', TODAY), null);
        assert.deepEqual(premiereDue(film, {}, 'ru', '2026-11-19'), { date: '2026-11-19', country: 'RU' });
        assert.deepEqual(premiereDue(film, { premiere: '2026-11-12' }, 'ru', '2026-11-12'), {
            date: '2026-11-12',
            country: 'RU'
        });
        // 1 December 2026 is a Tuesday: Kinopoisk's "some time in December"
        const monthOnly = { ...film, cinema_ru_date: null };
        assert.equal(premiereDue(monthOnly, { premiere: '2026-12-01' }, 'ru', '2026-12-05'), null);
        assert.equal(premiereDue({ ...film, cinema_ru_date: null }, {}, 'ru', '2026-12-30'), null);
    });

    test('both signs as online; an old premiere is not news', () => {
        const notYet = { ...film, status: 'Post Production' };
        assert.equal(premiereDue(notYet, {}, 'all', TODAY), null);
        assert.ok(premiereDue(notYet, {}, 'all', '2026-11-18'));
        assert.ok(premiereDue(film, {}, 'all', '2026-11-25'));
        assert.equal(premiereDue(film, {}, 'all', '2026-11-26'), null);
        assert.equal(premiereDue({ ...film, status: 'Canceled' }, {}, 'all', TODAY), null);
    });
});
