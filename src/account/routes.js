/**
 * Signing in, and the users' own pages in the panel (/api/account/…): one chat's list, calendar and
 * settings for a signed-in user who may open that chat (src/account/members.js). Who may call what
 * is src/account/guard.js; changes go through src/chat-ops.js, like the panel's own.
 */
const router = require('express').Router();
const { Chat, Series, Subscription, Watchlist, HiddenChat } = require('../db');
const tmdb = require('../api/tmdb');
const kinopoisk = require('../api/kinopoisk');
const ops = require('../chat-ops');
const { listPeriod, periodItems, todayIn } = require('../calendar');
const { nextDayIn } = require('../episode-times');
const history = require('../history');
const { ZONES, PRESETS } = require('../quiet');
const { getWatchLinks, isFinishedStatus, escapeHtml } = require('../constants');
const { deliver } = require('../delivery');
const { z, valid, idOf, chatId, text } = require('../admin/validate');
const { rateLimit, MemoryStore } = require('express-rate-limit');
const auth = require('./auth');
const { miniAppUser } = require('./miniapp');
const password = require('./password');
const devices = require('./devices');
const { accessTo, chatsOf } = require('./members');
const { log } = require('../log');
const QRCode = require('qrcode');
const { confirmation } = require('./confirmation');
const { lruCache } = require('../lru');
const { notifyDays } = require('./notify-day');
const { rowFilmDates, isReleased: filmIsReleased } = require('../film-release');
const confirmationCooldown = lruCache({ max: 2000, ttl: 60000 });

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
        if (!session) return res.status(401).json({ error: 'This link has expired. Sign in again.' });
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
const challengeLimit = rateLimit({ windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const pollLimit = rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });

/**
 * The chat the Mini App was opened from, for the panel to open first; null for the user's own. Only a
 * choice: the chat list (src/account/members.js) still decides whether this user may open it.
 */
async function launchChat(user) {
    if (user.startChat) return user.startChat;
    if (!user.chatInstance) return null;
    try {
        const chat = await Chat.findOne({ where: { chat_instance: user.chatInstance }, attributes: ['id'] });
        return chat ? String(chat.id) : null;
    } catch (err) {
        log.warn(`[Account] Mini App chat lookup failed: ${err.message}`);
        return null;
    }
}

router.post('/api/login/miniapp', challengeLimit, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.secure) return res.status(403).json({ error: 'Telegram Mini App sign-in requires HTTPS.' });
    const body = valid(
        z.object({
            initData: z.string().min(1).max(8192),
            // Telegram.WebApp.platform, only to name the device in Account settings
            platform: z
                .string()
                .regex(/^[a-z_]{1,16}$/)
                .optional()
        }),
        req.body,
        res
    );
    if (!body) return;
    const user = miniAppUser(body.initData, req.app.get('bot')?.telegram?.token);
    if (!user)
        return res.status(401).json({ error: 'Telegram sign-in could not be verified. Reopen the app in Telegram.' });
    try {
        const existing = await auth.sessionOf(req);
        if (existing && existing.userId !== String(user.userId))
            return res
                .status(409)
                .json({ error: 'Another account is signed in. Sign it out before opening the Mini App.' });
        if (!existing && !(await auth.isAllowed(user.userId)))
            return res.status(403).json({ error: 'No access to the panel.' });
        const name = devices.telegramName(body.platform, req.get('user-agent'));
        const result = await auth.redeemMiniAppLaunch(user, existing, Date.now(), name);
        if (!result)
            return res.status(401).json({ error: 'This sign-in was already used. Reopen the app in Telegram.' });
        if (result.token) auth.setCookie(req, res, result.token);
        // Signed by Telegram: this browser becomes a known one
        await devices
            .remember(req, res, user.userId, { trusted: true })
            .catch((err) => log.warn(`[Account] Remembering the device failed: ${err.message}`));
        res.json({ success: true, chatId: await launchChat(user), ...(user.title ? { title: user.title } : {}) });
    } catch (err) {
        fail(res, err);
    }
});

