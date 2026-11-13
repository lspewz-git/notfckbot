/**
 * When episodes come out (src/episode-times.js): TVmaze's time for the same episode only, the
 * chat's day of it, the moment it counts as out, and TMDB's details rewritten by those times.
 * TMDB's season lists are stubbed. Run: node --test tests/unit/episode-times.test.js
 */
const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');

const tmdb = require('../../src/api/tmdb');

// Season 1 of series 50: weekly from 12 November (TMDB's US days)
const SEASON = [
    ['2026-11-12', 1, 'Первая'],
    ['2026-11-12', 2, 'Вторая'],
    ['2026-11-19', 3, 'Третья'],
    ['2026-11-26', 4, 'Четвёртая']
];
mock.method(tmdb, 'getSeasonDetailsCached', async (id, season) => {
    if (id !== '50' || season !== 1) return { episodes: [] };
    return { episodes: SEASON.map(([air_date, episode_number, name]) => ({ air_date, episode_number, name })) };
});

const tvmaze = require('../../src/api/tvmaze');
const { timeOf, releaseDay, outAt, withTvmaze, nextDayIn } = require('../../src/episode-times');

const at = (iso) => Date.parse(iso);
const time = (iso, runtime = 50) => ({ stamp: at(iso), date: iso.slice(0, 10), runtime });

describe('one episode', () => {
    test("TVmaze's time counts for an episode TMDB dates within a day of it, not further", () => {
        const times = { '1:2': time('2026-11-13T01:00:00Z'), '1:3': time('2026-11-21T01:00:00Z') };
        assert.ok(timeOf(times, 1, 2, '2026-11-12'));
        assert.equal(timeOf(times, 1, 3, '2026-11-19'), null, 'two days apart: numbered differently');
        assert.equal(timeOf(times, 1, 4, '2026-11-26'), null, 'not on TVmaze');
        assert.equal(timeOf(times, 1, 2, null), null, 'TMDB without a date: nothing to check the numbers by');
        assert.equal(timeOf(null, 1, 2, '2026-11-12'), null);
    });

    test("the chat's day of the moment; a bare day stays as it is", () => {
        const t = time('2026-11-12T21:00:00Z');
        assert.equal(releaseDay(t, 'Europe/Moscow'), '2026-11-13');
        assert.equal(releaseDay(t, 'Europe/Kaliningrad'), '2026-11-12');
        assert.equal(releaseDay({ stamp: null, date: '2026-11-20', runtime: null }, 'Asia/Kamchatka'), '2026-11-20');
        // Streaming, no time of day: TVmaze's 12:00 UTC stand-in would be the next day in Kamchatka
        const untimed = { ...time('2026-11-13T12:00:00Z'), timed: false };
        assert.equal(releaseDay(untimed, 'Asia/Kamchatka'), '2026-11-13');
        assert.equal(releaseDay({ ...untimed, timed: true }, 'Asia/Kamchatka'), '2026-11-14');
    });

    test('out once aired in full: its length, an hour when unknown; a bare day, once over everywhere', () => {
        assert.equal(outAt(time('2026-11-13T01:00:00Z', 50)), at('2026-11-13T01:50:00Z'));
        assert.equal(outAt(time('2026-11-13T01:00:00Z', null)), at('2026-11-13T02:00:00Z'));
        assert.equal(outAt({ stamp: null, date: '2026-11-20', runtime: null }), at('2026-11-21T12:00:00Z'));
    });

    test("no time of day (streaming): out once its day is over everywhere, not at the stand-in's noon", () => {
        // A service may put it up in the US evening, 01:00–04:00 UTC the next day
        const untimed = { stamp: at('2026-11-13T12:00:00Z'), date: '2026-11-13', runtime: 47, timed: false };
        assert.equal(outAt(untimed), at('2026-11-14T12:00:00Z'));
        assert.equal(outAt({ ...untimed, timed: true }), at('2026-11-13T12:47:00Z'));
    });

    test("a day apart while TVmaze's neighbouring number airs on TMDB's day: the neighbour, not the same episode", () => {
        // A daily show TVmaze numbers one ahead: TMDB's E5 is on the 12th, E6 on the 13th
        const times = {
            '1:5': time('2026-11-11T18:00:00Z'),
            '1:6': time('2026-11-12T18:00:00Z'),
            '1:7': time('2026-11-13T18:00:00Z')
        };
        assert.equal(timeOf(times, 1, 5, '2026-11-12'), null);
        assert.equal(timeOf(times, 1, 6, '2026-11-13'), null);
        // A weekly show a day apart keeps its time: the neighbours are a week away
        const weekly = { '1:5': time('2026-11-11T18:00:00Z'), '1:6': time('2026-11-18T18:00:00Z') };
        assert.ok(timeOf(weekly, 1, 5, '2026-11-12'));
        // The same day: two episodes out together stay matched
        const pair = { '1:1': time('2026-11-12T01:00:00Z'), '1:2': time('2026-11-12T02:00:00Z') };
        assert.ok(timeOf(pair, 1, 1, '2026-11-12'));
        assert.ok(timeOf(pair, 1, 2, '2026-11-12'));
    });
});

