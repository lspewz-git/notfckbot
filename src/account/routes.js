/**
 * Signing in, and the users' own pages in the panel (/api/account/…): one chat's list, calendar and
 * settings for a signed-in user who may open that chat (src/account/members.js). Who may call what
 * is src/account/guard.js; changes go through src/chat-ops.js, like the panel's own.
 */
const router = require('express').Router();
const { Chat, Series, Subscription, Watchlist } = require('../db');
const tmdb = require('../api/tmdb');
const ops = require('../chat-ops');
const { listPeriod, periodItems } = require('../calendar');
const { ZONES, PRESETS } = require('../quiet');
const { getWatchLinks, isFinishedStatus, escapeHtml } = require('../constants');
const { deliver } = require('../delivery');
const { z, valid, idOf, chatId, text } = require('../admin/validate');
const { rateLimit, MemoryStore, ipKeyGenerator } = require('express-rate-limit');
const auth = require('./auth');
const password = require('./password');
const roles = require('./roles');
const { accessTo, chatsOf } = require('./members');
const { log } = require('../log');

/** A refusal from src/chat-ops.js with its own status; anything else is a 500 without details. */
const fail = (res, err) => {
    if (err instanceof ops.OpError) return res.status(err.status).json({ error: err.message });
    log.error(`[Account] ${err.message}`);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
};

// --- Signing in and out (src/account/guard.js lets these through without a session) ---

router.post('/api/login', async (req, res) => {
    const body = valid(z.object({ token: z.string({ error: 'Bad token' }) }), req.body, res);
    if (!body) return;
    try {
        const session = await auth.redeemLink(body.token);
        if (!session) return res.status(401).json({ error: 'This link has expired. Send /login to the bot again.' });
        auth.setCookie(req, res, session.token);
        res.json({ chatId: session.chatId });
    } catch (err) {
        fail(res, err);
    }
});

/** The bot's @username for the t.me link: known once the bot has started, else asked (a few seconds at most). */
async function botUsername(bot) {
    if (bot.botInfo && bot.botInfo.username) return bot.botInfo.username;
    const me = await Promise.race([
        bot.telegram.getMe(),
        new Promise((resolve) => setTimeout(resolve, 3000, null))
    ]).catch(() => null);
    return me && me.username;
}

// "Войти через Telegram": a code for this page, and the bot's link that carries it
router.post('/api/login/telegram', async (req, res) => {
    try {
        const username = await botUsername(req.app.get('bot'));
        if (!username) throw new ops.OpError(503, "Telegram isn't answering. Try again later.");
        const { code, secret, check } = auth.startCode();
        res.json({ code, secret, check, url: `https://t.me/${username}?start=L${code}` });
    } catch (err) {
        fail(res, err);
    }
});

router.post('/api/login/telegram/poll', async (req, res) => {
    const body = valid(z.object({ code: z.string(), secret: z.string() }, { error: 'Bad code' }), req.body, res);
    if (!body) return;
    try {
        const result = await auth.pollCode(body.code, body.secret);
        if (result.state === 'in') auth.setCookie(req, res, result.token);
        res.json({ state: result.state });
    } catch (err) {
        fail(res, err);
    }
});

// A password (src/account/password.js): wrong tries are limited per address and per login, so
// guessing takes years and spreading it over many addresses still stops at one account's limit
const LIMIT_WINDOW_MS = 15 * 60 * 1000;
const limitStores = [];
const limitBy = (limit, keyGenerator) => {
    const store = new MemoryStore();
    limitStores.push(store);
    return rateLimit({
        windowMs: LIMIT_WINDOW_MS,
        limit,
        store,
        skipSuccessfulRequests: true,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: { error: 'Too many attempts. Try again in 15 minutes.' },
        ...(keyGenerator ? { keyGenerator } : {})
    });
};
/**
 * The account a login names: its id and its @username share one count. The system account's login
 * is known to all ("admin"): counted per address too, so tries from elsewhere can't lock out the
 * way back in
 */
