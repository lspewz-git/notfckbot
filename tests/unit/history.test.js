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
// The year ahead (the calendar's episode lists): season 5 of 1 dated with no episodes yet,
// season 3 of 6 with its episodes listed
const UPCOMING_SEASONS = {
    1: [{ season_number: 5, air_date: '2027-06-01', episode_count: 0 }],
    6: [{ season_number: 3, air_date: '2027-03-01', episode_count: 2 }]
};
const EPISODE_LISTS = { '6:3': ['2027-03-01', '2027-03-08'] };
mock.method(tmdb, 'getSeasonDetailsCached', async (id, season) => ({
    episodes: (EPISODE_LISTS[`${id}:${season}`] || []).map((air_date, i) => ({ episode_number: i + 1, air_date }))
}));
mock.method(tmdb, 'getDetailsCached', async (id, type) => {
    if (tmdbStuck) await new Promise(() => {});
    const seasons = (type === 'tv' && UPCOMING_SEASONS[id]) || [];
    return { genres: (GENRES[`${type}:${id}`] || []).map((name) => ({ name })), seasons };
});
// Kinopoisk: only film 7's ID is known
mock.method(kinopoisk, 'knownKinopoiskId', (tmdbId) => (tmdbId === 'movie_7' ? 777 : null));

const { ensureReleaseSeasons } = require('../../src/cron/release-seasons');
const { releaseHistory } = require('../../src/history');
const { historyView, yearView, register } = require('../../src/bot/history');
const { todayIn } = require('../../src/calendar');
const { upcomingHistory } = require('../../src/history');

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

    test('serials, then films; each title a link; last year, this year, the next; the tabs', () => {
        const view = historyView({
            thisYear: 2026,
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
        assert.deepEqual(buttons(view), [
            ['2025 ✓', '2026', '2027'],
            ['Неделя', 'Месяц', '✅ Год'],
            ['⬅️ К подпискам']
        ]);
    });

    test("a list that would pass Telegram's 4096 characters is cut, saying how many are left", () => {
        const many = Array.from({ length: 200 }, (_, i) => item(`Сериал номер ${i}`, ['драма', 'криминал']));
        const view = historyView({ thisYear: 2026, year: 2026, series: many, films: [] });
        assert.ok(view.text.length < 4096, String(view.text.length));
        assert.match(view.text, /…и ещё \d+ — полный список в панели/);
    });

    test('nothing that year: says so, in the tense of the year; no way back when asked', () => {
        const empty = (year, options) => historyView({ thisYear: 2026, year, series: [], films: [] }, options);
        assert.match(empty(2025).text, /В 2025 у подписок ничего не выходило\./);
        assert.match(empty(2026).text, /В 2026 у подписок пока ничего не выходило\./);
        assert.match(empty(2027).text, /^🗓 <b>Выйдет в 2027<\/b>\n\nНа 2027 у подписок пока ничего не объявлено\./);
        assert.deepEqual(buttons(empty(2026, { back: false })), [
            ['2025', '2026 ✓', '2027'],
            ['Неделя', 'Месяц', '✅ Год']
        ]);
    });

    test('this year: what is still to come, after what came out, marked serial or film', () => {
        const view = historyView({
            thisYear: 2026,
            year: 2026,
            series: [item('Пацаны', ['драма'], [5])],
            films: [],
            later: { series: [item('Темная материя', [], [2])], films: [item('Шрэк 5', [])] }
        });
        assert.match(view.text, /📺 <b>Сериалы<\/b>\n<a [^>]+>Пацаны<\/a>/);
        assert.match(
            view.text,
            /⏳ <b>Ещё выйдет в 2026<\/b>\n📺 <a [^>]+>Темная материя<\/a> · сезон 2\n🎬 <a [^>]+>Шрэк 5<\/a>\n/
        );
        // Nothing out yet, something to come: both said
        const early = historyView({
            thisYear: 2026,
            year: 2026,
            series: [],
            films: [],
            later: { series: [], films: [item('Шрэк 5', [])] }
        });
        assert.match(early.text, /пока ничего не выходило\.\n\n⏳ <b>Ещё выйдет в 2026<\/b>/);
    });

    test('a long year: what is still to come keeps its room, what came out is cut', () => {
        const many = Array.from({ length: 200 }, (_, i) => item(`Сериал номер ${i}`, ['драма', 'криминал']));
        const coming = Array.from({ length: 5 }, (_, i) => item(`Скоро ${i}`));
        const view = historyView({
            thisYear: 2026,
            year: 2026,
            series: many,
            films: [],
            later: { series: coming, films: [] }
        });
        assert.ok(view.text.length < 4096, String(view.text.length));
        assert.equal((view.text.match(/>Скоро \d<\/a>/g) || []).length, 5);
        // What came out: serials before films, as before; no heading left without lines
        const films = historyView({ thisYear: 2026, year: 2026, series: many, films: [item('Дюна', [])] });
        assert.doesNotMatch(films.text, /Фильмы/);
        assert.match(films.text, />Сериал номер 0<\/a>/);
        assert.match(view.text, /…и ещё \d+ — полный список в панели/);
        // Next year's list is not in the panel: no pointing there
        const ahead = historyView({ thisYear: 2026, year: 2027, series: many, films: [] });
        assert.match(ahead.text, /…и ещё \d+\.<\/i>/);
    });

    test('titles are escaped', () => {
        const view = historyView({ thisYear: 2026, year: 2026, series: [item('A <b> & C')], films: [] });
        assert.match(view.text, />A &lt;b&gt; &amp; C<\/a>/);
    });
});

