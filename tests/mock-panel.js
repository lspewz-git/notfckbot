const fs = require('fs');
const path = require('path');

/**
 * Serves the panel straight from admin/ with a canned API, entirely inside the
 * browser's request routing — no backend, database or open port needed. Specs
 * that exercise a specific data shape use this; admin.spec.js still runs
 * against a real instance.
 */

const ADMIN_DIR = path.join(__dirname, '..', 'admin');

// Never actually resolved: every request is answered by the route below, so
// this works whatever ADMIN_URL the rest of the suite points at.
const ORIGIN = 'http://panel.localhost';

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

const chat = (id, username, type = 'private') => ({
    id,
    username,
    type,
    blockedUntil: null,
    menu_enabled: true,
    buttons_mode: 'owner'
});

const CHATS = [chat(101, 'alice'), chat(102, 'bob'), chat(-1003, 'Movie Club', 'supergroup')];

// Six of the series will never air again — their subscriptions are the archive
const SERIES = [
    ['1399', 'Game of Thrones', 'Ended'],
    ['1396', 'Breaking Bad', 'Ended'],
    ['60059', 'Better Call Saul', 'Ended'],
    ['66732', 'Stranger Things', 'Returning Series'],
    ['94997', 'House of the Dragon', 'Returning Series'],
    ['76479', 'The Boys', 'Returning Series'],
    ['84958', 'Loki', 'Canceled'],
    ['100088', 'The Last of Us', 'In Production'],
    ['95396', 'Severance', 'Returning Series'],
    ['136315', 'The Bear', 'Planned'],
    ['200000', 'Brand New Show', null]
].map(([tmdb_id, title, status]) => ({
    tmdb_id,
    title,
    status,
    next_episode_date: null,
    next_episode_season: null,
    next_episode_number: null
}));

// TMDB's next announced episode: one dated, one numbered but undated, one special (season 0)
Object.assign(
    SERIES.find((s) => s.title === 'Severance'),
    {
        next_episode_date: '2026-10-15',
        next_episode_season: 3,
        next_episode_number: 2
    }
);
Object.assign(
    SERIES.find((s) => s.title === 'The Boys'),
    { next_episode_season: 5, next_episode_number: 1 }
);
Object.assign(
    SERIES.find((s) => s.title === 'Stranger Things'),
    {
        next_episode_date: '2026-12-25',
        next_episode_season: 0,
        next_episode_number: 3
    }
);

const film = (id, title, year, premiere_digital, notified = false) => ({
    id,
    chatId: 101,
    Chat: CHATS[0],
    tmdb_id: `movie_${id}`,
    title,
    year,
    premiere_digital,
    notified
});

/** Waiting films in no particular order, one without a date; plus one released. */
const FILMS = [
    film(1, 'Dune: Part Three', 2026, '2026-12-18'),
    film(2, 'Avengers: Doomsday', 2026, '2026-12-16'),
    film(3, 'No Date Yet', null, null),
    film(4, 'Spider-Man 4', 2027, '2027-06-16'),
    film(5, 'Hunger Games', 2026, '2026-11-18'),
    film(6, 'Dune', 2024, '2024-04-16', true)
];

const series = (id) => SERIES.find((s) => s.tmdb_id === id);

const sub = (chatId, seriesId, notify_type = 'episode') => ({
    chatId,
    seriesId,
    notify_type,
    Chat: CHATS.find((c) => c.id === chatId),
    Series: series(seriesId)
});

/** 23 subscriptions: 17 active (one with a not-yet-checked status), 6 archived. */
function buildSubs() {
    return [
        sub(101, '1399'),
        sub(102, '1399'),
        sub(101, '1396', 'season'),
        sub(-1003, '60059'),
        sub(102, '84958'),
        sub(-1003, '84958', 'first_and_full'),
        sub(101, '66732'),
        sub(102, '66732', 'season'),
        sub(-1003, '66732'),
        sub(101, '94997'),
        sub(102, '94997'),
        sub(101, '76479', 'first_and_full'),
        sub(102, '76479'),
        sub(-1003, '76479'),
        sub(101, '100088'),
        sub(102, '100088', 'season'),
        sub(101, '95396'),
        sub(102, '95396'),
        sub(-1003, '95396'),
        sub(101, '136315'),
        sub(102, '136315'),
        sub(-1003, '136315'),
        sub(101, '200000')
    ];
}