function loginLimitKey(req) {
    const account = req.loginUserId || password.loginKey(req.body && req.body.login);
    return account === roles.SYSTEM_ID ? `login:${account}:${ipKeyGenerator(req.ip)}` : `login:${account}`;
}
// The address first: the lookup behind the account's limit asks the database
const passwordLimits = [
    limitBy(5),
    async (req, res, next) => {
        try {
            req.loginUserId = await password.userIdFor(req.body && req.body.login);
            next();
        } catch (err) {
            fail(res, err);
        }
    },
    limitBy(10, loginLimitKey)
];
/** For the tests: every limit starts again. */
const resetLimits = () => limitStores.forEach((store) => store.resetAll());

router.post('/api/login/password', passwordLimits, async (req, res) => {
    const body = valid(
        z.object({
            login: z
                .string({ error: 'Enter your Telegram username or id' })
                .trim()
                .min(1, { error: 'Enter your Telegram username or id' })
                .max(64),
            password: z
                .string({ error: 'Enter a password' })
                .min(1, { error: 'Enter a password' })
                .max(password.MAX_LENGTH)
        }),
        req.body,
        res
    );
    if (!body) return;
    try {
        const session = await password.signInWithPassword(body.login, body.password);
        if (!session) return res.status(401).json({ error: 'Wrong username or password.' });
        auth.setCookie(req, res, session.token);
        res.json({ success: true });
    } catch (err) {
        fail(res, err);
    }
});

router.post('/api/logout', async (req, res) => {
    try {
        await auth.endSession(req.user);
        auth.clearCookie(res);
        res.json({ success: true });
    } catch (err) {
        fail(res, err);
    }
});

// Who is signed in and as what: no Telegram in it, so the panel opens at once even when Telegram is down
router.get('/api/account/me', async (req, res) => {
    try {
        const { userId, userName: name, role, system } = req.user;
        const hasPassword = system ? true : await password.hasPassword(userId);
        res.json({ user: { id: userId, name, role, hasPassword, system } });
    } catch (err) {
        fail(res, err);
    }
});

// The user's own password: set or changed (the session proves who they are), or removed. A change
// or removal signs them out on their other devices, and the bot tells them either way
router.put('/api/account/password', async (req, res) => {
    if (req.user.system) return res.status(400).json({ error: "The system account's password is in Settings" });
    const body = valid(z.object({ password: password.PASSWORD }), req.body, res);
    if (!body) return;
    const { userId } = req.user;
    try {
        const had = await password.hasPassword(userId);
        await password.setPassword(userId, body.password);
        if (had) await auth.endOtherSessions(userId, req.user.id);
        password.notifyPassword(req.app.get('bot'), userId, had ? 'changed' : 'set');
        res.json({ hasPassword: true });
    } catch (err) {
        fail(res, err);
    }
});

router.delete('/api/account/password', async (req, res) => {
    if (req.user.system) return res.status(400).json({ error: "The system account's password is in Settings" });
    const { userId } = req.user;
    try {
        if (await password.removePassword(userId)) {
            await auth.endOtherSessions(userId, req.user.id);
            password.notifyPassword(req.app.get('bot'), userId, 'removed');
        }
        res.json({ hasPassword: false });
    } catch (err) {
        fail(res, err);
    }
});

// "Sign out on other devices" on the account page: this session stays
router.post('/api/account/sessions/end-others', async (req, res) => {
    try {
        const ended = await auth.endOtherSessions(req.user.userId, req.user.id);
        res.json({ ended });
    } catch (err) {
        fail(res, err);
    }
});

// The chats the user can open: asks Telegram about the groups, a few seconds at most
router.get('/api/account/chats', async (req, res) => {
    try {
        // The system account is nobody in Telegram: no chats of its own
        res.json(req.user.system ? [] : await chatsOf(req.user.userId));
    } catch (err) {
        fail(res, err);
    }
});

// --- One chat ---

const chatParams = z.object({ chatId: chatId() });

/** The chat from the path, once the user may open it: req.chatId and req.access. */
async function openChat(req, res, next) {
    const params = valid(chatParams, req.params, res);
    if (!params) return;
    try {
        const access = await accessTo(req.user.userId, params.chatId);
        if (!access) return res.status(403).json({ error: 'You have no access to this chat' });
        req.chatId = params.chatId;
        req.access = access;
        next();
    } catch (err) {
        fail(res, err);
    }
}