router.post('/api/login/telegram', challengeLimit, async (req, res) => {
    try {
        const username = await botUsername(req.app.get('bot'));
        if (!username) throw new ops.OpError(503, "Telegram isn't answering. Try again later.");
        const { expiresAt, ...start } = auth.startCode(null, null, Date.now(), devices.clientOf(req, res));
        const url = `https://t.me/${username}?start=L${start.code}`;
        const qr = await QRCode.toDataURL(url, { width: 232, margin: 4, errorCorrectionLevel: 'M' });
        res.set('Cache-Control', 'no-store').json({
            ...start,
            url,
            qr,
            expiresIn: Math.max(0, expiresAt - Date.now())
        });
    } catch (err) {
        fail(res, err);
    }
});

router.post('/api/login/telegram/poll', pollLimit, async (req, res) => {
    const body = valid(z.object({ code: z.string(), secret: z.string() }, { error: 'Bad code' }), req.body, res);
    if (!body) return;
    try {
        const result = await auth.pollCode(body.code, body.secret);
        if (result.state === 'in') {
            auth.setCookie(req, res, result.token);
            // Before the guard sees it: whether the bot asks "Это вы?" for this browser next time
            await devices
                .remember(req, res, result.userId, { trusted: result.trusted })
                .catch((err) => log.warn(`[Account] Remembering the device failed: ${err.message}`));
        }
        res.set('Cache-Control', 'no-store').json({ state: result.state });
    } catch (err) {
        fail(res, err);
    }
});

router.post('/api/login/telegram/cancel', pollLimit, (req, res) => {
    const body = valid(z.object({ code: z.string(), secret: z.string() }), req.body, res);
    if (!body) return;
    auth.cancelCode(body.code, body.secret);
    res.json({ success: true });
});

// A login name alone cannot lock out another address. Personal logins also require Telegram approval.
const passwordLimitStore = new MemoryStore();
const passwordLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    store: passwordLimitStore,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Try again in 15 minutes.' }
});
/** For the tests: every limit starts again. */
const resetLimits = () => {
    passwordLimitStore.resetAll();
    confirmationCooldown.clear();
};

router.post('/api/login/password', passwordLimit, async (req, res) => {
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
        const session = await password.signInWithPassword(
            body.login,
            body.password,
            Date.now(),
            devices.clientOf(req, res)
        );
        if (!session) return res.status(401).json({ error: 'Wrong username or password.' });
        if (session.noAccess) return res.status(403).json({ error: 'No access to the panel.' });
        if (session.token) {
            auth.setCookie(req, res, session.token);
            return res.json({ success: true });
        }
        const { code, secret, check, expiresAt, userId } = session;
        if (confirmationCooldown.has(userId)) {
            auth.cancelCode(code, secret);
            return res.status(429).json({ error: 'A confirmation was sent recently. Try again in a minute.' });
        }
        confirmationCooldown.set(userId, true);
        const bot = req.app.get('bot');
        const ask = confirmation(code);
        // Delivery retries may continue, but a late message cannot approve a cancelled challenge.
        let timer;
        try {
            const result = await Promise.race([
                deliver(bot, userId, ask.text, { extra: ask.extra }),
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve({ status: 'failed' }), 5000);
                })
            ]);
            if (result.status !== 'sent') throw new Error('Confirmation delivery failed');
        } catch {
            auth.cancelCode(code, secret);
            throw new ops.OpError(503, "Couldn't send confirmation to Telegram. Try again later.");
        } finally {
            clearTimeout(timer);
        }
        const url = bot.botInfo?.username ? `https://t.me/${bot.botInfo.username}` : null;
        res.set('Cache-Control', 'no-store').json({
            code,
            secret,
            check,
            expiresIn: Math.max(0, expiresAt - Date.now()),
            url,
            confirmation: true
        });
    } catch (err) {
        fail(res, err);
    }
});

