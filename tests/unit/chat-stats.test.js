/**
 * A chat's statistics: what is recorded (src/chat-events.js and its callers), the episodes kept by
 * month (src/cron/aired-episodes.js) and the figures built from them (src/chat-stats.js).
 * Run: npm run test:unit
 */
const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');

const tmdb = require('../../src/api/tmdb');
// Season 1: two episodes in March (one without a runtime), one still to come; season 2: April
const SEASONS = {
    1: {
        episodes: [
            { air_date: '2026-03-02', runtime: 50 },
            { air_date: '2026-03-09', runtime: null },
            { air_date: '2099-01-01', runtime: 50 }
        ]
    },
    2: { episodes: [{ air_date: '2026-04-06', runtime: 60 }] }
};
const asked = [];
mock.method(tmdb, 'getSeasonDetails', async (id, season) => {
    asked.push(season);
    return SEASONS[season];
});

const { ChatEvent, Chat, SendFailure } = require('../../src/db');
const events = require('../../src/chat-events');
const aired = require('../../src/cron/aired-episodes');
const { computeStats, leader } = require('../../src/chat-stats');
const { featureOf } = require('../../src/bot/usage');
const { notify } = require('../../src/cron/outbox');
const { fakeBot } = require('./fakes');

mock.method(Chat, 'findByPk', async () => null);
// A send refused as "blocked" marks the chat (src/bot-status.js), written at the events' flush
mock.method(Chat, 'findAll', async () => []);
// A send that fails for good is kept for the dashboard (src/send-failures.js): not here
mock.method(SendFailure, 'create', async () => {});
mock.method(SendFailure, 'destroy', async () => 0);

describe('aired episodes by month', () => {
    test('stored as text and read back the same', () => {
        const value = '2026-03:1=2/95,2=1/60;2026-04:2=3/180';
        assert.equal(aired.formatAired(aired.parseAired(value)), value);
        assert.equal(aired.parseAired('').size, 0);
        assert.equal(aired.parseAired(null).size, 0);
    });

    test('only aired episodes count; one without a runtime takes the series’ usual length', () => {
        const months = aired.seasonMonths(SEASONS[1], 45, new Date('2026-10-01'));
        assert.deepEqual(Object.fromEntries(months), { '2026-03': { count: 2, minutes: 95 } });
    });

    test('the first time every season is read; afterwards only the one with a new episode', async () => {
        const row = {
            tmdb_id: 'tv_7',
            aired_episodes: null,
            runtime: 45,
            async update(changes) {
                Object.assign(row, changes);
            }
        };
        const details = {
            seasons: [
                { season_number: 0, episode_count: 3 },
                { season_number: 1, episode_count: 3 },
                { season_number: 2, episode_count: 1 }
            ]
        };
        asked.length = 0;
        await aired.ensureAiredEpisodes(row, details, [], new Date('2026-10-01'));
        assert.deepEqual(asked, [1, 2]); // no specials
        assert.equal(row.aired_episodes, '2026-03:1=2/95;2026-04:2=1/60');

        asked.length = 0;
        SEASONS[2].episodes.push({ air_date: '2026-05-04', runtime: 60 });
        await aired.ensureAiredEpisodes(row, details, [2], new Date('2026-10-01'));
        assert.deepEqual(asked, [2]);
        assert.equal(row.aired_episodes, '2026-03:1=2/95;2026-04:2=1/60;2026-05:2=1/60');

        asked.length = 0;
        await aired.ensureAiredEpisodes(row, details, [], new Date('2026-10-01'));
        assert.deepEqual(asked, []);
    });
});

test('the update check reads again only the season whose latest episode is new', () => {
    const row = { last_season: 2, last_episode: 3 };
    const last = (season_number, episode_number) => ({ last_episode_to_air: { season_number, episode_number } });
    assert.deepEqual(aired.seasonsToRescan(row, last(2, 3)), []);
    assert.deepEqual(aired.seasonsToRescan(row, last(2, 5)), [2]);
    assert.deepEqual(aired.seasonsToRescan(row, last(3, 1)), [3]);
    assert.deepEqual(aired.seasonsToRescan(row, {}), []);
});

