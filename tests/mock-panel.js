const fs = require('fs');
const path = require('path');
const { accountState, accountAnswer, changesPage } = require('./mock-account');

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
    buttons_mode: 'owner',
    bot_status: 'active',
    bot_status_at: null,
    bot_status_by: null,
    last_seen_at: null
});

const CHATS = [chat(101, 'alice'), chat(102, 'bob'), chat(-1003, 'Movie Club', 'supergroup')];

// Settings → Alerts: the server's catalog (src/alerts/catalog.js) and a log
const ALERT_CATALOG = (() => {
    const { EVENTS, GROUPS } = require('../src/alerts/catalog');
    return { events: EVENTS, groups: GROUPS };
})();

const alertsState = () => ({
    rules: { downMinutes: 10, sendShare: 'half', repeatHours: 6, fixed: true },
    recipients: [
        {
            chatId: '101',
            name: 'alice',
            type: 'private',
            preset: 'all',
            events: null,
            lastAlertAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            unreachable: null,
            unreachableAt: null
        },
        {
            chatId: '-1003',
            name: 'Movie Club',
            type: 'supergroup',
            preset: 'custom',
            events: ['check_failed', 'tmdb_down'],
            lastAlertAt: null,
            unreachable: 'removed',
            unreachableAt: '2026-10-28T10:00:00Z'
        }
    ],
    log: [
        { event: 'tmdb_down', kind: 'fixed', sent: 1, failed: 0, sentTo: 'alice', at: new Date().toISOString() },
        { event: 'check_failed', kind: 'alert', sent: 1, failed: 1, sentTo: 'alice', at: '2026-10-27T15:00:00Z' }
    ],
    saves: [],
    tests: []
});

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
        chatsLeft: 0,
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
        // The bot counted from 20 Sep: the days before have no details to open
        countingSince: day(5)
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
 *   recap?: (n: number) => Buffer, recapStatus?: object, recapLooks?: object, recapReady?: object,
 *   recapImage?: (what: string) => Buffer, chats?: object[] }} [options]
 *   `health`: overrides per service, e.g. { kinopoisk: 'error' }; `upcoming` / `popular`: the
 *   dashboard lists; `version`: /api/version; `kinopoisk`: the card's Kinopoisk link;
 *   `kinopoiskHold`: the Kinopoisk answer waits for it; `addHold`: adding a film waits for it;
 *   `addError`: adding a film fails with this message (409);
 *   `history(year)`: the /api/history answer for the year asked (0 when none);
 *   `hold`: API answers wait for it, so a test can see the loading state;
 *   `failing`: API paths ('/api/stats') that answer 500;
 *   `poster`: a series card gets a poster (a 1x1 image);
 *   `chats`: the Users / Chats rows instead of the three default ones;
 *   `files`: the panel's own files by path ('js/app.js'): 'missing' fails to load, a promise is
 *   served once it resolves (a page.route() of the test's would lose to this one's catch-all);
 *   `role`: 'user' signs in as a user (default 'admin'), `signedOut`: the sign-in screen,
 *   `groupAdmin`: the user is an admin of the group "Киноклуб"; `path`: the page opened first
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
            ]
        },
        members: {
            added: [
                { name: '@masha', series: 6, films: 3, n: 9 },
                { name: '@ann', series: 4, films: 0, n: 4 }
            ],
            leader: true,
            used: [{ name: '@ann', n: 36 }]
        },
        rare: [],
        since: '2026-10-23',
        bot: { status: 'active', since: null, lastSeen: null, history: [] }
    };
}

const PICTURES = [
    { id: 'aaaaaaaaaaaaaaaa', name: 'Sunset.jpg', size: 1400000, uploadedAt: '2026-10-24T08:00:00Z', cards: [1] },
    { id: 'bbbbbbbbbbbbbbbb', name: 'Stripes.png', size: 900000, uploadedAt: '2026-10-23T08:00:00Z', cards: [3] }
];

