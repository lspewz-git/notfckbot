/**
 * The bot's search screens: the results list (five per page, one button each) and the card a
 * result opens. Run: npm run test:unit
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { resultsList, seriesCard, filmCard, plural, PER_PAGE } = require('../../src/bot/search-views');

const buttons = (keyboard) => keyboard.reply_markup.inline_keyboard;
const labels = (keyboard) => buttons(keyboard).map((row) => row.map((b) => b.text));
const data = (keyboard) =>
    buttons(keyboard)
        .flat()
        .map((b) => b.callback_data || b.url);

const film = (id, title, date) => ({ media_type: 'movie', id, title, release_date: date });
const show = (id, name, date) => ({ media_type: 'tv', id, name, first_air_date: date });
// 12 results: pages of 5, 5 and 2
const RESULTS = [
    film(1, 'Курьер', '2026-12-18'),
    film(2, 'Курьер', '2019-11-08'),
    show(3, 'Курьер', '2023-01-01'),
    ...Array.from({ length: 9 }, (_, i) => film(10 + i, `Фильм ${i}`, '2001-01-01'))
];

describe('resultsList', () => {
    test('five results per page, each one button with its kind, name and year', () => {
        const list = resultsList(RESULTS, 0, 'курьер');
        assert.equal(PER_PAGE, 5);
        const rows = labels(list.keyboard);
        assert.deepEqual(rows.slice(0, 3), [['🎬 Курьер (2026)'], ['🎬 Курьер (2019)'], ['📺 Курьер (2023)']]);
        assert.equal(rows.length, PER_PAGE + 1, 'five results and the navigation row');
        assert.equal(list.text, '🔍 «курьер» — 12 вариантов. Выберите:');
    });

    test('a result opens its card', () => {
        const ids = data(resultsList(RESULTS, 0, 'q').keyboard);
        assert.deepEqual(ids.slice(0, 3), ['card_movie_1', 'card_movie_2', 'card_tv_3']);
    });

    test('the first page has no back arrow, the last no forward one; the middle has both', () => {
        assert.deepEqual(labels(resultsList(RESULTS, 0, 'q').keyboard).at(-1), ['1 / 3', '➡️', '✖️']);
        assert.deepEqual(labels(resultsList(RESULTS, 1, 'q').keyboard).at(-1), ['⬅️', '2 / 3', '➡️', '✖️']);
        assert.deepEqual(labels(resultsList(RESULTS, 2, 'q').keyboard).at(-1), ['⬅️', '3 / 3', '✖️']);
        assert.equal(buttons(resultsList(RESULTS, 2, 'q').keyboard).length, 3, 'two results on the last page');
    });

    test('one page needs no page counter; a page past the end shows the last one', () => {
        assert.deepEqual(labels(resultsList(RESULTS.slice(0, 2), 0, 'q').keyboard).at(-1), ['✖️']);
        assert.equal(resultsList(RESULTS, 9, 'q').page, 2);
    });

    test('long names are shortened so the year still shows; the query is escaped', () => {
        const long = film(5, 'Очень длинное название фильма, которое не поместится на кнопке', '2020-01-01');
        const [label] = labels(resultsList([long], 0, 'q').keyboard)[0];
        assert.match(label, /…\s?\(2020\)$/);
        assert.match(resultsList([long], 0, '<b>').text, /«&lt;b&gt;»/);
    });

    test("every button fits Telegram's 64-byte callback data", () => {
        const big = film(999999999, 'X', '2020-01-01');
        for (const id of data(resultsList([big, ...RESULTS], 1, 'q').keyboard)) {
            assert.ok(Buffer.byteLength(id) <= 64, id);
        }
    });

    test('Russian plurals', () => {
        assert.deepEqual(
            [1, 2, 5, 11, 21, 22, 112].map((n) => plural(n, 'вариант', 'варианта', 'вариантов')),
            ['вариант', 'варианта', 'вариантов', 'вариантов', 'вариант', 'варианта', 'вариантов']
        );
    });
});

const SERIES = {
    id: 100088,
    name: 'Одни из нас',
    first_air_date: '2023-01-15',
    number_of_seasons: 2,
    status: 'Returning Series',
    overview: 'Описание.',
    poster_path: '/p.jpg',
    next_episode_to_air: { season_number: 3, episode_number: 1, air_date: null }
};

describe('seriesCard', () => {
    test('seasons, status, the next episode, the modes and a way back', () => {
        const card = seriesCard(SERIES);
        assert.match(card.caption, /<b>Одни из нас<\/b> \(2023\)/);
        assert.match(card.caption, /Сериал · 2 сезона · идёт/);
        assert.match(card.caption, /Следующая серия: 3×1, <b>дата не объявлена<\/b>/);
        assert.match(card.caption, /Как уведомлять\?/);
        assert.deepEqual(data(card.keyboard), [
            'sub_set_tv_100088_episode',
            'sub_set_tv_100088_season',
            'sub_set_tv_100088_first_and_full',
            'back_to_results'
        ]);
        assert.equal(card.posterUrl, 'https://image.tmdb.org/t/p/w500/p.jpg');
    });

    test('already subscribed: says so, and the modes change it', () => {
        const card = seriesCard(SERIES, { subscribedMode: 'season' });
        assert.match(card.caption, /Вы уже подписаны: выход всего сезона/);
        assert.equal(data(card.keyboard).length, 4);
    });

    test('a finished show: a warning and "subscribe anyway", no next episode', () => {
        const card = seriesCard({ ...SERIES, status: 'Canceled' });
        assert.match(card.caption, /Сериал · 2 сезона · отменён/);
        assert.match(card.caption, /новых серий не будет/);
        assert.doesNotMatch(card.caption, /Следующая серия/);
        assert.deepEqual(labels(card.keyboard), [['🔔 Всё равно подписаться'], ['⬅️ К результатам']]);
    });

    test("a long overview is cut so the caption stays under Telegram's 1024 characters", () => {
        const card = seriesCard({ ...SERIES, overview: 'а'.repeat(3000) });
        assert.ok(card.caption.length < 1024, String(card.caption.length));
    });
});

describe('filmCard', () => {
    const now = new Date('2026-10-12T12:00:00Z');
    const upcoming = {
        id: 7,
        title: 'Курьер',
        release_date: '2026-12-18',
        status: 'Post Production',
        director_name: 'Режиссёр',
        overview: '',
        poster_path: null
    };

    test('not out yet: the release date and "add to the watchlist"', () => {
        const card = filmCard(upcoming, { now });
        assert.match(card.caption, /Фильм · режиссёр Режиссёр/);
        assert.match(card.caption, /Релиз: <b>18 декабря 2026 г\.<\/b>/);
        assert.deepEqual(data(card.keyboard), ['watchlist_add_movie_7', 'back_to_results']);
        assert.equal(card.posterUrl, null);
    });

    test('already on the watchlist: no add button, a note instead', () => {
        const card = filmCard(upcoming, { now, onWatchlist: true });
        assert.match(card.caption, /Уже в вашем списке ожидания/);
        assert.deepEqual(data(card.keyboard), ['back_to_results']);
    });

    test('out already: where to watch, straight to the Kinopoisk page when its ID is known', () => {
        const card = filmCard(
            { ...upcoming, release_date: '2019-11-08', status: 'Released' },
            { now, kinopoiskId: 42 }
        );
        assert.match(card.caption, /Уже вышел — <b>8 ноября 2019 г\.<\/b>/);
        const urls = data(card.keyboard);
        assert.ok(urls.includes('https://www.kinopoisk.ru/film/42/'));
        assert.equal(urls.at(-1), 'back_to_results');
        assert.ok(!urls.includes('watchlist_add_movie_7'));
    });
});
