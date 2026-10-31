/**
 * The sign-in and the user's own chats on the panel's fake API (tests/mock-panel.js takes these in).
 * mockPanel(page, { role: 'user' }) signs in as a user, { signedOut: true } shows the sign-in screen;
 * the default is an admin, so the panel's other tests run as before. What the page sent is in
 * panel.account.sent. A password sign-in takes "@me" or "42" with "good-password" ({ hasPassword }
 * says whether one is set to begin with); "too-many" is answered as the rate limit.
 */

const series = () => [
    {
        id: 'tv_100',
        title: 'Одни из нас',
        poster: null,
        mode: 'episode',
        finished: false,
        lastSeason: 2,
        lastEpisode: 4,
        next: { date: '2026-11-04', season: 2, episode: 5 },
        genres: 'Драма',
        networks: 'HBO',
        links: [{ label: 'Kinopoisk', url: 'https://www.kinopoisk.ru/series/1/', kind: 'info' }]
    },
    {
        id: 'tv_200',
        title: 'Северные воды',
        poster: null,
        mode: 'season',
        finished: false,
        lastSeason: 2,
        lastEpisode: 8,
        next: null,
        genres: null,
        networks: null,
        links: []
    },
    {
        id: 'tv_300',
        title: 'Тед Лассо',
        poster: null,
        mode: 'first_and_full',
        finished: true,
        lastSeason: 3,
        lastEpisode: 12,
        next: null,
        genres: null,
        networks: null,
        links: []
    }
];

const films = () => [
    {
        id: 7,
        tmdbId: 'movie_7',
        title: 'Дюна: Часть третья',
        poster: null,
        year: 2026,
        date: '2026-12-18',
        ruPremiere: null,
        ruDigital: null,
        genres: 'Фантастика',
        links: []
    }
];

/** @param {{ role?: 'admin' | 'user', signedOut?: boolean, groupAdmin?: boolean, hasPassword?: boolean, system?: boolean }} options */
// A chat's change log (src/chat-changes.js): 23 rows, the newest first, one of each kind among them
const CHANGE_KINDS = [
    ['subscribed', 'episode', 'The Bear', '@igor', 'bot'],
    ['settings', 'quiet', 'Тихие часы: выключены → 23:00–08:00', 'Анна', 'account'],
    ['mode', 'season', 'Severance', 'Admin', 'panel'],
    ['film_removed', null, 'Dune: Part Three', '@igor', 'bot'],
    ['film_added', null, 'Mickey 17', 'Анна', 'account']
];
const CHANGES = Array.from({ length: 23 }, (_, i) => {
    const [kind, detail, title, userName, source] = CHANGE_KINDS[i % CHANGE_KINDS.length];
    return {
        at: new Date(Date.UTC(2026, 9, 30, 12) - i * 3600e3).toISOString(),
        kind,
        detail,
        title,
        userName,
        source
    };
});

/** A page of the log as the API answers it: ?page, size and q (a title or a name). */
function changesPage(url, rows = CHANGES) {
    const page = Number(url.searchParams.get('page') || 1);
    const size = Number(url.searchParams.get('size') || 10);
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const found = rows.filter((r) => !q || [r.title, r.userName].some((v) => v && v.toLowerCase().includes(q)));
    return { total: found.length, rows: found.slice((page - 1) * size, page * size), keepDays: 30 };
}

function accountState(options) {
    return {
        signedIn: !options.signedOut,
        hasPassword: Boolean(options.hasPassword),
        // Signed in as the system account (not a Telegram user)
        system: Boolean(options.system),
        role: options.role || 'admin',
        sent: /** @type {{ method: string, path: string, body: any }[]} */ ([]),
        polls: 0,
        chats: [
            { id: '42', type: 'private', title: 'My account', settings: true },
            { id: '-100', type: 'supergroup', title: 'Киноклуб', settings: Boolean(options.groupAdmin) }
        ],
        series: series(),
        films: films(),
        settings: {
            buttons_mode: 'owner',
            menu_enabled: true,
            quiet_start: 23,
            quiet_end: 9,
            timezone: 'Europe/Moscow',
            digest_week: true,
            digest_month: false
        }
    };
}

const bodyOf = (req) => {
    try {
        return req.postData() ? req.postDataJSON() : null;
    } catch {
        return null;
    }
};

const SEARCH = [
    { tmdbId: 'tv_500', kind: 'tv', title: 'Дюна: Пророчество', year: '2024', poster: null, added: false },
    { tmdbId: 'movie_7', kind: 'movie', title: 'Дюна: Часть третья', year: '2026', poster: null, added: true },
    { tmdbId: 'movie_8', kind: 'movie', title: 'Дюна', year: '2021', poster: null, released: true, added: false }
];