// Called only after a deliberate browser interaction; automatic API polling never renews inactivity.
router.post('/api/account/activity', async (req, res) => {
    try {
        const [updated] = await auth.touchSessions({ id: req.user.id });
        if (!updated && !(await auth.sessionOf(req)))
            return res.status(401).json({ error: 'Your session has ended. Sign in again.' });
        res.json({ success: true });
    } catch (err) {
        fail(res, err);
    }
});

router.post('/api/logout', async (req, res) => {
    try {
        await auth.endSession(req.user);
        // A deliberate, authenticated logout must allow an immediate fresh sign-in.
        confirmationCooldown.delete(req.user.userId);
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
        // The system account's password lives in .env: always set, no date
        const changed = system ? null : await password.passwordChangedAt(userId);
        const hasPassword = system || Boolean(changed);
        res.json({ user: { id: userId, name, role, hasPassword, passwordChangedAt: changed, system } });
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
        const refusal = await devices.freshRefusal(req);
        if (refusal) return res.status(403).json({ error: refusal });
        const had = await password.hasPassword(userId);
        await password.setPassword(userId, body.password);
        if (had) await auth.endOtherSessions(userId, req.user.id);
        password.notifyPassword(req.app.get('bot'), userId, had ? 'changed' : 'set');
        res.json({ hasPassword: true, passwordChangedAt: await password.passwordChangedAt(userId) });
    } catch (err) {
        fail(res, err);
    }
});

router.delete('/api/account/password', async (req, res) => {
    if (req.user.system) return res.status(400).json({ error: "The system account's password is in Settings" });
    const { userId } = req.user;
    try {
        const refusal = await devices.freshRefusal(req);
        if (refusal) return res.status(403).json({ error: refusal });
        if (await password.removePassword(userId)) {
            await auth.endOtherSessions(userId, req.user.id);
            password.notifyPassword(req.app.get('bot'), userId, 'removed');
        }
        res.json({ hasPassword: false, passwordChangedAt: null });
    } catch (err) {
        fail(res, err);
    }
});

// The Devices list on the account page: the browsers signed in to this account, this one first
router.get('/api/account/sessions', async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store').json(await auth.listSessions(req.user));
    } catch (err) {
        fail(res, err);
    }
});

// "Sign out" on one row of the list. Like "Sign out on other devices", not from a device signed in today
router.delete('/api/account/sessions/:id', async (req, res) => {
    const params = valid(z.object({ id: z.string().regex(/^[0-9a-f]{24}$/) }), req.params, res);
    if (!params) return;
    try {
        const refusal = await devices.freshRefusal(req);
        if (refusal) return res.status(403).json({ error: refusal });
        const result = await auth.endListedSession(req.user, params.id);
        if (result === 'current') return res.status(400).json({ error: 'Use Sign out for this device' });
        if (result === 'missing') return res.status(404).json({ error: 'This device is already signed out' });
        res.json({ success: true });
    } catch (err) {
        fail(res, err);
    }
});

