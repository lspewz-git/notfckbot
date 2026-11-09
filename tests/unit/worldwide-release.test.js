const { test } = require('node:test');
const assert = require('node:assert/strict');
const { worldwideRelease, releaseDate, isReleased } = require('../../src/film-release');
const { buildFilmMessage } = require('../../src/cron/messages');

// Ten markets across North America, Europe and Asia; no mandatory country.
const markets = ['US', 'CA', 'MX', 'FR', 'DE', 'GB', 'JP', 'KR', 'CN', 'TW'];
const wave = (codes = markets, date = '2026-11-01', type = 3) => codes.map((country) => [country, type, date]);
const movie = (events) => ({
    status: 'Released',
    origin_country: ['US'],
    release_dates: {
        results: events.map(([country, type, date]) => ({
            iso_3166_1: country,
            release_dates: [{ type, release_date: date }]
        }))
    }
});
const message = (data) => buildFilmMessage({ entry: { title: 'Film' }, data, links: '' });

test('exactly ten markets across three regions qualify; nine markets do not', () => {
    const data = movie(wave());
    assert.deepEqual(worldwideRelease(data), { date: '2026-11-01', countries: [...markets].sort() });
    assert.match(message(data), /1 ноября 2026 г\.<\/b> \(мировой прокат\)/);
    assert.equal(worldwideRelease(movie(wave(markets.slice(1)))), null);
});

test('ten markets in one or two regions do not qualify', () => {
    const europe = ['FR', 'DE', 'GB', 'IT', 'ES', 'PT', 'BE', 'NL', 'AT', 'PL'];
    assert.equal(worldwideRelease(movie(wave(europe))), null);
    assert.equal(worldwideRelease(movie(wave([...europe.slice(0, 7), 'US', 'CA', 'MX']))), null);
});

test('no mandatory US, China or Russia market; Africa, South America and Oceania count', () => {
    const codes = ['ZA', 'EG', 'MA', 'NG', 'BR', 'AR', 'CL', 'PE', 'AU', 'NZ'];
    assert.equal(worldwideRelease(movie(wave(codes))).countries.length, 10);
});

test('a seven-calendar-day window includes start plus six days, across a month boundary', () => {
    const firstNine = wave(markets.slice(0, 9), '2026-10-29');
    const inside = movie([...firstNine, ['TW', 3, '2026-11-04T23:59:59Z']]);
    assert.equal(worldwideRelease(inside).date, '2026-10-29');
    assert.equal(worldwideRelease(movie([...firstNine, ['TW', 3, '2026-11-05']])), null);
});

test('duplicate countries, unknown codes and Antarctica cannot meet thresholds', () => {
    assert.equal(worldwideRelease(movie(Array(10).fill(['US', 3, '2026-11-01']))), null);
    const nine = wave(markets.slice(0, 9));
    for (const code of ['ZZ', 'AQ', '__proto__', null]) {
        assert.equal(worldwideRelease(movie([...nine, [code, 3, '2026-11-01']])), null);
    }
});

test('premieres, limited, digital, physical and TV events never qualify', () => {
    for (const type of [1, 2, 4, 5, 6]) {
        const data = movie(wave(markets, '2026-11-01', type));
        assert.equal(worldwideRelease(data), null);
        assert.doesNotMatch(message(data), /мировой прокат/);
    }
});

test('missing and invalid exact dates cannot qualify', () => {
    assert.equal(worldwideRelease({}), null);
    for (const date of ['2026-11', '2026-02-30', null]) {
        assert.equal(worldwideRelease(movie(wave(markets, date))), null);
    }
});

test('finds a later qualifying wave without relabelling an earlier limited or wide release', () => {
    for (const type of [2, 3]) {
        const data = movie([['BE', type, '2026-10-01'], ...wave()]);
        assert.equal(worldwideRelease(data).date, '2026-11-01');
        assert.equal(releaseDate(data).date, '2026-10-01');
        assert.equal(isReleased(data, {}, '2026-09-30'), false);
        assert.equal(isReleased(data, {}, '2026-10-01'), true);
        assert.match(message(data), /1 октября 2026 г\.<\/b> \(Бельгия\)/);
        assert.doesNotMatch(message(data), /мировой прокат/);
    }
});

test('a later Russian main release is not relabelled with an earlier worldwide wave', () => {
    const data = { ...movie([...wave(), ['RU', 3, '2026-11-20']]), origin_country: ['RU'] };
    assert.equal(releaseDate(data).date, '2026-11-20');
    assert.match(message(data), /20 ноября 2026 г\.<\/b> \(Россия\)/);
    assert.doesNotMatch(message(data), /мировой прокат/);
});