// From yesterday on; the episode out a week ago is one the page must still leave out
const CALENDAR = {
    from: '2026-11-03',
    to: '2027-01-31',
    today: '2026-11-04',
    failed: 0,
    items: [
        {
            date: '2026-10-28',
            kind: 'tv',
            tmdbId: 'tv_100',
            title: 'Одни из нас',
            season: 2,
            episode: 4,
            mark: '',
            name: 'Day One',
            overview: '',
            poster: '/p1.jpg',
            kinopoiskUrl: 'https://www.kinopoisk.ru/series/1/'
        },
        {
            date: '2026-11-04',
            kind: 'tv',
            tmdbId: 'tv_100',
            title: 'Одни из нас',
            season: 2,
            episode: 5,
            mark: 'finale',
            name: 'Feel Her Love',
            overview: 'Ellie and Dina head out.',
            poster: '/p1.jpg',
            kinopoiskUrl: 'https://www.kinopoisk.ru/series/1/'
        },
        {
            date: '2026-11-03',
            kind: 'movie',
            tmdbId: 'movie_6',
            title: 'Мегалополис',
            poster: null,
            kinopoiskUrl: 'https://www.kinopoisk.ru/index.php?kp_query=y'
        },
        {
            date: '2026-11-06',
            kind: 'movie',
            tmdbId: 'movie_7',
            title: 'Дюна: Часть третья',
            poster: null,
            kinopoiskUrl: 'https://www.kinopoisk.ru/index.php?kp_query=x'
        },
        {
            date: '2027-01-15',
            kind: 'tv',
            tmdbId: 'tv_999',
            title: 'Gone Show',
            season: 4,
            episode: 1,
            mark: 'premiere',
            name: '',
            overview: '',
            poster: null,
            kinopoiskUrl: 'https://www.kinopoisk.ru/series/9/'
        }
    ]
};

/** Answers for /api/login…, /api/logout and /api/account/…, or null when the path is not one of them. */
function accountAnswer(state, req, url) {
    const p = url.pathname;
    const method = req.method();
    const body = bodyOf(req);
    if (!/^\/api\/(login|logout|account\/)/.test(p)) return null;
    state.sent.push({ method, path: p + url.search, body });

    if (p === '/api/login') {
        if (body && body.token === 'good-token') {
            state.signedIn = true;
            return { chatId: '-100' };
        }
        return { status: 401, body: { error: 'This link has expired. Send /login to the bot again.' } };
    }
    if (p === '/api/login/password') {
        if (body.password === 'too-many')
            return { status: 429, body: { error: 'Too many attempts. Try again in 15 minutes.' } };
        if (['@me', '42'].includes(body.login) && body.password === 'good-password') {
            state.signedIn = true;
            return { success: true };
        }
        return { status: 401, body: { error: 'Wrong username or password.' } };
    }
    if (p === '/api/login/telegram') {
        return {
            code: 'c'.repeat(32),
            secret: 's'.repeat(43),
            check: '0427',
            url: 'https://t.me/notfckbot?start=Lcode'
        };
    }
    if (p === '/api/login/telegram/poll') {
        // "Да, это я" is pressed in the bot by the second question
        state.polls += 1;
        if (state.polls < 2) return { state: 'waiting' };
        state.signedIn = true;
        return { state: 'in' };
    }
    if (!state.signedIn) return { status: 401, body: { error: 'Sign in: /login in the bot' } };
    if (p === '/api/logout') {
        state.signedIn = false;
        return { success: true };
    }
    if (p === '/api/account/me')
        return {
            user: {
                id: state.system ? '0' : '42',
                name: state.system ? 'admin' : '@me',
                role: state.role,
                hasPassword: state.hasPassword,
                system: state.system
            }
        };
    if (p === '/api/account/password') {
        if (method === 'PUT' && body.password.length < 8)
            return { status: 400, body: { error: 'At least 8 characters' } };
        state.hasPassword = method === 'PUT';
        return { hasPassword: state.hasPassword };
    }
    if (p === '/api/account/chats') return state.chats;

    const m = /^\/api\/account\/chats\/(-?\d+)(\/.*)$/.exec(p);
    if (!m) return { status: 404, body: { error: 'Not mocked' } };
    const [, chatId, rest] = m;
    const chat = state.chats.find((c) => c.id === chatId);
    if (rest === '/list') {
        return { access: { edit: true, settings: chat.settings }, series: state.series, films: state.films };
    }
    if (rest === '/series' && method === 'POST') {
        const s = state.series.find((x) => x.id === body.tmdbId);
        if (s) s.mode = body.mode;
        return { created: !s, mode: body.mode };
    }
    if (rest.startsWith('/series/') && method === 'DELETE') {
        state.series = state.series.filter((x) => x.id !== decodeURIComponent(rest.slice(8)));
        return { removed: true };
    }
    if (rest === '/films' && method === 'POST') return { id: 9, released: false };
    if (rest.startsWith('/films/') && method === 'DELETE') {
        state.films = state.films.filter((x) => String(x.id) !== rest.slice(7));
        return { removed: true };
    }
    if (rest === '/search') return SEARCH;
    if (rest === '/calendar') return CALENDAR;
    if (rest === '/settings' && method === 'GET') {
        return {
            settings: state.settings,
            canChange: chat.settings,
            group: chatId.startsWith('-'),
            zones: [
                { id: 'Europe/Moscow', city: 'Moscow', offset: 3 },
                { id: 'Asia/Yekaterinburg', city: 'Yekaterinburg', offset: 5 }
            ],
            presets: [
                [23, 9],
                [22, 8]
            ]
        };
    }
    if (rest === '/settings' && method === 'PATCH') {
        if (!chat.settings) return { status: 403, body: { error: "Only the group's admins change its settings" } };
        Object.assign(state.settings, body);
        return { settings: state.settings };
    }
    return { status: 404, body: { error: 'Not mocked' } };
}

module.exports = { accountState, accountAnswer, changesPage, CHANGES };