const who = (req) => ({ userId: req.user.userId, userName: req.user.userName, source: 'account' });

/** "https://image.tmdb.org/t/p/w500/abc.jpg" → "/abc.jpg", for /api/poster */
const posterPath = (url) => (url ? (String(url).match(/\/[A-Za-z0-9]+\.(jpg|png)$/) || [null])[0] : null);

const linksOf = (title, kinopoiskId, mediaType) =>
    getWatchLinks({ title, kinopoiskId, mediaType }).map(({ url, kind }) => ({
        // The bot's labels are Russian; the panel is in English
        label: kind === 'watch' ? 'Watch on SSPoisk' : 'Kinopoisk',
        url,
        kind
    }));

const kinopoiskUrlOf = (title, kinopoiskId, mediaType) => {
    const info = getWatchLinks({ title, kinopoiskId, mediaType }).find((l) => l.kind === 'info');
    return info ? info.url : null;
};

router.get('/api/account/chats/:chatId/list', openChat, async (req, res) => {
    try {
        const [subs, films] = await Promise.all([
            Subscription.findAll({ where: { chatId: req.chatId }, include: [Series] }),
            Watchlist.findAll({ where: { chatId: req.chatId, notified: false }, order: [['id', 'ASC']] })
        ]);
        const series = subs
            .filter((s) => s.Series)
            .map(({ notify_type: mode, Series: s }) => ({
                id: s.tmdb_id,
                title: s.title,
                poster: posterPath(s.poster_url),
                mode,
                finished: isFinishedStatus(s.status),
                lastSeason: s.last_season,
                lastEpisode: s.last_episode,
                next: s.next_episode_date
                    ? { date: s.next_episode_date, season: s.next_episode_season, episode: s.next_episode_number }
                    : null,
                genres: s.genres,
                networks: s.networks,
                links: linksOf(s.title, s.kinopoisk_id, 'tv')
            }))
            .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
        res.json({
            access: req.access,
            series,
            films: films.map((f) => ({
                id: f.id,
                tmdbId: f.tmdb_id,
                title: f.title,
                poster: posterPath(f.poster_url),
                year: f.year,
                date: f.premiere_digital,
                ruPremiere: f.ru_premiere,
                ruDigital: f.ru_digital,
                genres: f.genres,
                links: linksOf(f.title, null, 'movie')
            }))
        });
    } catch (err) {
        fail(res, err);
    }
});

const seriesBody = z.object({
    tmdbId: idOf(/^(tv_)?\d{1,10}$/, 'Bad series id'),
    mode: z.enum(ops.NOTIFY_TYPES, { error: 'Bad mode' })
});

router.post('/api/account/chats/:chatId/series', openChat, async (req, res) => {
    const body = valid(seriesBody, req.body, res);
    if (!body) return;
    try {
        const { created, subscription } = await ops.subscribe(req.chatId, body.tmdbId, body.mode, who(req));
        res.json({ created, mode: subscription.notify_type });
    } catch (err) {
        fail(res, err);
    }
});

router.delete('/api/account/chats/:chatId/series/:seriesId', openChat, async (req, res) => {
    const params = valid(
        z.object({ seriesId: idOf(/^tv_\d{1,10}$/, 'Bad series id') }),
        { seriesId: req.params.seriesId },
        res
    );
    if (!params) return;
    try {
        res.json({ removed: await ops.unsubscribe(req.chatId, params.seriesId, who(req)) });
    } catch (err) {
        fail(res, err);
    }
});

router.post('/api/account/chats/:chatId/films', openChat, async (req, res) => {
    const body = valid(z.object({ tmdbId: idOf(/^(movie_)?\d{1,10}$/, 'Bad film id') }), req.body, res);
    if (!body) return;
    try {
        const { entry, isReleased } = await ops.addFilm(req.chatId, body.tmdbId, who(req));
        res.json({ id: entry.id, released: isReleased });
    } catch (err) {
        if (err.status === 409) err.message = 'This film is already on the list';
        fail(res, err);
    }
});