// "Sign out on other devices" on the account page: this session stays
router.post('/api/account/sessions/end-others', async (req, res) => {
    try {
        const refusal = await devices.freshRefusal(req);
        if (refusal) return res.status(403).json({ error: refusal });
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
        if (req.user.system) return res.json([]);
        const [chats, hidden] = await Promise.all([
            chatsOf(req.user.userId),
            HiddenChat.findAll({ where: { userId: req.user.userId }, attributes: ['chatId'], raw: true })
        ]);
        const ids = new Set(hidden.map((c) => String(c.chatId)));
        res.json(chats.map((c) => ({ ...c, hidden: c.type !== 'private' && ids.has(String(c.id)) })));
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

router.patch('/api/account/chats/:chatId/visibility', openChat, async (req, res) => {
    const body = valid(z.object({ hidden: z.boolean() }), req.body, res);
    if (!body) return;
    if (String(req.chatId) === String(req.user.userId))
        return res.status(400).json({ error: 'Your own account stays visible' });
    try {
        const key = { userId: req.user.userId, chatId: req.chatId };
        if (body.hidden) await HiddenChat.upsert(key);
        else await HiddenChat.destroy({ where: key });
        res.json({ hidden: body.hidden });
    } catch (err) {
        fail(res, err);
    }
});

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

/** Already-known id, with an exact IMDb lookup in the background on a cache miss. */
const knownTitleId = (tmdbId) => {
    const [kind, id] = String(tmdbId).split('_');
    return kinopoisk.knownKinopoiskId(tmdbId, tmdb.peekDetails(id, kind)?.imdb_id || null);
};

/** Optional card data from the warmed cache; never wait for an external service. */
const titleMetadata = (tmdbId) => {
    const [kind, id] = String(tmdbId).split('_');
    const details = tmdb.peekDetails(id, kind);
    return {
        overview: details?.overview || '',
        rating: details?.vote_average || null,
        seasons: kind === 'tv' ? details?.number_of_seasons || null : null
    };
};

const filmItem = (f, chat) => ({
    id: f.id,
    tmdbId: f.tmdb_id,
    ...titleMetadata(f.tmdb_id),
    title: f.title,
    poster: posterPath(f.poster_url),
    year: f.year,
    date: f.premiere_digital,
    ...rowFilmDates(f, chat?.notify_digital),
    genres: f.genres,
    links: linksOf(f.title, knownTitleId(f.tmdb_id), 'movie')
});

router.get('/api/account/chats/:chatId/list', openChat, async (req, res) => {
    const query = valid(
        z.object({ title: idOf(/^(tv|movie)_[1-9]\d{0,9}$/, 'Bad title id').optional() }),
        req.query,
        res
    );
    if (!query) return;
    try {
        const [subs, films, chat] = await Promise.all([
            Subscription.findAll({ where: { chatId: req.chatId }, include: [Series] }),
            Watchlist.findAll({ where: { chatId: req.chatId, notified: false }, order: [['id', 'ASC']] }),
            Chat.findByPk(req.chatId)
        ]);
        const series = subs
            .filter((s) => s.Series)
            .map(({ notify_type: mode, Series: s }) => ({
                id: s.tmdb_id,
                ...titleMetadata(s.tmdb_id),
                title: s.title,
                poster: posterPath(s.poster_url),
                mode,
                finished: isFinishedStatus(s.status),
                lastSeason: s.last_season,
                lastEpisode: s.last_episode,
                // The next episode's day in the chat's zone, like the calendar (src/episode-times.js)
                next: s.next_episode_date
                    ? {
                          date: nextDayIn(s, chat && chat.timezone),
                          season: s.next_episode_season,
                          episode: s.next_episode_number
                      }
                    : null,
                genres: s.genres,
                networks: s.networks,
                links: linksOf(s.title, s.kinopoisk_id, 'tv')
            }))
            .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
        // Released films have left the waiting list, but their notification still opens their card.
        let linkedTitle = null;
        if (query.title?.startsWith('movie_')) {
            const film = await Watchlist.findOne({
                where: { chatId: req.chatId, tmdb_id: query.title },
                order: [['id', 'DESC']]
            });
            if (film) linkedTitle = { ...filmItem(film, chat), kind: 'movie' };
        } else if (query.title) {
            const item = series.find((s) => s.id === query.title);
            if (item) linkedTitle = { ...item, kind: 'tv' };
        }
        res.json({
            access: req.access,
            today: todayIn(chat?.timezone),
            series,
            films: films.map((f) => filmItem(f, chat)),
            ...(query.title ? { linkedTitle } : {})
        });
    } catch (err) {
        fail(res, err);
    }
});

const seriesBody = z.object({
    tmdbId: idOf(/^(tv_)?[1-9]\d{0,9}$/, 'Bad series id'),
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
    const body = valid(z.object({ tmdbId: idOf(/^(movie_)?[1-9]\d{0,9}$/, 'Bad film id') }), req.body, res);
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
        res.json({
            removed: await ops.removeFilm(params.id, { chatId: req.chatId, who: who(req), allForTitle: true })
        });
    } catch (err) {
        fail(res, err);
    }
});

// Search: TMDB's results, marked with what this chat already has
router.get('/api/account/chats/:chatId/search', openChat, async (req, res) => {
    const query = valid(z.object({ q: text('Enter a title') }), req.query, res);
    if (!query) return;
    try {
        const [results, subs, films, chat] = await Promise.all([
            tmdb.searchMulti(query.q.slice(0, 100)),
            Subscription.findAll({ where: { chatId: req.chatId }, attributes: ['seriesId'] }),
            Watchlist.findAll({ where: { chatId: req.chatId, notified: false }, attributes: ['tmdb_id'] }),
            Chat.findByPk(req.chatId)
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
                    overview: r.overview || '',
                    rating: r.vote_average || null,
                    released:
                        r.media_type === 'movie' &&
                        Boolean(
                            tmdb.peekDetails(r.id, 'movie') &&
                            filmIsReleased(tmdb.peekDetails(r.id, 'movie'), {}, todayIn(chat?.timezone))
                        ),
                    added: have.has(id)
                };
            })
        );
    } catch (err) {
        log.warn(`[Account] Search failed: ${err.message}`);
        fail(res, new ops.OpError(502, "Search isn't answering. Try again later."));
    }
});

