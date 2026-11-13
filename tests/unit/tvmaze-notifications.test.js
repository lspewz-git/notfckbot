/**
 * Series notifications by TVmaze's air times: the update check rewrites TMDB's details with
 * withTvmaze() (src/episode-times.js) and notifyNewEpisodes() goes by them. TMDB's season lists
 * are stubbed. Run: node --test tests/unit/tvmaze-notifications.test.js
 */
const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');

const tmdb = require('../../src/api/tmdb');
mock.method(require('../../src/db').Chat, 'findByPk', async () => null);
mock.method(require('../../src/db').SendFailure, 'create', async () => {});
mock.method(require('../../src/db').SendFailure, 'destroy', async () => 0);

// Series 1: season 1 of four weekly episodes from 5 November, season 2 from 3 December (TMDB's US days)
const SEASONS = {
    1: [
        ['2026-11-05', 1, 'Пилот'],
        ['2026-11-12', 2, 'Вторая'],
        ['2026-11-19', 3, 'Третья'],
        ['2026-11-26', 4, 'Финал']
    ],
    2: [['2026-12-03', 1, 'Возвращение']]
};
mock.method(tmdb, 'getSeasonDetailsCached', async (id, season) => ({
    episodes: (SEASONS[season] || []).map(([air_date, episode_number, name]) => ({ air_date, episode_number, name }))
}));

const { notifyNewEpisodes } = require('../../src/cron');
const { withTvmaze } = require('../../src/episode-times');
const { fakeBot, fakeSeries, kindOf } = require('./fakes');

