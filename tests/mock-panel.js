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

/**
 * Waiting films in no particular order, one without a date; plus one released. Dune: Part
 * Three has a US digital release only; Hunger Games also has Russian dates from Kinopoisk.
 */
const FILMS = [
    { ...film(1, 'Dune: Part Three', 2026, '2026-12-18'), digital_date: '2027-02-02', digital_country: 'US' },
    film(2, 'Avengers: Doomsday', 2026, '2026-12-16'),
    film(3, 'No Date Yet', null, null),
    // Kinopoisk knows only the month of its Russian premiere (the 1st, not a Thursday)
    {
        ...film(4, 'Spider-Man 4', 2027, '2027-06-16'),
        ru_premiere: '2027-02-01',
        ru_checked_at: '2026-10-18T09:00:00Z'
    },
    {
        ...film(5, 'Hunger Games', 2026, '2026-11-18'),
        ru_premiere: '2026-11-20',
        ru_digital: '2027-01-15',
        ru_services: 'Okko',
        ru_checked_at: '2026-10-18T09:00:00Z'
    },
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
        filmsCount: 1,
        // The changes on the cards: options.stats overrides any
        chatsNew30: 2,
        subsNew30: 5,
        filmsAdded30: 1,
        filmsReleased30: 4,
        sent7: 38,
        sentPrev7: 50,
        failed7: 0,
        failedPrev7: 2
    };
}

/** /api/stats/charts: twelve weeks and months of new subscriptions, thirty days of notifications. */
function charts() {
    const day = (i) => new Date(Date.UTC(2026, 8, 15 + i)).toISOString().slice(0, 10);
    return {
        weeks: Array.from({ length: 12 }, (_, i) => ({ start: day(i * 7 - 77 + 28), count: (i * 7) % 5 })),
        months: Array.from({ length: 12 }, (_, i) => ({
            month: `2026-${String(i + 1).padStart(2, '0')}`,
            count: i % 4
        })),
        days: Array.from({ length: 30 }, (_, i) => ({ day: day(i), sent: (i * 3) % 7, failed: i === 9 ? 1 : 0 })),
        countingSince: day(20)
    };
}

/** A 1x1 grey PNG: a poster for the cards, sized by CSS like a real one */
const PIXEL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64'
);

/**
 * Routes every request of `page` and opens the panel. Returns the mutable fixture so a test can
 * change what the next poll sees (e.g. `panel.subs.push(...)`).
 *
 * @param {{ health?: object, upcoming?: object[], popular?: object[], version?: object, kinopoisk?: object,
 *   hold?: Promise<void>, kinopoiskHold?: Promise<void>,
 *   addHold?: Promise<void>, addError?: string, files?: Record<string, 'missing' | Promise<void>>,
 *   failing?: string[], poster?: boolean, chatStats?: (query: string) => object, statsHold?: Promise<void>,
 *   recap?: (n: number) => Buffer }} [options]
 *   `health`: overrides per service, e.g. { kinopoisk: 'error' }; `upcoming` / `popular`: the
 *   dashboard lists; `version`: /api/version; `kinopoisk`: the card's Kinopoisk link;
 *   `kinopoiskHold`: the Kinopoisk answer waits for it; `addHold`: adding a film waits for it;
 *   `addError`: adding a film fails with this message (409);
 *   `history(year)`: the /api/history answer for the year asked (0 when none);
 *   `hold`: API answers wait for it, so a test can see the loading state;
 *   `failing`: API paths ('/api/stats') that answer 500;
 *   `poster`: a series card gets a poster (a 1x1 image);
 *   `files`: the panel's own files by path ('js/app.js'): 'missing' fails to load, a promise is
 *   served once it resolves (a page.route() of the test's would lose to this one's catch-all)
 */