const FINISHED = ['Ended', 'Canceled'];

function stats(subs) {
    const archived = subs.filter((s) => FINISHED.includes(s.Series && s.Series.status)).length;
    return {
        chatsCount: CHATS.length,
        seriesCount: SERIES.length,
        subsCount: subs.length,
        activeSubsCount: subs.length - archived,
        archivedSubsCount: archived,
        filmsCount: 1
    };
}

/**
 * Routes every request of `page` and opens the panel. Returns the mutable fixture so a test can
 * change what the next poll sees (e.g. `panel.subs.push(...)`).
 *
 * @param {{ health?: object, upcoming?: object[], popular?: object[], version?: object, kinopoisk?: object,
 *   hold?: Promise<void>, kinopoiskHold?: Promise<void>,
 *   addHold?: Promise<void>, addError?: string }} [options]
 *   `health`: overrides per service, e.g. { kinopoisk: 'error' }; `upcoming` / `popular`: the
 *   dashboard lists; `version`: /api/version; `kinopoisk`: the card's Kinopoisk link;
 *   `kinopoiskHold`: the Kinopoisk answer waits for it; `addHold`: adding a film waits for it;
 *   `addError`: adding a film fails with this message (409);
 *   `hold`: API answers wait for it, so a test can see the loading state
 */
