const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    releaseDate,
    isReleased,
    onlineDate,
    isOnline,
    storedDates,
    initialReleaseState
} = require('../../src/film-release');

const movie = (events, fields = {}) => ({
    status: 'Released',
    origin_country: ['US'],
    release_date: '2026-09-04',
    release_dates: {
        results: events.map(([country, type, date]) => ({
            iso_3166_1: country,
            release_dates: [{ type, release_date: `${date}T00:00:00Z` }]
        }))
    },
    ...fields
});

test('a festival status cannot announce How to Rob a Bank before its actual cinema date', () => {
    const film = movie([
        ['US', 1, '2026-09-04'],
        ['BE', 3, '2026-11-11'],
        ['FR', 3, '2026-11-11'],
        ['RU', 3, '2027-02-18']
    ]);
    assert.deepEqual(releaseDate(film), { date: '2026-11-11', country: 'BE', countries: ['BE', 'FR'] });
    assert.equal(isReleased(film, {}, '2026-11-08'), false);
    assert.equal(isReleased(film, {}, '2026-11-11'), true);
});

test('limited cinema counts, including a film with no wide release at all', () => {
    const dune = movie([
        ['FR', 2, '2026-12-15'],
        ['FR', 3, '2026-12-16']
    ]);
    assert.equal(releaseDate(dune).date, '2026-12-15');
    assert.equal(releaseDate(movie([['NZ', 2, '2026-03-05']])).date, '2026-03-05');
});

test('Russian films use Russia, regardless of an earlier foreign screening or language', () => {
    const film = movie(
        [
            ['US', 3, '2026-11-01'],
            ['RU', 3, '2026-12-10']
        ],
        { origin_country: ['RU'], original_language: 'en' }
    );
    assert.equal(releaseDate(film).date, '2026-12-10');
    assert.equal(releaseDate(film, { premiere: '2026-12-17' }).date, '2026-12-17');
    assert.equal(releaseDate({ ...film, release_dates: { results: [] } }), null);
});

test('both signs are mandatory: no seven-day bypass, no generic/festival date fallback', () => {
    const film = movie([['US', 3, '2026-01-01']], { status: 'Post Production' });
    assert.equal(isReleased(film, {}, '2026-11-08'), false);
    assert.equal(isReleased({ ...film, status: 'Canceled' }, {}, '2026-11-08'), false);
    assert.equal(isReleased(movie([['US', 1, '2026-01-01']]), {}, '2026-11-08'), false);
    assert.equal(isReleased({ status: 'Released', release_date: '2020-01-01' }, {}, '2026-11-08'), false);
});

test('no 45-day estimate: an unknown digital release stays unknown after cinema', () => {
    const film = movie([['RU', 3, '2026-12-10']], { origin_country: ['RU'] });
    assert.equal(onlineDate(film), null);
    assert.equal(isOnline(film, {}, '2027-01-24'), false);
    const dates = storedDates(film);
    assert.equal(dates.premiere_digital, '2026-12-10');
    assert.equal(dates.online_date, null);
    assert.equal(dates.online_estimate, false);
});

test('digital date and country are selected together, independently of cinema', () => {
    const film = movie([
        ['US', 3, '2026-08-28'],
        ['AU', 4, '2026-08-01'],
        ['US', 4, '2026-09-01']
    ]);
    assert.equal(onlineDate(film).date, '2026-08-01');
    assert.equal(onlineDate(film).country, 'AU');
    assert.equal(isOnline(film, {}, '2026-08-01'), true);
    assert.equal(isReleased(film, {}, '2026-08-01'), false);
});

test('initial migration silently baselines past releases and restores prematurely closed future films', () => {
    const future = movie([['US', 2, '2026-12-25']]);
    const past = movie([
        ['US', 2, '2026-01-01'],
        ['US', 4, '2026-02-01']
    ]);
    assert.deepEqual(initialReleaseState(future, {}, '2026-11-08'), {
        notified: false,
        digital_notified: false,
        release_rule_version: 1
    });
    assert.deepEqual(initialReleaseState(past, {}, '2026-11-08'), {
        notified: true,
        digital_notified: true,
        release_rule_version: 1
    });
});

test('a digital-only film uses its known digital event as the main release, without guessing', () => {
    const film = movie([
        ['US', 1, '2026-01-01'],
        ['US', 4, '2026-02-01']
    ]);
    assert.equal(releaseDate(film).date, '2026-02-01');
    assert.equal(isReleased(film, {}, '2026-01-31'), false);
    assert.equal(isReleased(film, {}, '2026-02-01'), true);
});

test('migration preserves a notified historical film if the source no longer provides release dates', () => {
    const film = { status: 'Released', release_dates: { results: [] } };
    assert.equal(initialReleaseState(film, {}, '2026-11-08', { notified: true }).notified, true);
});