/** A chat's statistics as /api/chat/:id/stats answers them (src/chat-stats.js). */
function chatStats(query) {
    const year = (/year=(\d{4})/.exec(query) || [])[1] || '2026';
    return {
        period: { from: `${year}-01-01`, to: `${year}-12-31` },
        following: { series: 20, running: 14, films: 3 },
        added: { series: 12, films: 2, unsubscribed: 3, filmsRemoved: 0 },
        episodes: {
            count: 187,
            minutes: 8520,
            series: 18,
            seasons: 23,
            byMonth: [
                { month: `${year}-01`, count: 9, minutes: 400 },
                { month: `${year}-03`, count: 34, minutes: 1600 },
                { month: `${year}-04`, count: 20, minutes: 950 }
            ],
            busiestMonth: { month: `${year}-03`, count: 34, minutes: 1600 },
            top: [
                { tmdb_id: 'tv_1', title: 'The Penguin', count: 10, minutes: 540 },
                { tmdb_id: 'tv_2', title: 'Shōgun', count: 10, minutes: 480 }
            ]
        },
        films: {
            released: [{ tmdb_id: 'movie_1', title: 'Dune: Messiah', day: `${year}-06-18`, waited: 412, rating: 8.2 }],
            minutes: 160,
            longestWait: null,
            services: []
        },
        favourites: {
            genres: [
                { name: 'драма', n: 12 },
                { name: 'криминал', n: 7 }
            ],
            networks: [{ name: 'HBO', n: 6 }],
            countries: [
                { name: 'US', n: 14 },
                { name: 'KR', n: 4 }
            ]
        },
        best: [],
        finished: [],
        ahead: { series: 2, films: 1 },
        notifications: { total: 214, outcomes: { sent: 181, held: 31, failed: 2 }, kinds: {}, busiestDay: null },
        usage: {
            total: 86,
            features: [
                { name: 'query', n: 48 },
                { name: 'calendar', n: 21 }
            ],
            members: [{ name: '@ann', n: 36 }]
        },
        rare: [],
        since: '2026-10-23'
    };
}

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
            intervalHours: options.intervalHours || 3
        },
        pollsUntilDone: 0,
        settings: {
            tokens: {
                telegram: { configured: true, masked: '8123*****xYz4' },
                tmdb: { configured: true, masked: 'eyJh*****Q9wE' },
                kinopoisk: { configured: false, masked: '' }
            },
            proxy: { url: '', hasPassword: false },
            interval: { hours: 3, active: 3, choices: [1, 2, 3, 4, 6, 8, 12, 24] },
            database: { host: 'db', name: 'series_bot', user: 'bot_user' },
            restart: { pending: [], blocked: null },
            startedAt: new Date(Date.now() - 3600e3).toISOString(),
            ...options.settings
        }
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
        '/api/stats': () => ({ ...stats(panel.subs), ...options.stats }),
        '/api/stats/charts': () => charts(),
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
        // The proxy dialog: no proxy saved; the test answers options.proxyTest
        '/api/config': () => ({ tmdbApiKey: 'abcd*****wxyz', tmdbProxyUrl: '', proxyHasPassword: false }),
        // Settings: GET answers panel.settings; POST records the body and answers options.settingsSave
        // (a { status, body } for an error) or the settings with the body applied
        '/api/settings': (req) => {
            if (req.method() === 'GET') return panel.settings;
            const body = req.postDataJSON();
            panel.lastSettingsSave = body;
            if (options.settingsSave) return options.settingsSave(body);
            const saved = [];
            if (body.intervalHours !== undefined) {
                panel.settings.interval.hours = body.intervalHours;
                panel.settings.restart.pending = ['interval'];
                saved.push('UPDATE_INTERVAL_HOURS');
            }
            if (body.proxyUrl !== undefined) {
                panel.settings.proxy.url = body.proxyUrl.replace(/:[^:@/]*@/, '@');
                saved.push('TMDB_PROXY_URL');
            }
            for (const name of Object.keys(body.tokens || {})) {
                panel.settings.tokens[name] = { configured: true, masked: 'new0*****cafe' };
                saved.push(name);
            }
            return { saved, settings: panel.settings };
        },
        '/api/restart': () => {
            panel.restarted = true;
            if (panel.settings.restart.blocked) {
                return {
                    status: 409,
                    body: { error: 'An update check is due', blocked: panel.settings.restart.blocked }
                };
            }
            return { restarting: true };
        },
        '/api/config/test-proxy': () =>
            options.proxyTest || {
                success: true,
                direct: false,
                proxyDown: null,
                checks: {
                    telegram: { ok: true, ms: 180 },
                    tmdb: { ok: true, ms: 240 },
                    internet: { ok: true, ms: 95, ip: '203.0.113.7' }
                }
            },
        // Release history: two years, the latest by default
        '/api/history': (req) => {
            const asked = Number(new URL(req.url()).searchParams.get('year'));
            if (options.history) return options.history(asked);
            const year = [2026, 2025].includes(asked) ? asked : 2026;
            const kp = (id) => `https://www.kinopoisk.ru/series/${id}/`;
            return year === 2026
                ? {
                      years: [2026, 2025],
                      year,
                      series: [
                          {
                              tmdbId: 'tv_66732',
                              title: 'Stranger Things',
                              seasons: [4, 5],
                              genres: ['drama', 'mystery'],
                              kinopoiskUrl: kp(915196)
                          },
                          { tmdbId: 'tv_95396', title: 'Severance', seasons: [2], genres: [], kinopoiskUrl: kp(1) }
                      ],
                      films: [
                          {
                              tmdbId: 'movie_1',
                              title: 'Dune: Part Three',
                              genres: ['sci-fi'],
                              kinopoiskUrl: 'https://www.kinopoisk.ru/index.php?kp_query=Dune'
                          }
                      ]
                  }
                : {
                      years: [2026, 2025],
                      year,
                      series: [{ tmdbId: 'tv_1399', title: 'Game of Thrones', genres: ['drama'], kinopoiskUrl: kp(2) }],
                      films: []
                  };
        },
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
            ([, raw]) => {
                // Real ids carry "tv_"; the fixtures here don't
                const id = raw.replace('tv_', '');
                const subs = panel.subs.filter((s) => s.seriesId === id);
                return {
                    name: series(id).title,
                    vote_average: 8.4,
                    number_of_seasons: 4,
                    overview: 'A test series.',
                    // options.poster: the card gets a poster (a 1x1 image, see /api/poster/ below)
                    poster_path: options.poster ? '/poster.png' : null,
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
                    dates: {
                        release: rows[0].premiere_digital,
                        digital: rows[0].digital_date || null,
                        digitalCountry: rows[0].digital_country || null,
                        ruPremiere: rows[0].ru_premiere || null,
                        ruDigital: rows[0].ru_digital || null,
                        ruServices: rows[0].ru_services || null
                    },
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
            // A recap card: options.recap(n) or a 1x1 image; the cards asked, for tests to check
            /^\/api\/chat\/(-?\d+)\/recap\/(\d)$/,
            ([, id, n], req) => {
                panel.recapAsked = [
                    ...(panel.recapAsked || []),
                    { chatId: id, n: Number(n), query: new URL(req.url()).search.slice(1) }
                ];
                return { image: options.recap ? options.recap(Number(n)) : PIXEL };
            }
        ],
        [
            // A chat's statistics: options.chatStats(query) or a year with a little of everything;
            // the queries asked, for tests to check. options.statsHold: the answer waits for it
            /^\/api\/chat\/(-?\d+)\/stats$/,
            async ([, id], req) => {
                const query = new URL(req.url()).search.slice(1);
                panel.statsAsked = [...(panel.statsAsked || []), { chatId: id, query }];
                await options.statsHold;
                return options.chatStats ? options.chatStats(query) : chatStats(query);
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
        // WebKit routes the panel's own object URLs (the recap cards) here too: they aren't ours to answer
        if (url.protocol === 'blob:') return route.continue();

        // Web fonts and anything else off-site: answer empty rather than fail
        if (url.origin !== ORIGIN) {
            return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
        }

        if (url.pathname.startsWith('/api/poster/') && options.poster)
            return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
        if (url.pathname.startsWith('/api/')) {
            const card = cards.map(([re, fn]) => [url.pathname.match(re), fn]).find(([m]) => m);
            const handler = api[url.pathname] || (card && ((req) => card[1](card[0], req)));
            if (!handler) return route.fulfill({ status: 404, json: { error: 'Not mocked' } });
            // As the server does (src/admin/panel-only.js): a request without the panel's mark
            // is refused, so a call that forgets it fails here too
            const marked = route.request().headers()['x-requested-by'] === 'notfckbot-panel';
            if (!marked && !url.pathname.startsWith('/api/poster/'))
                return route.fulfill({ status: 403, json: { error: 'The API answers the admin panel only' } });
            if (options.hold) await options.hold;
            if (options.failing && options.failing.includes(url.pathname))
                return route.fulfill({ status: 500, json: { error: 'Test failure' } });
            const answer = await handler(route.request());
            // An image: { image: Buffer }
            if (answer && answer.image)
                return route.fulfill({ status: 200, contentType: 'image/png', body: answer.image });
            // A handler may pick the status: { status, body }
            if (answer && answer.status && answer.body)
                return route.fulfill({ status: answer.status, json: answer.body });
            return route.fulfill({ status: 200, json: answer });
        }

        const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        const asked = options.files && options.files[rel];
        if (asked === 'missing') return route.abort();
        if (asked) await asked;
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

module.exports = { mockPanel, ORIGIN, chatStats };