describe('the year view', () => {
    const SERIES = [
        // Episodes out this year, season 5 announced for next year with no episodes listed yet
        { tmdb_id: 'tv_1', title: 'Пацаны', kinopoisk_id: 435, release_seasons: '2026:4', last_season: 4 },
        // Nothing this year; the next episode is dated next year
        {
            tmdb_id: 'tv_2',
            title: 'Аббатство',
            kinopoisk_id: null,
            release_seasons: '2023:1',
            next_episode_date: '2027-02-01',
            next_episode_season: 2
        },
        // Episodes of season 3 listed for next year
        { tmdb_id: 'tv_6', title: 'Дом', kinopoisk_id: null, release_seasons: '2024:2', last_season: 3 }
    ];
    const FILMS = [
        { tmdb_id: 'movie_7', title: 'Дюна', premiere_digital: '2026-03-01' },
        { tmdb_id: 'movie_8', title: 'Будущее', premiere_digital: '2027-05-01' }
    ];
    beforeEach(() => {
        mock.method(Subscription, 'findAll', async () => SERIES.map((s) => ({ Series: s })));
        mock.method(Watchlist, 'findAll', async () => FILMS);
    });

    test('next year: episodes listed, a season dated, a next episode; films by their premiere', async () => {
        const h = await upcomingHistory({ chatId: 1, year: 2027 });
        assert.deepEqual(
            h.series.map((s) => `${s.title} ${s.seasons.join(',')}`),
            ['Аббатство 2', 'Дом 3', 'Пацаны 5']
        );
        assert.deepEqual(
            h.films.map((f) => f.title),
            ['Будущее']
        );
    });

    test('the three years around the chat\'s own; anything else is this year; next year says "Выйдет"', async () => {
        const chat = { id: 1, timezone: 'Europe/Moscow' };
        const title = async (year) => (await yearView(chat, year, { now })).text.split('\n')[0];
        assert.equal(await title(null), '🗓 <b>Вышло в 2026</b>');
        assert.equal(await title(2024), '🗓 <b>Вышло в 2026</b>');
        assert.equal(await title(2027), '🗓 <b>Выйдет в 2027</b>');
        // Nothing out in 2025 among these: empty, not another year instead
        assert.match((await yearView(chat, 2025, { now })).text, /В 2025 у подписок ничего не выходило/);
    });

    test('from a digest in a group where only the owner presses: no way back', async () => {
        const view = await yearView({ id: -5, buttons_mode: 'owner' }, 2026, { digest: true, now });
        assert.ok(!view.keyboard.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'subs_o'));
    });

    test('this year: out so far from the history, the rest of the year from today on', async () => {
        const chat = { id: 1, timezone: 'Europe/Moscow' };
        // 14 October 2026: season 3 of Дом starts in March 2027, Будущее comes out in 2027
        const view = await yearView(chat, 2026, { now: new Date('2026-10-14T09:00:00Z') });
        assert.match(view.text, /^🗓 <b>Вышло в 2026<\/b>/);
        assert.match(view.text, />Пацаны<\/a> · сезон 4/);
        assert.doesNotMatch(view.text, /Ещё выйдет/, 'nothing left this year among these');
        EPISODE_LISTS['6:3'] = ['2026-12-01', '2027-03-08'];
        try {
            const later = await yearView(chat, 2026, { now: new Date('2026-10-14T09:00:00Z') });
            assert.match(later.text, /⏳ <b>Ещё выйдет в 2026<\/b>\n📺 <a [^>]+>Дом<\/a> · сезон 3/);
        } finally {
            EPISODE_LISTS['6:3'] = ['2027-03-01', '2027-03-08'];
        }
    });

    test('this year: a film out today is out, not also to come; a TMDB failure is said of what is to come', async () => {
        const chat = { id: 1, timezone: 'Europe/Moscow' };
        const today = new Date('2027-05-01T09:00:00Z'); // Будущее comes out today
        const view = await yearView(chat, 2027, { now: today });
        assert.match(view.text, /🎬 <b>Фильмы<\/b>\n<a [^>]+>Будущее<\/a>/);
        assert.doesNotMatch(view.text, /🎬 <a [^>]+>Будущее/);
        const failed = historyView({ thisYear: 2026, year: 2026, series: [], films: [], later: null, failed: 2 });
        assert.match(failed.text, /TMDB не ответил по 2 сериалам — в «Ещё выйдет» их нет/);
    });

    test('a year button: answered at once; a digest stays without the way back; an unknown year is this one', async () => {
        let handler;
        register({ command() {}, action: (trigger, fn) => (handler = fn) });
        const thisYear = Number(todayIn('Europe/Moscow').slice(0, 4));
        const press = async (data, chat, keyboard) => {
            const calls = [];
            const ctx = {
                match: [data, data.slice(5)],
                state: { chatData: chat },
                callbackQuery: { message: { reply_markup: { inline_keyboard: keyboard } } },
                answerCbQuery: async () => calls.push('answered'),
                editMessageText: async (text, extra) => calls.push({ text, extra })
            };
            await handler(ctx);
            return calls;
        };
        const backIn = (extra) => extra.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'subs_o');

        const digest = await press(`hist_${thisYear + 1}`, { id: -5, buttons_mode: 'owner' }, [
            [{ callback_data: 'cal_w_1' }]
        ]);
        assert.equal(digest[0], 'answered');
        assert.match(digest[1].text, new RegExp(`^🗓 <b>Выйдет в ${thisYear + 1}</b>`));
        assert.equal(backIn(digest[1].extra), false);

        const menu = await press('hist_1999', { id: 7 }, [[{ callback_data: 'subs_o' }]]);
        assert.match(menu[1].text, new RegExp(`^🗓 <b>Вышло в ${thisYear}</b>`));
        assert.equal(backIn(menu[1].extra), true);
    });
});