describe('recording', () => {
    test('a notification is recorded with how it went; nothing is written until the flush', async () => {
        const writes = [];
        mock.method(ChatEvent, 'bulkCreate', async (rows) => writes.push(rows));
        await events.flushEvents();
        writes.length = 0;

        const bot = fakeBot({ failFor: [2] });
        const event = { detail: 'episode', tmdb_id: 'tv_1', title: 'Show', season: 1, episode: 3 };
        await notify(bot, 1, 'text', { event });
        await notify(bot, 2, 'text', { event });
        await notify(bot, 3, 'text'); // no event: the panel's test alert, say
        assert.deepEqual(
            events.unwritten().map((e) => [e.chatId, e.kind, e.detail, e.outcome, e.episode]),
            [
                [1, 'notified', 'episode', 'sent', 3],
                [2, 'notified', 'episode', 'failed', 3]
            ]
        );
        assert.equal(writes.length, 0);

        await events.flushEvents();
        assert.equal(writes.length, 1);
        assert.equal(writes[0].length, 2);
        assert.equal(events.unwritten().length, 0);
    });

    test('a failed write keeps the events for the next one', async () => {
        mock.method(ChatEvent, 'bulkCreate', async () => {
            throw new Error('database down');
        });
        events.record(5, { kind: 'used', detail: 'search' });
        await events.flushEvents();
        assert.equal(events.unwritten().length, 1);
        mock.method(ChatEvent, 'bulkCreate', async () => {});
        await events.flushEvents();
        assert.equal(events.unwritten().length, 0);
    });

    test('who did it: @username, else the name', () => {
        assert.deepEqual(events.actor({ from: { id: 1, username: 'ann' } }), {
            userId: 1,
            userName: '@ann',
            source: 'bot'
        });
        assert.deepEqual(events.actor({ from: { id: 2, first_name: 'Bob', last_name: 'K' } }), {
            userId: 2,
            userName: 'Bob K',
            source: 'bot'
        });
        assert.deepEqual(events.actor({}), {});
    });

    test('what counts as using the bot: openings, not paging', () => {
        const message = (text, state = 'idle') => ({ message: { text }, session: { state } });
        const button = (data) => ({ callbackQuery: { data }, session: {} });
        assert.equal(featureOf(message('/week@NotFckBot')), 'calendar');
        assert.equal(featureOf(message('📺 Мои подписки')), 'subs');
        assert.equal(featureOf(message('Дюна', 'waiting_for_search')), 'query');
        assert.equal(featureOf(message('привет')), null);
        assert.equal(featureOf(button('card_tv_1399')), 'card');
        assert.equal(featureOf(button('hist_2025')), 'history');
        assert.equal(featureOf(button('page_2')), null);
        assert.equal(featureOf(button('subs_p_1')), null);
    });
});