router.delete('/api/account/chats/:chatId/films/:id', openChat, async (req, res) => {
    const params = valid(z.object({ id: idOf(/^\d{1,15}$/, 'Bad id') }), { id: req.params.id }, res);
    if (!params) return;
    try {
        res.json({ removed: await ops.removeFilm(params.id, { chatId: req.chatId, who: who(req) }) });
    } catch (err) {
        fail(res, err);
    }
});

// Search: TMDB's results, marked with what this chat already has
router.get('/api/account/chats/:chatId/search', openChat, async (req, res) => {
    const query = valid(z.object({ q: text('Enter a title') }), req.query, res);
    if (!query) return;
    try {
        const [results, subs, films] = await Promise.all([
            tmdb.searchMulti(query.q.slice(0, 100)),
            Subscription.findAll({ where: { chatId: req.chatId }, attributes: ['seriesId'] }),
            Watchlist.findAll({ where: { chatId: req.chatId, notified: false }, attributes: ['tmdb_id'] })
        ]);
        const have = new Set([...subs.map((s) => s.seriesId), ...films.map((f) => f.tmdb_id)]);
        res.json(
            results.slice(0, 20).map((r) => {
                const id = `${r.media_type}_${r.id}`;
                const date = r.release_date || r.first_air_date || '';
                return {
                    tmdbId: id,
                    kind: r.media_type,
                    title: r.title || r.name || r.original_title || r.original_name || 'Untitled',
                    year: date.slice(0, 4) || null,
                    poster: r.poster_path || null,
                    released:
                        r.media_type === 'movie' && Boolean(date) && date <= new Date().toISOString().slice(0, 10),
                    added: have.has(id)
                };
            })
        );
    } catch (err) {
        log.warn(`[Account] Search failed: ${err.message}`);
        fail(res, new ops.OpError(502, "Search isn't answering. Try again later."));
    }
});

// Calendar: one list from yesterday on
router.get('/api/account/chats/:chatId/calendar', openChat, async (req, res) => {
    try {
        const chat = await Chat.findByPk(req.chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });
        const p = listPeriod(chat.timezone);
        const { items, failed } = await periodItems(req.chatId, p.from, p.to);
        res.json({
            ...p,
            items: items.map((i) => ({
                date: i.date,
                kind: i.kind,
                tmdbId: i.tmdbId,
                title: i.title,
                ...(i.kind === 'tv'
                    ? { season: i.season, episode: i.episode, mark: i.mark, name: i.name, overview: i.overview }
                    : {}),
                poster: posterPath(i.poster),
                kinopoiskUrl: kinopoiskUrlOf(i.title, i.kinopoiskId, i.kind === 'tv' ? 'tv' : 'movie')
            })),
            failed
        });
    } catch (err) {
        fail(res, err);
    }
});

// Settings: anyone who may open the chat sees them; in a group only its admins change them
router.get('/api/account/chats/:chatId/settings', openChat, async (req, res) => {
    try {
        const chat = await Chat.findByPk(req.chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });
        res.json({
            settings: ops.settingsOf(chat),
            canChange: req.access.settings,
            group: String(req.chatId).startsWith('-'),
            zones: ZONES.map(({ id, en, offset }) => ({ id, city: en, offset })),
            presets: PRESETS
        });
    } catch (err) {
        fail(res, err);
    }
});

router.patch('/api/account/chats/:chatId/settings', openChat, async (req, res) => {
    if (!req.access.settings) return res.status(403).json({ error: "Only the group's admins change its settings" });
    const body = valid(ops.settingsSchema, req.body, res);
    if (!body) return;
    try {
        const { chat, lines } = await ops.updateSettings(req.chatId, body, who(req));
        // The group sees who changed its settings, and from what to what
        if (lines.length && String(req.chatId).startsWith('-')) {
            const name = req.user.userName || `id ${req.user.userId}`;
            deliver(
                req.app.get('bot'),
                req.chatId,
                [`⚙️ ${escapeHtml(name)} изменил(а) настройки:`, ...lines.map((l) => escapeHtml(l))].join('\n')
            ).catch((err) => log.warn(`[Account] Settings note to ${req.chatId} failed: ${err.message}`));
        }
        res.json({ settings: ops.settingsOf(chat) });
    } catch (err) {
        fail(res, err);
    }
});

module.exports = { router, resetLimits, loginLimitKey };
