/**
 * The year's recap cards (src/recap/): what each card says for a full year and for an empty one,
 * and that all six draw as 1080x1350 PNGs with the fonts in the package.
 * Run: npm run test:unit
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { recapCards, drawable } = require('../../src/recap/cards');
const { renderCard } = require('../../src/recap/render');

/** Every text of an element tree, in order. */
function texts(node) {
    if (node === null || node === undefined || node === false) return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap(texts);
    return texts(node.props && node.props.children);
}

const FULL = {
    period: { from: '2026-01-01', to: '2026-12-31' },
    following: { series: 25, running: 18, films: 17 },
    episodes: {
        count: 87,
        minutes: 4700,
        series: 11,
        seasons: 13,
        byMonth: [
            { month: '2026-03', count: 20, minutes: 1000 },
            { month: '2026-09', count: 25, minutes: 1200 }
        ],
        top: [{ tmdb_id: 'tv_1', title: 'Большое шоу', count: 14, minutes: 732, poster_url: null }]
    },
    films: {
        released: [{ tmdb_id: 'movie_1', title: 'Resident Evil', day: '2026-09-18', waited: 189 }],
        minutes: 1680,
        longestWait: { tmdb_id: 'movie_1', title: 'Resident Evil', day: '2026-09-18', waited: 189 }
    },
    favourites: {
        genres: [
            { name: 'драма', n: 10 },
            { name: 'боевик', n: 8 }
        ],
        networks: [{ name: 'Paramount+', n: 3 }],
        countries: [
            { name: 'US', n: 22 },
            { name: 'GB', n: 10 }
        ]
    },
    best: [
        { title: 'Гангстерленд', rating: 8.5, kind: 'series', poster_url: null },
        { title: 'Пацаны', rating: 8.4, kind: 'series', poster_url: null }
    ],
    finished: [{ title: 'Пацаны', status: 'Ended' }],
    ahead: { series: 1, films: 9, next: [{ title: 'Дюна: Часть третья', day: '2027-12-17', kind: 'film' }] },
    rare: [{ title: 'Пацаны', kind: 'series' }]
};

const EMPTY = {
    period: { from: '2026-01-01', to: '2026-12-31' },
    following: { series: 0, running: 0, films: 0 },
    episodes: { count: 0, minutes: 0, series: 0, seasons: 0, byMonth: [], top: [] },
    films: { released: [], minutes: 0, longestWait: null },
    favourites: { genres: [], networks: [], countries: [] },
    best: [],
    finished: [],
    ahead: { series: 0, films: 0, next: [] },
    rare: []
};

describe('what the cards say', () => {
    const cards = recapCards(FULL, { year: 2026, chatName: 'Movie Club' }).map((c) => texts(c).join(' | '));

    test('six cards, each with its number', () => {
        assert.equal(cards.length, 6);
        cards.forEach((card, i) => assert.match(card, new RegExp(`${i + 1}/6`)));
    });

    test('the cover: the year, the hours of premieres (episodes and films), the chat', () => {
        assert.match(cards[0], /2026/);
        assert.match(cards[0], /106 часов/);
        assert.match(cards[0], /Movie Club/);
    });

    test('the episodes, the busiest month in Russian, the taste with genres capitalised', () => {
        assert.match(cards[1], /87 \| новых серий у 11 ваших сериалов — это 13 сезонов/);
        assert.match(cards[1], /сентябрь: 25 серий/);
        assert.match(cards[2], /Драма/);
        assert.match(cards[2], /Страна года: Соединенные Штаты, следом Великобритания/);
    });

    test('the best, the farewells, what comes next', () => {
        assert.match(cards[3], /Гангстерленд \| 8\.5/);
        assert.match(cards[3], /14 серий, 12 часов/);
        assert.match(cards[4], /Пацаны \| завершён/);
        assert.match(cards[4], /189/);
        assert.match(cards[5], /На 2027 уже анонсировано \| 1 сериал \| 9 фильмов/);
        assert.match(cards[5], /«Пацаны» — кроме вас его никто не смотрит с ботом/);
    });

    test('an empty year says so on every card, no zeros', () => {
        const empty = recapCards(EMPTY, { year: 2026, chatName: 'New' }).map((c) => texts(c).join(' | '));
        assert.match(empty[1], /Пауза/);
        assert.match(empty[2], /Загадка/);
        assert.match(empty[3], /Всё впереди/);
        assert.match(empty[4], /Ни одного финала/);
        assert.match(empty[5], /Пока ничего не объявлено/);
    });
});

test('what the fonts cannot draw (emoji, Japanese) is left out instead of coming out as boxes', () => {
    assert.equal(drawable('🎬 Кино-клуб 中文 «Café»'), 'Кино-клуб «Café»');
    const stats = {
        ...FULL,
        episodes: { ...FULL.episodes, top: [{ ...FULL.episodes.top[0], title: '進撃の巨人 🔥 Attack' }] }
    };
    const cards = recapCards(stats, { year: 2026, chatName: '🍿🍿' }).map((c) => texts(c).join(' | '));
    assert.match(cards[0], /ваш чат/);
    assert.match(cards[3], /\| Attack \|/);
    // Every text on every card is drawable as it stands
    for (const card of cards) for (const line of card.split(' | ')) assert.equal(drawable(line), line);
});

test('all six draw as 1080x1350 PNGs, full and empty', { timeout: 30000 }, async () => {
    for (const stats of [FULL, EMPTY]) {
        for (const card of recapCards(stats, { year: 2026, chatName: 'Movie Club' })) {
            const png = await renderCard(card);
            assert.equal(png.subarray(1, 4).toString(), 'PNG');
            assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1080, 1350]);
        }
    }
});
