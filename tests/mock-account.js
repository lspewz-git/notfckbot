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
        date: '2026-11-06',
        rating: 7.4,
        overview: 'A journey across the desert. '.repeat(18),
        ruPremiere: null,
        ruDigital: null,
        release: { date: '2026-11-06', country: 'BE', countries: ['BE'] },
        cinemaRu: '2027-02-18',
        online: null,
        notifyDigital: false,
        genres: 'Фантастика',
        links: [{ kind: 'info', label: 'Kinopoisk', url: 'https://www.kinopoisk.ru/index.php?kp_query=x' }]
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
        // /api/account/chats fails (Telegram down)
        chatsDown: Boolean(options.chatsDown),
        chatsWait: options.chatsWait,
        // Called before each Mini App sign-in answer (its try number from 1): a promise holds that answer
        miniAppWait: options.miniAppWait,
        miniAppTries: 0,
        // The chat the Mini App sign-in names (opened from a group)
        miniAppChat: options.miniAppChat || null,
        miniAppTitle: options.miniAppTitle || null,
        // Statuses /api/account/me answers with first, one per request
        meFails: /** @type {number[]} */ ([...(options.meFails || [])]),
        // Signed in as the system account (not a Telegram user)
        system: Boolean(options.system),
        role: options.role || 'admin',
        sent: /** @type {{ method: string, path: string, body: any }[]} */ ([]),
        polls: 0,
        // Statuses the Mini App sign-in answers with, one per try, before it lets the user in
        miniAppFails: /** @type {number[]} */ ([...(options.miniAppFails || [])]),
        confirmationState: 'in',
        // Statuses GET /api/account/sessions and DELETE /api/account/sessions/:id answer with first, one
        // per request
        devicesFails: /** @type {number[]} */ ([...(options.devicesFails || [])]),
        deviceEndFails: /** @type {number[]} */ ([...(options.deviceEndFails || [])]),
        // Statuses DELETE /api/account/password answers with first, one per request
        passwordRemoveFails: /** @type {number[]} */ ([...(options.passwordRemoveFails || [])]),
        // Account settings → Devices (/api/account/sessions): this browser first
        devices:
            options.devices ||
            [
                { id: 'a'.repeat(24), name: 'Chrome, Windows', country: 'RU', network: 'Beeline', current: true },
                { id: 'b'.repeat(24), name: 'Safari, iPhone', country: 'RU', network: 'MTS', ip: '203.0.113.24' },
                {
                    id: 'c'.repeat(24),
                    name: 'Telegram, iPhone',
                    country: 'RU',
                    network: 'MTS',
                    ip: '2a00:1fa0:4c2b:7d10:9f3e:21ab:cd34:5e6f'
                }
            ].map((d) => ({ current: false, seenAt: new Date(Date.now() - 2 * 3600_000).toISOString(), ...d })),
        chats: [
            { id: '42', type: 'private', title: 'My account', settings: true },
            {
                id: '-100',
                type: 'supergroup',
                title: 'Киноклуб',
                settings: Boolean(options.groupAdmin),
                ...(options.groupHidden ? { hidden: true } : {})
            }
        ],
        series: series(),
        films: films(),
        releasedFilms: options.releasedFilms || [],
        calendar: structuredClone(CALENDAR),
        unfollowError: false,
        settings: {
            buttons_mode: 'owner',
            menu_enabled: true,
            quiet_start: 23,
            quiet_end: 9,
            timezone: 'Europe/Moscow',
            notify_digital: false,
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
    {
        tmdbId: 'tv_500',
        kind: 'tv',
        title: 'Дюна: Пророчество',
        year: '2024',
        poster: null,
        rating: 7.1,
        overview: 'The Sisterhood begins.',
        added: false
    },
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
            rating: 8.7,
            seasons: 2,
            mode: 'episode',
            poster: '/p1.jpg',
            kinopoiskUrl: 'https://www.kinopoisk.ru/series/1/',
            links: [{ kind: 'watch', label: 'Watch on SSPoisk', url: 'https://sspoisk.ru/series/1/' }],
            // The bot writes the next morning (src/account/notify-day.js)
            notifyOn: '2026-11-05',
            // Streaming without an hour: the card explains the wait
            dayOnly: true
        },
        {
            date: '2026-11-03',
            kind: 'movie',
            tmdbId: 'movie_6',
            listId: 6,
            event: 'release',
            estimate: false,
            country: 'US',
            title: 'Мегалополис',
            poster: null,
            kinopoiskUrl: 'https://www.kinopoisk.ru/index.php?kp_query=y'
        },
        {
            date: '2026-11-06',
            kind: 'movie',
            tmdbId: 'movie_7',
            listId: 7,
            event: 'release',
            release: { date: '2026-11-06', country: 'BE', countries: ['BE'] },
            online: null,
            notifyDigital: false,
            country: 'BE',
            genres: 'Фантастика',
            title: 'Дюна: Часть третья',
            overview: 'A journey across the desert. '.repeat(18),
            rating: 7.4,
            poster: null,
            kinopoiskUrl: 'https://www.kinopoisk.ru/index.php?kp_query=x',
            notifyOn: '2026-11-06'
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
        return { status: 401, body: { error: 'This link has expired. Sign in again.' } };
    }
    if (p === '/api/login/password') {
        if (body.password === 'too-many')
            return { status: 429, body: { error: 'Too many attempts. Try again in 15 minutes.' } };
        if (['@me', '42'].includes(body.login) && body.password === 'good-password') {
            state.polls = 0;
            return {
                confirmation: true,
                code: 'c'.repeat(32),
                secret: 's'.repeat(43),
                check: '042719',
                expiresIn: 300000
            };
        }
        if (body.login === 'admin' && body.password === 'good-password') {
            state.signedIn = true;
            return { success: true };
        }
        return { status: 401, body: { error: 'Wrong username or password.' } };
    }
    if (p === '/api/login/telegram') {
        state.polls = 0;
        return {
            code: 'c'.repeat(32),
            secret: 's'.repeat(43),
            check: '042719',
            expiresIn: 300000,
            qr: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+l8AAAAASUVORK5CYII=',
            url: 'https://t.me/notfckbot?start=Lcode'
        };
    }
    if (p === '/api/login/telegram/poll') {
        // "Да, это я" is pressed in the bot by the second question
        state.polls += 1;
        if (state.polls < 2) return { state: 'waiting' };
        if (state.confirmationState !== 'in') return { state: state.confirmationState };
        state.signedIn = true;
        return { state: 'in' };
    }
    if (p === '/api/login/telegram/cancel') return { success: true };
    if (p === '/api/login/miniapp') {
        if (body?.initData !== 'auth_date=123&hash=test')
            return { status: 401, body: { error: 'Invalid Telegram launch data' } };
        const fail = state.miniAppFails.shift();
        if (fail) return { status: fail, body: { error: `Mini App sign-in failed (${fail})` } };
        state.signedIn = true;
        return { success: true, chatId: state.miniAppChat, title: state.miniAppTitle };
    }
    if (!state.signedIn) return { status: 401, body: { error: 'Sign in to the panel.' } };
    if (p === '/api/account/activity') return { success: true };
    if (p === '/api/logout') {
        state.signedIn = false;
        return { success: true };
    }
    if (p === '/api/account/me' && state.meFails.length) {
        const fail = state.meFails.shift();
        return { status: fail, body: { error: `Account check failed (${fail})` } };
    }
    if (p === '/api/account/me')
        return {
            user: {
                id: state.system ? '0' : '42',
                name: state.system ? 'admin' : '@me',
                role: state.role,
                hasPassword: state.hasPassword,
                passwordChangedAt: state.passwordChangedAt || null,
                system: state.system
            }
        };
    if (p === '/api/account/password' && method === 'DELETE' && state.passwordRemoveFails.length) {
        const fail = state.passwordRemoveFails.shift();
        return {
            status: fail,
            body: { error: 'For your safety, a device can do this one day after its first sign-in.' }
        };
    }
    if (p === '/api/account/password') {
        if (method === 'PUT' && body.password.length < 8)
            return { status: 400, body: { error: 'At least 8 characters' } };
        state.hasPassword = method === 'PUT';
        state.passwordChangedAt = state.hasPassword ? new Date().toISOString() : null;
        return { hasPassword: state.hasPassword, passwordChangedAt: state.passwordChangedAt };
    }
    if (p === '/api/account/sessions/end-others') {
        const ended = state.devices.filter((d) => !d.current).length;
        state.devices = state.devices.filter((d) => d.current);
        return { ended };
    }
    if (p === '/api/account/sessions' && state.devicesFails.length) {
        const fail = state.devicesFails.shift();
        return { status: fail, body: { error: `Devices failed (${fail})` } };
    }
    if (p === '/api/account/sessions') return state.devices;
    const device = /^\/api\/account\/sessions\/([0-9a-f]{24})$/.exec(p);
    if (device && method === 'DELETE' && state.deviceEndFails.length) {
        const fail = state.deviceEndFails.shift();
        return {
            status: fail,
            body: { error: 'For your safety, a device can do this one day after its first sign-in.' }
        };
    }
    if (device && method === 'DELETE') {
        const before = state.devices.length;
        state.devices = state.devices.filter((d) => d.id !== device[1] || d.current);
        return before === state.devices.length
            ? { status: 404, body: { error: 'This device is already signed out' } }
            : { success: true };
    }
    if (p === '/api/account/chats')
        return state.chatsDown ? { status: 503, body: { error: "Telegram isn't answering" } } : state.chats;

    const m = /^\/api\/account\/chats\/(-?\d+)(\/.*)$/.exec(p);
    if (!m) return { status: 404, body: { error: 'Not mocked' } };
    const [, chatId, rest] = m;
    const chat = state.chats.find((c) => c.id === chatId);
    if (rest === '/visibility' && method === 'PATCH') {
        if (state.visibilityError) return { status: 503, body: { error: 'Could not save visibility' } };
        if (!chat || chat.type === 'private') return { status: 400, body: { error: 'Cannot hide this chat' } };
        chat.hidden = body.hidden;
        return { hidden: chat.hidden };
    }
    if (rest === '/list') {
        const target = url.searchParams.get('title');
        const linked = target?.startsWith('movie_')
            ? [...state.films, ...state.releasedFilms].find((f) => f.tmdbId === target)
            : state.series.find((s) => s.id === target);
        return {
            access: { edit: true, settings: chat.settings },
            today: state.calendar.today,
            series: state.series,
            films: state.films,
            ...(target
                ? { linkedTitle: linked ? { ...linked, kind: target.startsWith('movie_') ? 'movie' : 'tv' } : null }
                : {})
        };
    }
    if (rest === '/series' && method === 'POST') {
        const save = () => {
            const s = state.series.find((x) => x.id === body.tmdbId);
            if (s) s.mode = body.mode;
            return { created: !s, mode: body.mode };
        };
        return state.modeHold ? state.modeHold.then(save) : save();
    }
    if (rest.startsWith('/series/') && method === 'DELETE') {
        const remove = () => {
            if (state.unfollowError) return { status: 503, body: { error: 'Could not unfollow' } };
            state.series = state.series.filter((x) => x.id !== decodeURIComponent(rest.slice(8)));
            state.calendar.items = state.calendar.items.filter((x) => x.tmdbId !== decodeURIComponent(rest.slice(8)));
            return { removed: true };
        };
        return state.unfollowHold ? state.unfollowHold.then(remove) : remove();
    }
    if (rest === '/films' && method === 'POST') return { id: 9, released: false };
    if (rest.startsWith('/films/') && method === 'DELETE') {
        if (state.unfollowError) return { status: 503, body: { error: 'Could not unfollow' } };
        const film =
            state.films.find((x) => String(x.id) === rest.slice(7)) ||
            state.calendar.items.find((x) => String(x.listId) === rest.slice(7));
        state.films = state.films.filter((x) => x.tmdbId !== film?.tmdbId);
        state.calendar.items = state.calendar.items.filter((x) => x.tmdbId !== film?.tmdbId);
        return { removed: true };
    }
    if (rest === '/search') return SEARCH;
    if (rest === '/calendar') return state.calendar;
    if (rest === '/aired') {
        const year = Number(url.searchParams.get('year') || 2026);
        if (state.aired) return state.aired(year, chatId);
        return {
            years: [2026, 2025],
            year,
            series: [
                {
                    tmdbId: 'tv_100',
                    title: chatId === '-100' ? 'Group release' : 'Одни из нас',
                    poster: null,
                    seasons: [year === 2026 ? 2 : 1],
                    seasonPremieres: [
                        { season: year === 2026 ? 2 : 1, date: year === 2026 ? '2025-12-28' : `${year}-03-20` }
                    ],
                    genres: ['драма'],
                    networks: 'HBO',
                    rating: 8.6,
                    overview: 'A released season description. '.repeat(80),
                    links: [
                        { kind: 'watch', label: 'Watch on SSPoisk', url: 'https://www.sspoisk.ru/series/1/' },
                        { kind: 'info', label: 'Kinopoisk', url: 'https://www.kinopoisk.ru/series/1/' }
                    ],
                    kinopoiskUrl: 'https://www.kinopoisk.ru/series/1/'
                }
            ],
            films:
                year === 2026
                    ? [
                          {
                              tmdbId: 'movie_9',
                              listId: 9,
                              title: 'Released film',
                              poster: null,
                              genres: ['фантастика'],
                              date: '2026-03-01',
                              rating: 7.4,
                              overview: 'A released film description. '.repeat(80),
                              ruPremiere: '2026-02-26',
                              dates: state.airedFilmDates,
                              links: [
                                  { kind: 'watch', label: 'Watch on SSPoisk', url: 'https://www.sspoisk.ru/film/9/' },
                                  { kind: 'info', label: 'Kinopoisk', url: 'https://www.kinopoisk.ru/film/9/' }
                              ],
                              kinopoiskUrl: 'https://www.kinopoisk.ru/film/9/'
                          }
                      ]
                    : []
        };
    }
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