describe('the statistics', () => {
    const YEAR = { from: '2026-01-01', to: '2026-12-31' };
    const NOW = new Date('2026-10-23T12:00:00Z');
    const data = {
        chat: { id: 1, timezone: 'Europe/Moscow' },
        series: [
            {
                tmdb_id: 'tv_1',
                title: 'Drama',
                status: 'Returning Series',
                genres: 'Драма, Криминал',
                networks: 'HBO',
                countries: 'US',
                rating: 8.5,
                aired_episodes: '2025-12:1=8/400;2026-03:2=4/200;2026-04:2=4/200',
                next_episode_date: '2027-02-01',
                subscribedAt: new Date('2025-11-01')
            },
            {
                tmdb_id: 'tv_2',
                title: 'Comedy',
                status: 'Ended',
                genres: 'Комедия, Драма',
                networks: 'Apple TV+',
                countries: 'GB',
                rating: 7.1,
                aired_episodes: '2026-03:3=10/300',
                subscribedAt: new Date('2026-02-10')
            },
            { tmdb_id: 'tv_3', title: 'Quiet', status: 'Returning Series', aired_episodes: '2024-05:1=6/300' }
        ],
        films: [
            {
                tmdb_id: 'movie_1',
                title: 'Film',
                premiere_digital: '2026-06-20',
                ru_premiere: '2026-06-18',
                ru_services: 'Okko, Кинопоиск',
                genres: 'Фантастика',
                countries: 'US',
                runtime: 150,
                rating: 7.9,
                notified: true,
                createdAt: new Date('2025-06-18T10:00:00Z')
            },
            { tmdb_id: 'movie_2', title: 'Later', premiere_digital: '2027-03-01', notified: false, createdAt: NOW }
        ],
        events: [
            { kind: 'notified', detail: 'episode', outcome: 'sent', createdAt: new Date('2026-03-02T09:00:00Z') },
            { kind: 'notified', detail: 'episode', outcome: 'held', createdAt: new Date('2026-03-02T21:30:00Z') },
            { kind: 'notified', detail: 'film', outcome: 'failed', createdAt: new Date('2026-06-20T09:00:00Z') },
            { kind: 'notified', detail: 'episode', outcome: 'sent', createdAt: new Date('2025-12-01T09:00:00Z') },
            { kind: 'used', detail: 'search', userId: 10, userName: '@ann', createdAt: NOW },
            { kind: 'used', detail: 'search', userId: 10, userName: '@ann', createdAt: NOW },
            { kind: 'used', detail: 'calendar', userId: 11, userName: 'Bob', createdAt: NOW },
            { kind: 'unsubscribed', title: 'Old', userId: 11, userName: 'Bob', createdAt: NOW },
            // Bob renamed himself: still one member, under the newest name
            { kind: 'subscribed', title: 'Drama', userId: 11, userName: '@bobby', createdAt: NOW },
            { kind: 'film_added', title: 'Film', userId: 11, userName: '@bobby', createdAt: NOW },
            // An admin's change from the panel names the admin: not one of the members
            { kind: 'film_added', title: 'Panel film', userId: 99, userName: 'Admin', source: 'panel', createdAt: NOW },
            { kind: 'mode', title: 'Drama', userId: 10, userName: '@ann', createdAt: NOW },
            // Added from the panel: nobody's
            { kind: 'subscribed', title: 'Comedy', createdAt: NOW }
        ],
        followers: new Map([
            ['tv_1', 3],
            ['tv_2', 1],
            ['movie_1', 2]
        ])
    };
    const stats = computeStats(data, YEAR, NOW);

    test('episodes of the period only, by month, with the busiest', () => {
        assert.equal(stats.episodes.count, 18);
        assert.equal(stats.episodes.minutes, 700);
        assert.equal(stats.episodes.series, 2);
        assert.equal(stats.episodes.seasons, 2);
        assert.deepEqual(stats.episodes.busiestMonth, { month: '2026-03', count: 14, minutes: 500 });
        assert.deepEqual(
            stats.episodes.top.map((s) => [s.title, s.count]),
            [
                ['Comedy', 10],
                ['Drama', 8]
            ]
        );
    });

    test('films out in the period, by their first date; how long the chat waited', () => {
        assert.deepEqual(stats.films.released, [
            { tmdb_id: 'movie_1', title: 'Film', day: '2026-06-18', waited: 365, rating: 7.9, poster_url: null }
        ]);
        assert.equal(stats.films.minutes, 150);
        assert.deepEqual(stats.films.services.map((s) => s.name).sort(), ['Okko', 'Кинопоиск'].sort());
    });

    test('favourites: a title counts once; the best rated; what ended; what is ahead', () => {
        assert.deepEqual(stats.favourites.genres[0], { name: 'Драма', n: 2 });
        assert.deepEqual(
            stats.best.map((t) => t.title),
            ['Drama', 'Film', 'Comedy']
        );
        assert.deepEqual(
            stats.finished.map((t) => t.title),
            ['Comedy']
        );
        assert.deepEqual(stats.ahead, {
            series: 1,
            films: 1,
            next: [
                { title: 'Drama', day: '2027-02-01', kind: 'series' },
                { title: 'Later', day: '2027-03-01', kind: 'film' }
            ]
        });
        assert.deepEqual(stats.added, { series: 1, films: 1, unsubscribed: 1, filmsRemoved: 0 });
    });

    test('notifications and use of the bot, by the chat’s own day', () => {
        assert.equal(stats.notifications.total, 3);
        assert.deepEqual(stats.notifications.outcomes, { sent: 1, held: 1, failed: 1 });
        // 21:30 UTC is already the 3rd in Moscow
        assert.deepEqual(stats.notifications.busiestDay, { day: '2026-03-02', n: 1 });
        assert.deepEqual(stats.usage.features, [
            { name: 'search', n: 2 },
            { name: 'calendar', n: 1 }
        ]);
        assert.deepEqual(stats.members, {
            added: [{ name: '@bobby', series: 1, films: 1, n: 2 }],
            // 2 is too few to lead
            leader: false,
            used: [
                { name: '@ann', n: 2 },
                { name: '@bobby', n: 1 }
            ]
        });
        assert.equal(stats.since, '2025-12-01');
    });

    test('rare finds: titles no other chat follows', () => {
        assert.deepEqual(
            stats.rare.map((t) => t.title),
            ['Comedy']
        );
    });
});

describe('who added the most', () => {
    const member = (name, n) => ({ name, series: n, films: 0, n });
    test('a leader only with at least 3 and clearly ahead', () => {
        assert.equal(leader({ added: [member('@a', 3), member('@b', 2)] }).name, '@a');
        assert.equal(leader({ added: [member('@a', 5)] }).name, '@a');
        // A tie, too few, nobody: no leader
        assert.equal(leader({ added: [member('@a', 4), member('@b', 4)] }), null);
        assert.equal(leader({ added: [member('@a', 2)] }), null);
        assert.equal(leader({ added: [] }), null);
        assert.equal(leader(undefined), null);
    });
});