const ep = (season, episode) => ({
    season_number: season,
    episode_number: episode,
    name: SEASONS[season][episode - 1][2],
    air_date: SEASONS[season][episode - 1][0]
});
const details = (last, next) => ({
    id: 1,
    last_episode_to_air: last,
    next_episode_to_air: next,
    seasons: [
        { season_number: 1, episode_count: 4 },
        { season_number: 2, episode_count: 8 }
    ]
});
// TVmaze: each one at 01:00 UTC the day after TMDB's (21:00 in New York), 55 minutes long
const TIMES = {};
for (const [season, list] of Object.entries(SEASONS)) {
    for (const [day, episode] of list) {
        const next = new Date(Date.parse(`${day}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
        TIMES[`${season}:${episode}`] = { stamp: Date.parse(`${next}T01:00:00Z`), date: day, runtime: 55 };
    }
}
const kinds = (bot) => bot.sent.map((m) => `${m.chatId}:${kindOf(m.text)}`);
const check = async (bot, show, data, times, iso) =>
    notifyNewEpisodes(bot, show, await withTvmaze(data, times, Date.parse(iso)));

describe('by TVmaze', () => {
    test('out by TVmaze, not yet moved by TMDB: announced with its Russian name, and recorded', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 1, last_episode: 1, completed_season: 0 }, [[10, 'episode']]);
        await check(bot, show, details(ep(1, 1), ep(1, 2)), TIMES, '2026-11-13T03:00:00Z');
        assert.deepEqual(kinds(bot), ['10:episode']);
        assert.match(bot.sent[0].text, /Сезон 1, Серия 2: Вторая/);
        assert.deepEqual([show.last_season, show.last_episode], [1, 2]);

        // TMDB moves it the next check: nothing again
        await check(bot, show, details(ep(1, 2), ep(1, 3)), TIMES, '2026-11-13T09:00:00Z');
        assert.equal(bot.sent.length, 1);
    });

    test('still airing (before its end): not yet', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 1, last_episode: 1, completed_season: 0 }, [[10, 'episode']]);
        await check(bot, show, details(ep(1, 1), ep(1, 2)), TIMES, '2026-11-13T01:50:00Z');
        assert.equal(bot.sent.length, 0);
        await check(bot, show, details(ep(1, 1), ep(1, 2)), TIMES, '2026-11-13T02:00:00Z');
        assert.deepEqual(kinds(bot), ['10:episode']);
    });

    test('the finale out by TVmaze while TMDB still lists it as next: "the whole season is out"', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 1, last_episode: 3, completed_season: 0 }, [
            [10, 'season'],
            [11, 'episode']
        ]);
        await check(bot, show, details(ep(1, 3), ep(1, 4)), TIMES, '2026-11-27T03:00:00Z');
        assert.deepEqual(kinds(bot).sort(), ['10:complete', '11:episode']);
        assert.equal(show.completed_season, 1);
    });

    test('the last episode TMDB lists is out, TVmaze has the next one a week on: not "the whole season is out"', async () => {
        // TMDB lists only the announced episodes; before, it added E5 during the day it took to move E4
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 1, last_episode: 3, completed_season: 0 }, [
            [10, 'season'],
            [11, 'episode'],
            [12, 'first_and_full']
        ]);
        const more = {
            ...TIMES,
            '1:5': { stamp: Date.parse('2026-12-04T01:00:00Z'), date: '2026-12-03', runtime: 55 }
        };
        await check(bot, show, details(ep(1, 3), ep(1, 4)), more, '2026-11-27T03:00:00Z');
        assert.deepEqual(kinds(bot), ['11:episode']);
        assert.deepEqual([show.last_episode, show.completed_season], [4, 0]);
    });

    test('TVmaze\'s next episode is out but TMDB hasn\'t listed it yet: still not "the whole season is out"', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 1, last_episode: 4, completed_season: 0 }, [[10, 'season']]);
        const more = {
            ...TIMES,
            '1:5': { stamp: Date.parse('2026-12-04T01:00:00Z'), date: '2026-12-03', runtime: 55 }
        };
        await check(bot, show, details(ep(1, 4), null), more, '2026-12-05T03:00:00Z');
        assert.equal(bot.sent.length, 0);
        // TMDB never adds it: the season is complete once the grace is over
        await check(bot, show, details(ep(1, 4), null), more, '2026-12-08T03:00:00Z');
        assert.deepEqual(kinds(bot), ['10:complete']);
    });

    test('TVmaze numbers on past the finale while TMDB\'s next is the new season: "the whole season is out"', async () => {
        // TVmaze's 1:5 is TMDB's 2:1, a week after the finale
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 1, last_episode: 3, completed_season: 0 }, [[10, 'season']]);
        const on = { ...TIMES, '1:5': { stamp: Date.parse('2026-12-04T01:00:00Z'), date: '2026-12-03', runtime: 55 } };
        await check(bot, show, details(ep(1, 3), ep(2, 1)), on, '2026-11-27T03:00:00Z');
        assert.deepEqual(kinds(bot), ['10:complete']);
    });

    test('the row ahead by TVmaze, then a check with TMDB alone: nothing sent, the row stays', async () => {
        // S2E1 went out by TVmaze; TVmaze then doesn't answer and TMDB's last is still S1E4
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 2, last_episode: 1, completed_season: 0 }, [
            [10, 'season'],
            [11, 'episode']
        ]);
        await check(bot, show, details(ep(1, 4), ep(2, 1)), null, '2026-12-04T03:00:00Z');
        assert.equal(bot.sent.length, 0);
        assert.deepEqual([show.last_season, show.last_episode], [2, 1]);
        // TVmaze answers again: S2E1 is not announced a second time
        await check(bot, show, details(ep(1, 4), ep(2, 1)), TIMES, '2026-12-04T06:00:00Z');
        assert.equal(bot.sent.length, 0);
    });

    test('a day-only episode (streaming) waits for its day to end; TMDB moving it first still sends it', async () => {
        const untimed = {
            ...TIMES,
            '1:2': { stamp: Date.parse('2026-11-12T12:00:00Z'), date: '2026-11-12', runtime: 47, timed: false }
        };
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 1, last_episode: 1, completed_season: 0 }, [[10, 'episode']]);
        await check(bot, show, details(ep(1, 1), ep(1, 2)), untimed, '2026-11-12T15:00:00Z');
        assert.equal(bot.sent.length, 0, 'not at the 12:00 UTC stand-in');
        await check(bot, show, details(ep(1, 2), ep(1, 3)), untimed, '2026-11-13T09:00:00Z');
        assert.deepEqual(kinds(bot), ['10:episode']);
    });

    test("a new season's premiere by TVmaze", async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 1, last_episode: 4, completed_season: 1 }, [[10, 'first_and_full']]);
        await check(bot, show, details(ep(1, 4), ep(2, 1)), TIMES, '2026-12-04T02:00:00Z');
        assert.deepEqual(kinds(bot), ['10:premiere']);
        assert.deepEqual([show.last_season, show.last_episode], [2, 1]);
    });

    test('TVmaze unknown or silent: TMDB alone, as before', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 1, last_episode: 1, completed_season: 0 }, [[10, 'episode']]);
        await check(bot, show, details(ep(1, 1), ep(1, 2)), null, '2026-11-13T03:00:00Z');
        assert.equal(bot.sent.length, 0);
        await check(bot, show, details(ep(1, 2), ep(1, 3)), null, '2026-11-13T09:00:00Z');
        assert.deepEqual(kinds(bot), ['10:episode']);
    });

    test("a new season TMDB lists undated past E1, TVmaze's same numbers aired long ago: nothing announced", async () => {
        // Split-cour numbering: TVmaze's season 2 aired in full a year ago; TMDB dates only S2E1 (ahead)
        const saved = SEASONS[2];
        SEASONS[2] = [
            ['2026-12-03', 1, 'Возвращение'],
            [null, 2, 'Эпизод 2'],
            [null, 3, 'Эпизод 3']
        ];
        try {
            const bot = fakeBot();
            const show = fakeSeries({ last_season: 1, last_episode: 4, completed_season: 1 }, [
                [10, 'episode'],
                [11, 'first_and_full']
            ]);
            const old = {
                '2:1': { stamp: Date.parse('2025-10-02T01:00:00Z'), date: '2025-10-01', runtime: 24 },
                '2:2': { stamp: Date.parse('2025-10-09T01:00:00Z'), date: '2025-10-08', runtime: 24 },
                '2:3': { stamp: Date.parse('2025-10-16T01:00:00Z'), date: '2025-10-15', runtime: 24 }
            };
            const data = { ...details(ep(1, 4), { season_number: 2, episode_number: 1, air_date: '2026-12-03' }) };
            data.seasons = [
                { season_number: 1, episode_count: 4 },
                { season_number: 2, episode_count: 3 }
            ];
            await check(bot, show, data, old, '2026-11-20T00:00:00Z');
            assert.equal(bot.sent.length, 0);
            assert.deepEqual([show.last_season, show.last_episode, show.completed_season], [1, 4, 1]);
        } finally {
            SEASONS[2] = saved;
        }
    });

    test('TVmaze numbers differently (days off): TMDB decides', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 1, last_episode: 1, completed_season: 0 }, [[10, 'episode']]);
        const off = { '1:2': { stamp: Date.parse('2026-11-06T01:00:00Z'), date: '2026-11-05', runtime: 55 } };
        await check(bot, show, details(ep(1, 1), ep(1, 2)), off, '2026-11-07T00:00:00Z');
        assert.equal(bot.sent.length, 0);
    });
});