/** Year recap → Schedule: off, nothing picked; the days of this season's window. */
function recapSchedule() {
    const y = new Date().getFullYear();
    const days = [];
    for (let d = 15; d <= 31; d += 1) days.push(`${y}-12-${d}`);
    for (let d = 1; d <= 10; d += 1) days.push(`${y + 1}-01-${String(d).padStart(2, '0')}`);
    return {
        on: false,
        done: false,
        day: null,
        hour: null,
        year: y,
        days,
        suggested: { day: `${y}-12-28`, hour: 12 },
        firstAt: null,
        lastAt: null,
        audience: { eligible: 3, sent: 0, queued: 0, failed: 0, nothing: 1, blocked: 0 },
        progress: { queued: 0, sending: 0, sent: 0, failed: 0, quiet: 0, total: 0, running: false }
    };
}

async function mockPanel(page, options = {}) {
    const panel = {
        // Signing in and the user's own chats (tests/mock-account.js): an admin unless told
        account: accountState(options),
        // Settings → Bot → Panel access
        access: options.access || { openSignup: false, system: { login: 'admin', passwordSet: true } },
        // Users: a role picked in a row's menu changes the chat here (panel.accessSaves has the bodies)
        chats: structuredClone(options.chats || CHATS),
        subs: buildSubs(),
        sub,
        series,
        // The year recap: options.recap* override
        recap: {
            audience: { eligible: 37, sent: 3, queued: 0, failed: 0, nothing: 5, blocked: 2 },
            progress: { queued: 0, sending: 0, sent: 3, failed: 0, quiet: 0, total: 3, running: false }
        },
        recapStatus: {
            status: null,
            sentAt: null,
            error: null,
            ...options.recapStatus
        },
        // Year recap → Backgrounds: two pictures, one on card 1, the other on card 3 dimmed
        recapLooks: options.recapLooks || {
            cards: [1, 2, 3, 4, 5, 6].map((card) => ({
                card,
                background: card === 1 ? PICTURES[0].id : card === 3 ? PICTURES[1].id : null,
                dim: card === 3 ? 35 : 0
            })),
            pictures: PICTURES.map((p) => ({ ...p })),
            maxDim: 80,
            sample: { id: '-1003', name: 'Movie Club' }
        },
        // Year recap → Schedule, and the saves asked for
        recapSchedule: { ...recapSchedule(), ...(options.recapSchedule || {}) },
        recapScheduleSaves: [],
        // Settings → Alerts: options.alerts overrides; saves and tests asked for, for tests to check
        alerts: { ...alertsState(), ...options.alerts },
        // Year recap → Ready cards: one of each state
        recapReady: options.recapReady || {
            year: new Date().getFullYear(),
            chats: [
                {
                    chatId: '-1003',
                    name: 'Movie Club',
                    type: 'supergroup',
                    state: 'ready',
                    drawnAt: '2026-10-24T07:40:00Z',
                    bytes: 428000
                },
                {
                    chatId: '101',
                    name: 'alice',
                    type: 'private',
                    state: 'old',
                    drawnAt: '2026-10-22T09:00:00Z',
                    bytes: 410000
                },
                { chatId: '102', name: 'bob', type: 'private', state: 'none', drawnAt: null, bytes: 0 }
            ],
            drawing: { running: false, left: 0 }
        },
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
            changes: { days: 30, choices: [7, 30, 90, 365] },
            database: { host: 'db', name: 'series_bot', user: 'bot_user' },
            restart: { pending: [], blocked: null },
            recap: { on: false, day: null, hour: null, year: null },
            // An hour ago, but never before today's midnight: the card says "since today" at 00:30 too
            startedAt: new Date(Math.max(Date.now() - 3600e3, new Date().setHours(0, 0, 0, 0))).toISOString(),
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

    const alertsView = () => {
        const { rules, recipients, log } = panel.alerts;
        return { ...ALERT_CATALOG, rules, recipients, log };
    };

    const api = {
        '/api/stats': () => ({ ...stats(panel.subs), ...options.stats }),
        // options.charts(data): the charts' data changed for a test
        '/api/stats/charts': () => (options.charts ? options.charts(charts()) : charts()),
        // A day of the notifications chart: options.sends(day) answers, else nothing went wrong
        '/api/stats/sends': (req) => {
            const day = new URL(req.url()).searchParams.get('day');
            panel.sendsAsked = [...(panel.sendsAsked || []), day];
            return options.sends
                ? options.sends(day)
                : { day, keptSince: null, failed: [], queued: [], nextCheckAt: null };
        },
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
        '/api/data/chats': () => panel.chats,
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
            if (req.method() === 'GET') {
                const { on, done, day, hour, year } = panel.recapSchedule;
                return { ...panel.settings, recap: { on, done, day, hour, year } };
            }
            const body = req.postDataJSON();
            panel.lastSettingsSave = body;
            if (options.settingsSave) return options.settingsSave(body);
            const saved = [];
            if (body.intervalHours !== undefined) {
                panel.settings.interval.hours = body.intervalHours;
                panel.settings.restart.pending = ['interval'];
                saved.push('UPDATE_INTERVAL_HOURS');
            }
            if (body.changesKeepDays !== undefined) {
                panel.settings.changes.days = body.changesKeepDays;
                saved.push('CHANGES_KEEP_DAYS');
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
        // Panel access: GET the Settings card; POST a person's role (panel.accessSaves records the
        // bodies), answered by options.accessSave(body) or applied to their chat
        '/api/access': (req) => {
            if (req.method() === 'GET') return panel.access;
            const body = req.postDataJSON();
            panel.accessSaves = [...(panel.accessSaves || []), body];
            if (options.accessSave) return options.accessSave(body);
            const chat = panel.chats.find((c) => String(c.id) === body.userId);
            if (chat) {
                chat.panelRole = body.role;
                if (body.role === 'none') chat.hasPassword = false;
            }
            return { userId: body.userId, role: body.role };
        },
        '/api/access/signup': (req) => {
            panel.access = { ...panel.access, openSignup: req.postDataJSON().open };
            return panel.access;
        },
        '/api/access/system-password': (req) => {
            panel.systemPasswords = [...(panel.systemPasswords || []), req.postDataJSON().password];
            panel.access = { ...panel.access, system: { ...panel.access.system, passwordSet: true } };
            return panel.access;
        },
        // The year recap's sending: who gets it and how it goes; the sends asked for, for tests
        '/api/recap': () => panel.recap,
        '/api/recap/send': (req) => {
            panel.recapSends = [...(panel.recapSends || []), req.postDataJSON()];
            const queued = panel.recap.audience.eligible;
            panel.recap.progress = { ...panel.recap.progress, queued, total: panel.recap.progress.total + queued };
            panel.recap.audience = { ...panel.recap.audience, eligible: 0, queued };
            return { queued, progress: panel.recap.progress };
        },
        '/api/recap/stop': () => {
            const removed = panel.recap.progress.queued;
            panel.recap.progress = { ...panel.recap.progress, queued: 0, total: panel.recap.progress.total - removed };
            panel.recapStopped = true;
            const scheduleOff = panel.recapSchedule.on;
            panel.recapSchedule.on = false;
            return { removed, scheduleOff, scheduleSaved: options.recapStopSaved !== false };
        },
        // Year recap → Backgrounds and Ready cards: what was asked, for tests to check
        '/api/recap/looks': () => panel.recapLooks,
        '/api/recap/backgrounds': (req) => {
            const picture = {
                id: 'cccccccccccccccc',
                name: 'upload.png',
                size: 1000,
                uploadedAt: new Date().toISOString(),
                cards: []
            };
            panel.recapUploads = (panel.recapUploads || 0) + 1;
            panel.recapUploadType = req.headers()['content-type'];
            panel.recapLooks.pictures = [picture, ...panel.recapLooks.pictures];
            return { status: 201, body: picture };
        },
        '/api/recap/ready': (req) => {
            if (req.method() === 'DELETE') {
                const removed = panel.recapReady.chats.filter((c) => c.state !== 'none').length;
                panel.recapReady.chats = panel.recapReady.chats.map((c) => ({
                    ...c,
                    state: 'none',
                    bytes: 0,
                    drawnAt: null
                }));
                panel.recapDeletedAll = true;
                return { removed };
            }
            return panel.recapReady;
        },
        '/api/recap/drawing': () => panel.recapReady.drawing,
        // Settings → Alerts, as src/admin/routes/alerts.js answers
        '/api/alerts': () => alertsView(),
        // As the server: active chats not on the list yet, by name or exact id
        '/api/alerts/candidates': (req) => {
            const q = (new URL(req.url()).searchParams.get('q') || '').replace(/^@/, '').toLowerCase();
            return CHATS.filter(
                (c) =>
                    c.bot_status === 'active' &&
                    !panel.alerts.recipients.some((r) => r.chatId === String(c.id)) &&
                    (!q || c.username.toLowerCase().includes(q) || String(c.id) === q)
            ).map((c) => ({ chatId: String(c.id), name: c.username, type: c.type, lastSeenAt: null }));
        },
        '/api/alerts/recipients': (req) => {
            const { chatId } = req.postDataJSON();
            const c = CHATS.find((x) => String(x.id) === chatId);
            panel.alerts.recipients.push({
                chatId,
                name: c ? c.username : null,
                type: c ? c.type : 'private',
                preset: 'critical',
                events: null,
                lastAlertAt: null,
                unreachable: null,
                unreachableAt: null
            });
            return alertsView();
        },
        '/api/alerts/test': (req) => {
            const body = req.postDataJSON();
            panel.alerts.tests.push(body);
            const to = panel.alerts.recipients.filter((r) => !body.chatId || r.chatId === body.chatId);
            return {
                sent: to.filter((r) => !r.unreachable).length,
                failed: to.filter((r) => r.unreachable).length,
                wanted: to.length
            };
        },
        '/api/alerts/rules': (req) => {
            panel.alerts.rules = req.postDataJSON();
            panel.alerts.saves.push({ rules: panel.alerts.rules });
            return alertsView();
        },
        // Year recap → Schedule: the saves asked for, for tests; a day moved while on is refused
        '/api/recap/schedule': (req) => {
            const s = panel.recapSchedule;
            if (req.method() === 'GET') return s;
            const body = req.postDataJSON();
            panel.recapScheduleSaves.push(body);
            if (options.recapScheduleError) return { status: 400, body: { error: options.recapScheduleError } };
            if (s.on && body.on && (body.day !== s.day || body.hour !== s.hour)) {
                return { status: 400, body: { error: 'Turn it off before changing the day' } };
            }
            const year = body.day ? Number(body.day.slice(0, 4)) - (body.day.slice(5, 7) === '01' ? 1 : 0) : s.year;
            Object.assign(s, body, { year, done: false });
            if (body.day) {
                const [yy, mm, dd] = body.day.split('-').map(Number);
                s.firstAt = new Date(Date.UTC(yy, mm - 1, dd, body.hour - 12)).toISOString();
                s.lastAt = new Date(Date.UTC(yy, mm - 1, dd, body.hour - 2)).toISOString();
            }
            panel.settings.recap = { on: s.on, done: s.done, day: s.day, hour: s.hour, year: s.year };
            return s;
        },
        '/api/recap/draw': (req) => {
            panel.recapDraws = [...(panel.recapDraws || []), req.postDataJSON()];
            panel.recapReady.drawing = { running: true, left: 2 };
            return { drawing: panel.recapReady.drawing };
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
        // Panel access: someone's password removed (panel.passwordRemoved has the ids)
        [
            /^\/api\/access\/(\d+)\/password$/,
            ([, id]) => {
                panel.passwordRemoved = [...(panel.passwordRemoved || []), id];
                const chat = panel.chats.find((c) => String(c.id) === id);
                if (chat) chat.hasPassword = false;
                return { userId: id, hasPassword: false };
            }
        ],
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
            // A chat's change log: 23 rows (options.changes overrides); the queries asked, for tests
            /^\/api\/chat\/(-?\d+)\/changes$/,
            ([, id], req) => {
                const url = new URL(req.url());
                panel.changesAsked = [...(panel.changesAsked || []), { chatId: id, query: url.search.slice(1) }];
                return changesPage(url, options.changes);
            }
        ],
        [
            // A chat's year recap: whether it was sent (options.recapStatus) and a send asked for
            /^\/api\/chat\/(-?\d+)\/recap-status$/,
            () => panel.recapStatus
        ],
        [
            /^\/api\/chat\/(-?\d+)\/recap\/send$/,
            ([, id], req) => {
                panel.recapSendOne = { chatId: id, body: req.postDataJSON() };
                panel.recapStatus = { ...panel.recapStatus, status: 'queued' };
                return { queued: 1 };
            }
        ],
        [
            /^\/api\/recap\/backgrounds\/([a-f0-9]{16})$/,
            ([, id], req) => {
                if (req.method() !== 'DELETE')
                    return { image: options.recapImage ? options.recapImage(`picture:${id}`) : PIXEL };
                panel.recapPictureDeleted = id;
                panel.recapLooks.pictures = panel.recapLooks.pictures.filter((p) => p.id !== id);
                panel.recapLooks.cards = panel.recapLooks.cards.map((c) =>
                    c.background === id ? { ...c, background: null, dim: 0 } : c
                );
                return { removed: true };
            }
        ],
        [
            /^\/api\/recap\/looks\/(\d)$/,
            ([, card], req) => {
                const body = req.postDataJSON();
                panel.recapLookSaved = { card: Number(card), ...body };
                panel.recapLooks.cards = panel.recapLooks.cards.map((c) =>
                    c.card === Number(card) ? { card: c.card, ...body } : c
                );
                return { cards: panel.recapLooks.cards };
            }
        ],
        [
            /^\/api\/recap\/preview\/(\d)$/,
            ([, card], req) => {
                const query = new URL(req.url()).searchParams;
                panel.recapPreviews = [
                    ...(panel.recapPreviews || []),
                    { card: Number(card), background: query.get('background'), dim: query.get('dim') }
                ];
                return {
                    image: options.recapImage
                        ? options.recapImage(`preview:${card}:${query.get('background') || ''}:${query.get('dim')}`)
                        : PIXEL
                };
            }
        ],
        [
            /^\/api\/recap\/ready\/(-?\d+)\/thumb\/(\d)$/,
            ([, id, n]) => ({ image: options.recapImage ? options.recapImage(`thumb:${id}:${n}`) : PIXEL })
        ],
        [
            /^\/api\/recap\/ready\/(-?\d+)$/,
            ([, id]) => {
                panel.recapDeleted = id;
                panel.recapReady.chats = panel.recapReady.chats.map((c) =>
                    c.chatId === id ? { ...c, state: 'none', bytes: 0, drawnAt: null } : c
                );
                return { removed: 1 };
            }
        ],
        [
            // Settings → Alerts: one recipient's choice (PUT) or its removal (DELETE)
            /^\/api\/alerts\/recipients\/(-?\d+)$/,
            ([, id], req) => {
                const list = panel.alerts.recipients;
                if (req.method() === 'DELETE') {
                    panel.alerts.recipients = list.filter((r) => r.chatId !== id);
                    panel.alerts.saves.push({ removed: id });
                    return alertsView();
                }
                const body = req.postDataJSON();
                panel.alerts.saves.push({ chatId: id, ...body });
                panel.alerts.recipients = list.map((r) =>
                    r.chatId === id
                        ? { ...r, preset: body.preset, events: body.preset === 'custom' ? body.events : null }
                        : r
                );
                return alertsView();
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

        if (url.pathname.startsWith('/api/poster/'))
            return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
        if (url.pathname.startsWith('/api/')) {
            const mine = accountAnswer(panel.account, route.request(), url);
            if (mine) {
                if (route.request().headers()['x-requested-by'] !== 'notfckbot-panel')
                    return route.fulfill({ status: 403, json: { error: 'The API answers the admin panel only' } });
                if (mine.status && mine.body) return route.fulfill({ status: mine.status, json: mine.body });
                return route.fulfill({ status: 200, json: mine });
            }
            // As src/account/guard.js: the rest of the API is for a signed-in admin (posters are open)
            if (!url.pathname.startsWith('/api/poster/')) {
                if (!panel.account.signedIn)
                    return route.fulfill({ status: 401, json: { error: 'Sign in: /login in the bot' } });
                if (panel.account.role !== 'admin')
                    return route.fulfill({ status: 403, json: { error: 'Only for the panel admins' } });
            }
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

        // A sign-in link from the bot is the panel's own page
        const isPage = url.pathname === '/' || url.pathname.startsWith('/login/');
        const rel = isPage ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
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

    await page.goto(`${ORIGIN}${options.path || '/'}`);
    return panel;
}

module.exports = { mockPanel, ORIGIN, chatStats };
