/**
 * The release history: the years each series had an episode out and their seasons
 * (src/cron/release-seasons.js),
 * the list for a year (src/history.js) and the bot's message (src/bot/history.js).
 * TMDB and the database are stubbed. Run: npm run test:unit
 */
const { test, describe, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const tmdb = require('../../src/api/tmdb');
const kinopoisk = require('../../src/api/kinopoisk');
const { Series, Subscription, Watchlist } = require('../../src/db');

mock.method(console, 'log', () => {});
mock.method(console, 'error', () => {});

// --- TMDB: seasons with episode air dates, and genres ---
const SEASONS = {
    // Season 1 in 2023; season 2 runs from December 2024 into January 2025
    '1:1': ['2023-03-01', '2023-03-08'],
    '1:2': ['2024-12-20', '2025-01-10'],
    // Season 3 is announced but hasn't aired
    '1:3': ['2099-01-01']
};
let seasonRequests = [];
mock.method(tmdb, 'getSeasonDetails', async (id, season) => {
    seasonRequests.push(`${id}:${season}`);
    const dates = SEASONS[`${id}:${season}`];
    if (!dates) throw new Error('TMDB down');
    return { episodes: dates.map((air_date, i) => ({ episode_number: i + 1, air_date })) };
});
const GENRES = { 'tv:1': ['Драма', 'Криминал', 'Боевик'], 'tv:2': ['Комедия'], 'movie:7': ['Фантастика'] };
// Set by a test: TMDB takes the request and never answers
let tmdbStuck = false;
mock.method(tmdb, 'getDetailsCached', async (id, type) => {
    if (tmdbStuck) await new Promise(() => {});
    return { genres: (GENRES[`${type}:${id}`] || []).map((name) => ({ name })) };
});
// Kinopoisk: only film 7's ID is known
mock.method(kinopoisk, 'knownKinopoiskId', (tmdbId) => (tmdbId === 'movie_7' ? 777 : null));

const { ensureReleaseSeasons } = require('../../src/cron/release-seasons');
const { releaseHistory } = require('../../src/history');
const { historyView } = require('../../src/bot/history');

const now = new Date('2026-10-12T12:00:00Z');
const seriesRow = (fields) => ({
    async update(changes) {
        Object.assign(this, changes);
    },
    ...fields
});
const DETAILS = {
    seasons: [
        { season_number: 0, episode_count: 5 }, // specials: left out
        { season_number: 1, episode_count: 2 },
        { season_number: 2, episode_count: 2 },
        { season_number: 3, episode_count: 1 }
    ]
};

beforeEach(() => {
    seasonRequests = [];
});

describe('ensureReleaseSeasons', () => {
    test('the first time, every season is scanned; a season crossing New Year counts in both', async () => {
        const row = seriesRow({ tmdb_id: 'tv_1', release_seasons: null });
        await ensureReleaseSeasons(row, DETAILS, now);
        assert.equal(row.release_seasons, '2023:1;2024:2;2025:2');
        assert.deepEqual(seasonRequests, ['1:1', '1:2', '1:3'], 'specials are skipped');
    });

    test('afterwards only the latest aired episode is looked at: no more requests', async () => {
        const row = seriesRow({ tmdb_id: 'tv_1', release_seasons: '2023:1;2025:2' });
        await ensureReleaseSeasons(row, { last_episode_to_air: { air_date: '2026-04-01', season_number: 3 } }, now);
        assert.equal(row.release_seasons, '2023:1;2025:2;2026:3');
        // A second season in the same year joins the first
        await ensureReleaseSeasons(
            row,
            { last_episode_to_air: { air_date: '2026-11-01', season_number: 4 } },
            new Date('2026-12-01')
        );
        assert.equal(row.release_seasons, '2023:1;2025:2;2026:3,4');
        assert.deepEqual(seasonRequests, []);
    });

    test('two seasons in one year, from the scan', async () => {
        SEASONS['5:1'] = ['2025-02-01'];
        SEASONS['5:2'] = ['2025-11-01', '2026-01-05'];
        const row = seriesRow({ tmdb_id: 'tv_5', release_seasons: null });
        await ensureReleaseSeasons(
            row,
            {
                seasons: [
                    { season_number: 1, episode_count: 1 },
                    { season_number: 2, episode_count: 2 }
                ]
            },
            now
        );
        assert.equal(row.release_seasons, '2025:1,2;2026:2');
    });

    test('a series with nothing aired yet gets "" (scanned), not null (to scan again)', async () => {
        const row = seriesRow({ tmdb_id: 'tv_9', release_seasons: null });
        await ensureReleaseSeasons(row, { seasons: [] }, now);
        assert.equal(row.release_seasons, '');
    });

    test('a failed scan leaves the series to be scanned again', async () => {
        const row = seriesRow({ tmdb_id: 'tv_404', release_seasons: null });
        await assert.rejects(ensureReleaseSeasons(row, { seasons: [{ season_number: 1, episode_count: 3 }] }, now));
        assert.equal(row.release_seasons, null);
    });
});

describe('releaseHistory', () => {
    const SERIES = [
        { tmdb_id: 'tv_1', title: 'Пацаны', kinopoisk_id: 435, release_seasons: '2023:3;2026:4,5' },
        { tmdb_id: 'tv_2', title: 'Аббатство', kinopoisk_id: null, release_seasons: '2026:2' },
        { tmdb_id: 'tv_3', title: 'Старое шоу', kinopoisk_id: null, release_seasons: '2019:1' }
    ];
    const FILMS = [
        { tmdb_id: 'movie_7', title: 'Дюна', premiere_digital: '2026-03-01', chatId: 1 },
        { tmdb_id: 'movie_7', title: 'Дюна', premiere_digital: '2026-03-01', chatId: 2 }, // another chat's copy
        { tmdb_id: 'movie_8', title: 'Будущее', premiere_digital: '2099-01-01', chatId: 1 } // not out yet
    ];

    beforeEach(() => {
        mock.method(Series, 'findAll', async () => SERIES);
        mock.method(Watchlist, 'findAll', async () => FILMS);
    });

    test('only the last three years, and of those only the ones with releases; the latest shown', async () => {
        const h = await releaseHistory({ now });
        // 2026 has releases, 2025 and 2024 have none; 2023 and 2019 are older than three years
        assert.deepEqual(h.years, [2026]);
        assert.equal(h.year, 2026);
    });

    test('serials and films of that year, separately, by title; a film once whatever its copies', async () => {
        const h = await releaseHistory({ now });
        assert.deepEqual(
            h.series.map((s) => s.title),
            ['Аббатство', 'Пацаны']
        );
        assert.deepEqual(
            h.films.map((f) => f.title),
            ['Дюна']
        );
    });

    test('genres (two, lower case) and a Kinopoisk link: the page when the ID is known, else a search', async () => {
        const h = await releaseHistory({ now });
        const boys = h.series.find((s) => s.title === 'Пацаны');
        assert.deepEqual(boys.genres, ['драма', 'криминал']);
        assert.deepEqual(boys.seasons, [4, 5], 'the seasons out that year');
        assert.equal(h.films[0].seasons, undefined);
        assert.equal(boys.kinopoiskUrl, 'https://www.kinopoisk.ru/series/435/');
        const abbey = h.series.find((s) => s.title === 'Аббатство');
        assert.match(abbey.kinopoiskUrl, /kp_query=/);
        assert.equal(h.films[0].kinopoiskUrl, 'https://www.kinopoisk.ru/film/777/');
    });

    test('another year on request; one outside the three (or with nothing) falls back to the latest', async () => {
        mock.method(Series, 'findAll', async () => [
            ...SERIES,
            { tmdb_id: 'tv_4', title: 'Прошлогоднее', kinopoisk_id: null, release_seasons: '2025:1' }
        ]);
        const last = await releaseHistory({ year: 2025, now });
        assert.deepEqual(last.years, [2026, 2025]);
        assert.deepEqual(
            last.series.map((s) => s.title),
            ['Прошлогоднее']
        );
        assert.equal((await releaseHistory({ year: 2019, now })).year, 2026);
    });

    test('TMDB not answering: the list comes in about three seconds, without genres', async () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        tmdbStuck = true;
        try {
            const pending = releaseHistory({ now });
            for (let i = 0; i < 20; i++) await Promise.resolve(); // the queries and the race start
            mock.timers.tick(3000);
            const h = await pending;
            assert.deepEqual(
                h.series.map((s) => s.genres),
                [[], []]
            );
        } finally {
            tmdbStuck = false;
            mock.timers.reset();
        }
    });

    test('nothing in the last three years: no year at all', async () => {
        mock.method(Series, 'findAll', async () => [SERIES[2]]);
        mock.method(Watchlist, 'findAll', async () => []);
        const h = await releaseHistory({ now });
        assert.deepEqual([h.years, h.year, h.series, h.films], [[], null, [], []]);
    });

    test("for one chat: only that chat's subscriptions and films", async () => {
        mock.method(Subscription, 'findAll', async ({ where }) => (where.chatId === 1 ? [{ Series: SERIES[0] }] : []));
        mock.method(Watchlist, 'findAll', async ({ where }) => FILMS.filter((f) => f.chatId === where.chatId));
        const h = await releaseHistory({ chatId: 1, now });
        assert.deepEqual(
            h.series.map((s) => s.title),
            ['Пацаны']
        );
        assert.deepEqual(
            h.films.map((f) => f.title),
            ['Дюна']
        );
        assert.equal((await releaseHistory({ chatId: 2, now })).series.length, 0);
    });
});