async function mockPanel(page, options = {}) {
    const panel = {
        subs: buildSubs(),
        sub,
        series,
        health: { telegram: true, tmdb: true, proxy: 'off', kinopoisk: 'ok', ...options.health },
        // The update check: "Run now" starts it, and it reports running for two polls
        cron: {
            running: false,
            lastRun: null,
            nextRunAt: new Date(Date.now() + 3600e3).toISOString(),
            intervalHours: 3
        },
        pollsUntilDone: 0
    };

    function cronStatus() {
        if (panel.cron.running && --panel.pollsUntilDone <= 0) {
            const finishedAt = new Date().toISOString();
            panel.cron = {
                ...panel.cron,
                running: false,
                startedAt: null,
                lastRun: {
                    finishedAt,
                    durationMs: 4000,
                    series: 11,
                    films: 6,
                    sent: 2,
                    failed: 0,
                    errors: 0,
                    fatal: null
                }
            };
        }
        return panel.cron;
    }

    const api = {
        '/api/stats': () => stats(panel.subs),
        '/api/health': () => ({ ...panel.health, kinopoiskQuota: { used: 3, limit: 500 } }),
        '/api/health/telegram': () => ({ telegram: panel.health.telegram }),
        '/api/health/tmdb': () => ({ tmdb: panel.health.tmdb }),
        '/api/health/proxy': () => ({ proxy: panel.health.proxy }),
        '/api/health/kinopoisk': () => ({ kinopoisk: panel.health.kinopoisk, kinopoiskQuota: { used: 3, limit: 500 } }),
        '/api/trigger-check': () => {
            panel.cron = { ...panel.cron, running: true, startedAt: new Date().toISOString() };
            panel.pollsUntilDone = 2;
            return { success: true };
        },
        '/api/stats/popular': () => options.popular || [{ seriesId: '66732', subCount: 3, Series: series('66732') }],
        '/api/upcoming': () => options.upcoming || [],
        '/api/cron': cronStatus,
        '/api/version': () =>
            options.version || {
                commit: 'abc1234def5678abc1234def5678abc1234def56',
                short: 'abc1234',
                subject: 'Test commit',
                date: '2026-10-12T14:15:30Z',
                url: 'https://github.com/owner/repo/commit/abc1234def5678abc1234def5678abc1234def56'
            },
        '/api/logs': () => [{ type: 'log', time: '12:00:00', text: 'Started' }],
        '/api/data/chats': () => CHATS,
        // Like the real API: the archived flag is derived from Series.status on every response
        '/api/data/subs': () =>
            panel.subs.map((s) => ({ ...s, archived: FINISHED.includes(s.Series && s.Series.status) })),
        '/api/data/films': () => FILMS,
        '/api/data/series': () =>
            SERIES.map((x) => ({ tmdb_id: x.tmdb_id, title: x.title, last_season: 2, last_episode: 5 })),
        // Test notifications: what the dialog sent last
        '/api/test-notification': (req) => {
            panel.lastTest = req.postDataJSON();
            return { success: true };
        },
        // The add dialog: a search with long titles, and adding a film (POST)
        '/api/tmdb/search': () =>
            [1, 2, 3, 4, 5, 6].map((n) => ({
                id: 900 + n,
                media_type: n % 3 ? 'movie' : 'tv',
                title: `A very long film title that would not fit on one line of the dialog ${n}`,
                name: `A very long series title that would not fit on one line of the dialog ${n}`,
                release_date: '2026-01-01',
                first_air_date: '2025-01-01',
                poster_path: null
            })),
        // What the add dialog sent last, for tests to check: { path, body }
        '/api/subscription': (req) => {
            panel.lastAdd = { path: '/api/subscription', body: req.postDataJSON() };
            return { success: true, created: true };
        },
        '/api/watchlist': async (req) => {
            panel.added = (panel.added || 0) + 1;
            panel.lastAdd = { path: '/api/watchlist', body: req.postDataJSON() };
            await options.addHold;
            if (options.addError) return { status: 409, body: { error: options.addError } };
            return { success: true, isReleased: false };
        }
    };

    // Cards: /api/series/:id, /api/movie/:id and their Kinopoisk line
    const cards = [
        [
            /^\/api\/series\/(.+)$/,
            ([, id]) => {
                const subs = panel.subs.filter((s) => s.seriesId === id);
                return {
                    name: series(id).title,
                    vote_average: 8.4,
                    number_of_seasons: 4,
                    overview: 'A test series.',
                    poster_path: null,
                    subCount: subs.length,
                    subscribers: subs.map((s) => ({ chat: s.Chat, mode: s.notify_type }))
                };
            }
        ],
        [
            /^\/api\/movie\/(.+)$/,
            ([, id]) => {
                const rows = FILMS.filter((f) => f.tmdb_id === id);
                return {
                    title: rows[0].title,
                    vote_average: 7.1,
                    release_date: rows[0].premiere_digital,
                    status: rows[0].notified ? 'Released' : 'Post Production',
                    overview: 'A test film.',
                    poster_path: null,
                    waiting: rows.filter((f) => !f.notified).length,
                    notified: rows.filter((f) => f.notified).length,
                    chats: rows.map((f) => ({ chat: f.Chat, notified: f.notified }))
                };
            }
        ],
        [
            // A chat's settings: what the dialog sent last, for tests to check
            /^\/api\/chat\/(-?\d+)\/settings$/,
            ([, id], req) => {
                panel.lastSettings = { chatId: id, body: req.postDataJSON() };
                return { success: true };
            }
        ],
        [
            /^\/api\/kinopoisk\/(tv|movie)\/(\d+)$/,
            async ([, type]) => {
                await options.kinopoiskHold;
                return (
                    options.kinopoisk || {
                        id: 435,
                        url: `https://www.kinopoisk.ru/${type === 'tv' ? 'series' : 'film'}/435/`
                    }
                );
            }
        ]
    ];

    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());

        // Web fonts and anything else off-site: answer empty rather than fail
        if (url.origin !== ORIGIN) {
            return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
        }

        if (url.pathname.startsWith('/api/')) {
            const card = cards.map(([re, fn]) => [url.pathname.match(re), fn]).find(([m]) => m);
            const handler = api[url.pathname] || (card && ((req) => card[1](card[0], req)));
            if (!handler) return route.fulfill({ status: 404, json: { error: 'Not mocked' } });
            if (options.hold) await options.hold;
            const answer = await handler(route.request());
            // A handler may pick the status: { status, body }
            if (answer && answer.status && answer.body)
                return route.fulfill({ status: answer.status, json: answer.body });
            return route.fulfill({ status: 200, json: answer });
        }

        const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        const file = path.join(ADMIN_DIR, rel);
        if (!file.startsWith(ADMIN_DIR) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });

        return route.fulfill({
            status: 200,
            contentType: CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
            body: fs.readFileSync(file)
        });
    });

    await page.goto(`${ORIGIN}/`);
    return panel;
}

module.exports = { mockPanel, ORIGIN };