// The same release history as the bot, scoped to a chat this person may open.
router.get('/api/account/chats/:chatId/aired', openChat, async (req, res) => {
    const query = valid(z.object({ year: z.coerce.number().int().min(1900).max(9999).optional() }), req.query, res);
    if (!query) return;
    try {
        const data = await history.releaseHistory({ chatId: req.chatId, year: query.year });
        const card = (item) => ({
            ...item,
            poster: posterPath(item.poster),
            links: (item.links || []).map(({ kind, url }) => ({
                kind,
                url,
                label: kind === 'watch' ? 'Watch on SSPoisk' : 'Kinopoisk'
            }))
        });
        res.json({
            ...data,
            series: data.series.map(card),
            films: data.films.map(card)
        });
    } catch (err) {
        fail(res, err);
    }
});

// Calendar: one list from yesterday on
router.get('/api/account/chats/:chatId/calendar', openChat, async (req, res) => {
    try {
        const chat = await Chat.findByPk(req.chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });
        const p = listPeriod(chat.timezone);
        const { items, failed } = await periodItems(req.chatId, p.from, p.to, {
            digitalAlerts: chat.notify_digital,
            local: { chat }
        });
        const bells = notifyDays(items, chat);
        res.json({
            ...p,
            items: items.map((i, index) => {
                const metadata = titleMetadata(i.tmdbId);
                return {
                    date: i.date,
                    kind: i.kind,
                    tmdbId: i.tmdbId,
                    title: i.title,
                    listId: i.listId,
                    mode: i.mode,
                    genres: i.genres,
                    networks: i.networks,
                    ruPremiere: i.ruPremiere,
                    ruDigital: i.ruDigital,
                    ruServices: i.ruServices,
                    cinemaRu: i.cinemaRu,
                    ...(i.kind === 'tv'
                        ? {
                              season: i.season,
                              episode: i.episode,
                              mark: i.mark,
                              name: i.name,
                              // Only the day is known (streaming): the message waits for it to end
                              dayOnly: Boolean(i.dayOnly)
                          }
                        : {
                              event: i.event,
                              country: i.country,
                              countries: i.countries,
                              release: i.release,
                              online: i.online,
                              notifyDigital: i.notifyDigital
                          }),
                    overview: i.overview || metadata.overview,
                    rating: metadata.rating,
                    seasons: metadata.seasons,
                    poster: posterPath(i.poster),
                    kinopoiskUrl: kinopoiskUrlOf(i.title, i.kinopoiskId, i.kind === 'tv' ? 'tv' : 'movie'),
                    links: linksOf(i.title, i.kinopoiskId, i.kind === 'tv' ? 'tv' : 'movie'),
                    // The chat's day the bot writes about this row (the bell), null when its mode stays silent
                    notifyOn: bells[index]
                };
            }),
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

module.exports = { router, resetLimits };