describe("TMDB's details by TVmaze's times", () => {
    const details = (last, next) => ({
        id: 50,
        name: 'Сериал',
        last_episode_to_air: last && { season_number: 1, episode_number: last, name: SEASON[last - 1][2] },
        next_episode_to_air: next && { season_number: 1, episode_number: next, air_date: SEASON[next - 1][0] }
    });
    // Episodes 1 and 2 at 01:00 UTC on the 13th (21:00 the 12th in New York), 3 a week later
    const times = {
        '1:1': time('2026-11-13T01:00:00Z'),
        '1:2': time('2026-11-13T01:00:00Z'),
        '1:3': time('2026-11-20T01:00:00Z'),
        '1:4': time('2026-11-27T01:00:00Z')
    };

    test('out by TVmaze before TMDB moves it: the last aired is the latest out, with its Russian name', async () => {
        const out = await withTvmaze(details(null, 1), times, at('2026-11-13T02:00:00Z'));
        assert.equal(out.last_episode_to_air.episode_number, 2);
        assert.equal(out.last_episode_to_air.name, 'Вторая');
        assert.deepEqual(
            [out.next_episode_to_air.episode_number, out.next_episode_to_air.air_date],
            [3, '2026-11-20'],
            "the next one on its TVmaze day in the bot's zone"
        );
    });

    test('not out yet by TVmaze: nothing moves; the next one still gets its TVmaze day', async () => {
        const out = await withTvmaze(details(null, 1), times, at('2026-11-13T01:30:00Z'));
        assert.equal(out.last_episode_to_air, null);
        assert.deepEqual([out.next_episode_to_air.episode_number, out.next_episode_to_air.air_date], [1, '2026-11-13']);
        const vladivostok = await withTvmaze(details(null, 1), times, at('2026-11-13T01:30:00Z'), 'Asia/Vladivostok');
        assert.equal(vladivostok.next_episode_to_air.air_date, '2026-11-13');
    });

    test("never behind TMDB: its own last stays when TVmaze doesn't know the later ones", async () => {
        const out = await withTvmaze(details(3, 4), { '1:1': times['1:1'] }, at('2026-11-21T00:00:00Z'));
        assert.equal(out.last_episode_to_air.episode_number, 3);
        assert.equal(out.next_episode_to_air.episode_number, 4);
        assert.equal(out.next_episode_to_air.air_date, '2026-11-26', "TMDB's day where TVmaze has none");
    });

    test('the finale out by TVmaze: no next episode left in the season (the season is complete)', async () => {
        const out = await withTvmaze(details(3, 4), times, at('2026-11-27T03:00:00Z'));
        assert.equal(out.last_episode_to_air.episode_number, 4);
        assert.equal(out.next_episode_to_air, null);
    });

    test('numbered differently (days apart): TMDB stays', async () => {
        const shifted = { '1:3': time('2026-11-13T01:00:00Z') };
        const out = await withTvmaze(details(2, 3), shifted, at('2026-11-14T00:00:00Z'));
        assert.equal(out.last_episode_to_air.episode_number, 2);
        assert.equal(out.next_episode_to_air.air_date, '2026-11-19');
    });

    test('without times, or without episodes: the details as they are', async () => {
        const d = details(2, 3);
        assert.equal(await withTvmaze(d, null), d);
        // Nothing aired or announced: no season to read
        const bare = { id: 50, last_episode_to_air: null, next_episode_to_air: null };
        assert.equal(await withTvmaze(bare, times), bare);
        // TMDB doesn't answer for the season: as they are
        const other = {
            id: 51,
            last_episode_to_air: null,
            next_episode_to_air: { season_number: 1, episode_number: 1 }
        };
        assert.equal(await withTvmaze(other, times), other);
    });
});

describe("a series row's next episode in a chat's zone", () => {
    const row = { tmdb_id: 'tv_50', next_episode_date: '2026-11-13', next_episode_season: 1, next_episode_number: 3 };

    test("TVmaze's cached moment in the chat's zone; the stored day without it", () => {
        // 21:00 UTC on the 12th: the 13th in Moscow (stored), still the 12th in Kaliningrad
        const times = { '1:3': time('2026-11-12T21:00:00Z') };
        mock.method(tvmaze, 'cachedAirTimes', () => times);
        try {
            assert.equal(nextDayIn(row, 'Europe/Kaliningrad'), '2026-11-12');
            assert.equal(nextDayIn(row, 'Asia/Vladivostok'), '2026-11-13');
        } finally {
            tvmaze.cachedAirTimes.mock.restore();
        }
        mock.method(tvmaze, 'cachedAirTimes', () => undefined);
        try {
            assert.equal(nextDayIn(row, 'Europe/Kaliningrad'), '2026-11-13');
            assert.equal(nextDayIn({ ...row, next_episode_date: null }, 'Europe/Kaliningrad'), null);
        } finally {
            tvmaze.cachedAirTimes.mock.restore();
        }
    });
});