describe('the bot message', () => {
    const item = (title, genres = ['драма'], seasons) => ({
        title,
        genres,
        seasons,
        kinopoiskUrl: 'https://www.kinopoisk.ru/series/1/'
    });
    const buttons = (view) => view.keyboard.reply_markup.inline_keyboard.map((row) => row.map((b) => b.text));

    test('serials, then films; each title a link; a button per year, oldest first', () => {
        const view = historyView({
            years: [2026, 2025, 2024],
            year: 2025,
            series: [item('Пацаны', ['драма'], [4, 5]), item('Аббатство', [], [2])],
            films: [item('Дюна', [])]
        });
        assert.match(view.text, /^🗓 <b>Вышло в 2025<\/b>/);
        assert.ok(view.text.indexOf('Сериалы') < view.text.indexOf('Фильмы'));
        assert.match(
            view.text,
            /<a href="https:\/\/www\.kinopoisk\.ru\/series\/1\/">Пацаны<\/a> · сезоны 4, 5 · драма\n/
        );
        assert.match(view.text, />Аббатство<\/a> · сезон 2\n/);
        assert.match(view.text, />Дюна<\/a>\n/);
        assert.deepEqual(buttons(view), [['2024', '2025 ✓', '2026'], ['⬅️ К подпискам']]);
    });

    test("a list that would pass Telegram's 4096 characters is cut, saying how many are left", () => {
        const many = Array.from({ length: 200 }, (_, i) => item(`Сериал номер ${i}`, ['драма', 'криминал']));
        const view = historyView({ years: [2026], year: 2026, series: many, films: [] });
        assert.ok(view.text.length < 4096, String(view.text.length));
        assert.match(view.text, /…и ещё \d+ — полный список в панели/);
    });

    test('nothing out yet: says so, with the way back', () => {
        const view = historyView({ years: [], year: null, series: [], films: [] });
        assert.match(view.text, /пока ничего не выходило/);
        assert.deepEqual(buttons(view), [['⬅️ К подпискам']]);
    });

    test('titles are escaped', () => {
        const view = historyView({ years: [2026], year: 2026, series: [item('A <b> & C')], films: [] });
        assert.match(view.text, />A &lt;b&gt; &amp; C<\/a>/);
    });
});
