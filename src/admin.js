const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { Op } = require('sequelize');
const {
    getProxyAgent,
    buildProxyAgent,
    applyProxyToBot,
    redactProxyUrl,
    hasProxyPassword,
    withSavedPassword
} = require('./proxy');
const { Chat, Series, Subscription, Watchlist } = require('./db');
const { checkUpdates, buildSeriesMessages } = require('./cron');
const { FINISHED_STATUS_LABELS, isFinishedStatus, formatWatchLinks } = require('./constants');
const { getKinopoiskStatus, checkKinopoiskKey, findKinopoiskIdQuick } = require('./api/kinopoisk');
const tmdb = require('./api/tmdb');

const app = express();
const PORT = 3000;

// --- Log Buffer (captured INSIDE the module, not as a global side effect) ---
const logBuffer = [];
let originalLog = null;
let originalError = null;

function startLogCapture() {
    originalLog = console.log;
    originalError = console.error;

    console.log = (...args) => {
        const text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
        logBuffer.push({ type: 'log', time: new Date().toLocaleTimeString(), text });
        if (logBuffer.length > 200) logBuffer.shift();
        originalLog.apply(console, args);
    };

    console.error = (...args) => {
        const text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
        logBuffer.push({ type: 'error', time: new Date().toLocaleTimeString(), text });
        if (logBuffer.length > 200) logBuffer.shift();
        originalError.apply(console, args);
    };
}

app.use(cors());
app.use(express.json());

// Serve static files from 'admin' directory
app.use(express.static(path.join(__dirname, '../admin')));

// --- Read-only endpoints (no auth required) ---

// TMDB statuses after which a show gets no new episodes. Subscriptions to such
// shows are "archived" — derived from Series.status alone, nothing is stored.
const FINISHED_SERIES_STATUSES = Object.keys(FINISHED_STATUS_LABELS);

app.get('/api/stats', async (req, res) => {
    try {
        const [chatsCount, seriesCount, subsCount, archivedSubsCount, filmsCount, releasedFilmsCount] =
            await Promise.all([
                Chat.count(),
                Series.count(),
                Subscription.count(),
                Subscription.count({
                    include: [{ model: Series, attributes: [], required: true }],
                    where: { '$Series.status$': { [Op.in]: FINISHED_SERIES_STATUSES } }
                }),
                Watchlist.count(),
                // Released films stay in the table as a record of what was announced
                Watchlist.count({ where: { notified: true } })
            ]);
        // A null (not yet checked) status counts as active, hence the subtraction
        const activeSubsCount = subsCount - archivedSubsCount;
        const activeFilmsCount = filmsCount - releasedFilmsCount;
        res.json({
            chatsCount,
            seriesCount,
            subsCount,
            activeSubsCount,
            archivedSubsCount,
            filmsCount,
            activeFilmsCount,
            releasedFilmsCount
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Chats whose name Telegram refused to give us (bot kicked, chat deleted...).
// Remembered so the polling admin panel doesn't retry them on every refresh.
const unresolvableChatNames = new Set();

async function backfillChatNames(chats) {
    const bot = app.get('bot');
    if (!bot) return;

    const pending = chats.filter(
        (c) => !c.username && c.type !== 'private' && !unresolvableChatNames.has(String(c.id))
    );
    if (!pending.length) return;

    await Promise.all(
        pending.map(async (chat) => {
            try {
                const info = await bot.telegram.getChat(chat.id);
                const name = info.title || (info.username ? `@${info.username}` : null);
                if (name) {
                    await chat.update({ username: name });
                } else {
                    unresolvableChatNames.add(String(chat.id));
                }
            } catch (err) {
                unresolvableChatNames.add(String(chat.id));
                console.error(`[Admin] Could not resolve name for chat ${chat.id}: ${err.message}`);
            }
        })
    );
}

app.get('/api/data/:type', async (req, res) => {
    try {
        const { type } = req.params;
        let data = [];
        if (type === 'subs') {
            const subs = await Subscription.findAll({
                include: [{ model: Chat }, { model: Series }]
            });
            // The server owns the "archived" rule so the panel never keeps its own status list
            data = subs.map((s) => ({ ...s.toJSON(), archived: isFinishedStatus(s.Series && s.Series.status) }));
        } else if (type === 'series') {
            data = await Series.findAll();
        } else if (type === 'films') {
            data = await Watchlist.findAll({
                include: [{ model: Chat }]
            });
        } else if (type === 'chats') {
            data = await Chat.findAll({
                order: [['createdAt', 'DESC']]
            });
            await backfillChatNames(data);
        }
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/stats/popular', async (req, res) => {
    try {
        const popular = await Subscription.findAll({
            attributes: [
                'seriesId',
                [Subscription.sequelize.fn('COUNT', Subscription.sequelize.col('chatId')), 'subCount']
            ],
            group: ['seriesId'],
            order: [[Subscription.sequelize.literal('subCount'), 'DESC']],
            limit: 5,
            include: [{ model: Series }]
        });
        res.json(popular);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/series/:tmdbId', async (req, res) => {
    try {
        const { tmdbId } = req.params;
        const numericId = tmdbId.replace('tv_', '');
        const [details, subs] = await Promise.all([
            tmdb.getDetails(numericId, 'tv'),
            Subscription.count({ where: { seriesId: tmdbId } })
        ]);
        res.json({ ...details, subCount: subs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Film card: TMDB details plus how many chats wait for it / were told it's out
app.get('/api/movie/:tmdbId', async (req, res) => {
    try {
        const numericId = String(req.params.tmdbId).replace('movie_', '');
        if (!/^\d+$/.test(numericId)) return res.status(400).json({ error: 'Bad film id' });
        // Older rows may still hold the bare id (see fix-watchlist-ids.js)
        const ids = [`movie_${numericId}`, numericId];
        const [details, waiting, notified] = await Promise.all([
            tmdb.getDetails(numericId, 'movie'),
            // Chats, not rows: a chat can hold the same film twice (old duplicates)
            Watchlist.count({ where: { tmdb_id: ids, notified: false }, distinct: true, col: 'chatId' }),
            Watchlist.count({ where: { tmdb_id: ids, notified: true }, distinct: true, col: 'chatId' })
        ]);
        res.json({ ...details, waiting, notified });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// TMDB posters through this server: image.tmdb.org is blocked on some networks the
// panel is opened from, while the server can reach it. Fixed host, strict path.
const POSTER_SIZES = new Set(['w185', 'w342', 'w500']);
app.get('/api/poster/:size/:file', async (req, res) => {
    const { size, file } = req.params;
    if (!POSTER_SIZES.has(size) || !/^[A-Za-z0-9]+\.(jpg|png)$/.test(file)) return res.status(400).end();
    try {
        const upstream = await axios.get(`https://image.tmdb.org/t/p/${size}/${file}`, {
            responseType: 'stream',
            timeout: 10000,
            httpsAgent: getProxyAgent(),
            proxy: false
        });
        res.set('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
        // Poster files never change under the same name
        res.set('Cache-Control', 'public, max-age=604800, immutable');
        // Without a listener, a connection dropped mid-download is an unhandled
        // 'error' event, and that takes the whole process down
        upstream.data.on('error', () => res.destroy());
        res.on('close', () => upstream.data.destroy());
        upstream.data.pipe(res);
    } catch (err) {
        res.status(err.response ? err.response.status : 502).end();
    }
});

app.get('/api/logs', (req, res) => {
    res.json(logBuffer);
});

app.get('/api/tmdb/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ error: 'Query is required' });
        const results = await tmdb.searchMulti(q);
        console.log(`[Admin] Search results for "${q}": ${results.length} items found.`);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// The dashboard polls every 10 s, and each check calls three external services.
// A short cache keeps that to a few calls a minute; saving a token clears it.
const HEALTH_TTL_MS = 30_000;
let healthCache = null;
const invalidateHealth = () => {
    healthCache = null;
};

app.get('/api/health', async (req, res) => {
    if (healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) return res.json(healthCache.value);

    const health = { telegram: false, tmdb: false, proxy: 'off', kinopoisk: 'off', kinopoiskQuota: null };
    const proxyUrl = process.env.TMDB_PROXY_URL;

    if (proxyUrl) {
        health.proxy = 'error'; // Default to error if URL exists
    }

    const [tgResult, tmdbResult, proxyResult, kpResult] = await Promise.allSettled([
        app.get('bot').telegram.getMe(),
        axios.get('https://api.themoviedb.org/3/authentication', {
            headers: { Authorization: `Bearer ${process.env.TMDB_API_KEY}` },
            timeout: 5000,
            httpsAgent: buildProxyAgent(proxyUrl),
            proxy: false
        }),
        proxyUrl
            ? axios.get('https://google.com', {
                  timeout: 5000,
                  httpsAgent: buildProxyAgent(proxyUrl),
                  proxy: false
              })
            : Promise.resolve({ status: 200 }),
        getKinopoiskStatus()
    ]);

    if (tgResult.status === 'fulfilled') health.telegram = true;
    if (tmdbResult.status === 'fulfilled' && tmdbResult.value.status === 200) health.tmdb = true;

    // Kinopoisk API (watch-link lookups): 'off' without a key, else ok/error plus today's quota
    if (kpResult.status === 'fulfilled') {
        health.kinopoisk = kpResult.value.state;
        if (kpResult.value.state === 'ok') {
            health.kinopoiskQuota = { used: kpResult.value.used, limit: kpResult.value.limit };
        }
    } else {
        health.kinopoisk = 'error';
    }

    if (proxyUrl) {
        if (proxyResult.status === 'fulfilled' && proxyResult.value.status === 200) {
            health.proxy = 'ok';
        } else {
            health.proxy = 'error';
        }
    } else {
        health.proxy = 'off';
    }

    healthCache = { at: Date.now(), value: health };
    res.json(health);
});

app.get('/api/chats', async (req, res) => {
    try {
        const chats = await Chat.findAll({ include: [Series] });
        res.json(chats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Write endpoints (auth required) ---

const BROADCAST_TARGETS = {
    all: {},
    private: { type: 'private' },
    groups: { type: ['group', 'supergroup', 'channel'] }
};

app.post('/api/broadcast', async (req, res) => {
    const { message, target = 'all' } = req.body;
    if (!message || !message.trim()) {
        return res.status(400).json({ error: 'Message is required' });
    }

    const where = BROADCAST_TARGETS[target];
    if (!where) {
        return res.status(400).json({ error: `Unknown target "${target}"` });
    }

    const bot = app.get('bot');
    try {
        const chats = await Chat.findAll({ where });
        let successCount = 0;
        let failCount = 0;

        for (const chat of chats) {
            try {
                await bot.telegram.sendMessage(chat.id, `📣 <b>ОБЪЯВЛЕНИЕ:</b>\n\n${message}`, { parse_mode: 'HTML' });
                successCount++;
            } catch (e) {
                failCount++;
            }
            // FIX: Rate limit — Telegram allows ~30 messages/sec; 50ms keeps us safe
            await new Promise((r) => setTimeout(r, 50));
        }
        console.log(`[Admin] Broadcast to "${target}": ${successCount} delivered, ${failCount} failed.`);
        res.json({ success: true, successCount, failCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/trigger-check', async (req, res) => {
    const bot = app.get('bot');
    try {
        checkUpdates(bot); // Run in background, don't await
        res.json({ success: true, message: 'Update check started' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/test-notification', async (req, res) => {
    const { chatId, seriesId, mode = 'episode', season, episode, episodeName } = req.body;
    if (!chatId) {
        return res.status(400).json({ error: 'chatId is required' });
    }
    if (!seriesId) {
        return res.status(400).json({ error: 'seriesId is required' });
    }

    const bot = app.get('bot');
    if (!bot) {
        return res.status(500).json({ error: 'Bot instance not available' });
    }

    try {
        const fullSeriesId = String(seriesId).startsWith('tv_') ? String(seriesId) : `tv_${seriesId}`;
        const numericId = String(seriesId).replace('tv_', '');

        // 1. Fetch series from DB if present
        const series = await Series.findByPk(fullSeriesId);

        let title = series?.title;
        let posterUrl = series?.poster_url;
        let kinopoiskId = series?.kinopoisk_id;
        let currentSeason = season ? parseInt(season, 10) : series?.last_season || 1;
        let currentEpisode = episode ? parseInt(episode, 10) : series?.last_episode || 1;
        let epName = episodeName || series?.last_episode_name || '';

        // 2. Fetch fresh / missing details from TMDB
        try {
            const details = await tmdb.getDetails(numericId, 'tv');
            if (details) {
                if (!title) title = details.name || details.original_name;
                if (!posterUrl && details.poster_path) {
                    posterUrl = `https://image.tmdb.org/t/p/w500${details.poster_path}`;
                }
                if (!kinopoiskId) {
                    kinopoiskId = await findKinopoiskIdQuick(fullSeriesId, details.imdb_id, 2000);
                }
                const lastE = details.last_episode_to_air;
                if (!season && lastE) currentSeason = lastE.season_number || currentSeason;
                if (!episode && lastE) currentEpisode = lastE.episode_number || currentEpisode;
                if (
                    !epName &&
                    lastE &&
                    lastE.season_number === currentSeason &&
                    lastE.episode_number === currentEpisode
                ) {
                    epName = lastE.name || '';
                }

                // If episode name is still unknown, try fetching the specific season
                if (!epName && currentSeason && currentEpisode) {
                    try {
                        const sData = await tmdb.getSeasonDetails(numericId, currentSeason);
                        const epObj = (sData?.episodes || []).find((e) => e.episode_number === currentEpisode);
                        if (epObj?.name) epName = epObj.name;
                    } catch (_) {
                        // Ignore optional season lookup failure
                    }
                }
            }
        } catch (tmdbErr) {
            console.log(`[Admin] TMDB fetch note for ${numericId}: ${tmdbErr.message}`);
        }

        if (!title) {
            return res.status(404).json({ error: 'Series details could not be found' });
        }

        const links = formatWatchLinks({ title, kinopoiskId, mediaType: 'tv' });
        const messages = buildSeriesMessages({
            title,
            season: currentSeason,
            episode: currentEpisode,
            episodeName: epName || `Серия ${currentEpisode}`,
            links
        });
        const real =
            mode === 'season' ? messages.complete : mode === 'first_and_full' ? messages.premiere : messages.episode;
        const msg = `🧪 <b>[Тестовое уведомление]</b>\n\n${real}`;

        if (posterUrl) {
            try {
                await bot.telegram.sendPhoto(chatId, posterUrl, { caption: msg, parse_mode: 'HTML' });
            } catch (photoErr) {
                console.error(`[Admin] sendPhoto failed (${photoErr.message}), falling back to sendMessage`);
                await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' });
            }
        } else {
            await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' });
        }

        console.log(`[Admin] Test notification sent to chat ${chatId} for "${title}" (mode: ${mode})`);
        res.json({ success: true, message: 'Test notification sent successfully', title, chatId, mode });
    } catch (err) {
        console.error('[Admin] Test notification error:', err.message);
        res.status(500).json({ error: `Не удалось отправить уведомление: ${err.message}` });
    }
});

app.delete('/api/subscription/:chatId/:seriesId', async (req, res) => {
    const { chatId, seriesId } = req.params;
    try {
        await Subscription.destroy({ where: { chatId, seriesId } });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/subscription', async (req, res) => {
    const { chatId, tmdbId, notify_type } = req.body;
    if (!chatId || !tmdbId) {
        return res.status(400).json({ error: 'chatId and tmdbId are required' });
    }

    // Ensure tmdbId has the 'tv_' prefix as expected by the bot and cron jobs
    const fulltmdbId = String(tmdbId).startsWith('tv_') ? String(tmdbId) : `tv_${tmdbId}`;
    const numericTmdbId = String(tmdbId).replace('tv_', '');

    try {
        // 1. Ensure Chat exists
        const chat = await Chat.findByPk(chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });

        // 2. Ensure Series exists, or fetch/create it
        let series = await Series.findByPk(fulltmdbId);
        if (!series) {
            const details = await tmdb.getDetails(numericTmdbId, 'tv');
            series = await Series.create({
                tmdb_id: fulltmdbId,
                title: details.name || details.original_name,
                last_season: details.number_of_seasons || 0,
                last_episode: 0,
                poster_url: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
                status: details.status || null
            });
        }

        // 3. Create or update subscription
        const [sub, created] = await Subscription.findOrCreate({
            where: { chatId, seriesId: fulltmdbId },
            defaults: { notify_type: notify_type || 'episode' }
        });

        if (!created && notify_type) {
            await sub.update({ notify_type });
        }

        res.json({ success: true, created, subscription: sub });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chat/:chatId/block', async (req, res) => {
    const { chatId } = req.params;
    const { minutes } = req.body;
    try {
        const chat = await Chat.findByPk(chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });

        const duration = parseInt(minutes, 10) || 5;
        const blockUntil = new Date(Date.now() + duration * 60 * 1000);

        await chat.update({ blockedUntil: blockUntil });
        res.json({ success: true, blockedUntil: blockUntil });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chat/:chatId/unblock', async (req, res) => {
    const { chatId } = req.params;
    try {
        const chat = await Chat.findByPk(chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });

        await chat.update({ blockedUntil: null });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Watchlist (Films) Management ---

app.post('/api/watchlist', async (req, res) => {
    const { chatId, tmdbId } = req.body;
    if (!chatId || !tmdbId) {
        return res.status(400).json({ error: 'chatId and tmdbId are required' });
    }

    try {
        const chat = await Chat.findByPk(chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });

        // Rows are stored as "movie_<id>"; comparing against the bare id never matched,
        // which is how the same film ended up in one chat's watchlist twice
        const numericId = String(tmdbId).replace('movie_', '');
        if (!/^\d+$/.test(numericId)) return res.status(400).json({ error: 'Bad film id' });
        const fullTmdbId = `movie_${numericId}`;
        const rows = await Watchlist.findAll({ where: { chatId, tmdb_id: [fullTmdbId, numericId] } });
        if (rows.some((r) => !r.notified)) {
            return res.status(409).json({ error: 'Film already in watchlist for this chat' });
        }

        // Fetch movie details from TMDB
        const details = await tmdb.getDetails(numericId, 'movie');

        let isReleased = false;
        if (details.status === 'Released') {
            isReleased = true;
        } else if (details.release_date) {
            const releaseDate = new Date(details.release_date);
            if (!isNaN(releaseDate) && releaseDate <= new Date()) {
                isReleased = true;
            }
        }

        // A released film is stored straight into Released; one record there is enough
        if (isReleased && rows.length) {
            return res.status(409).json({ error: "Film is already in this chat's Released list" });
        }

        const entry = await Watchlist.create({
            chatId,
            tmdb_id: fullTmdbId,
            title: details.title || details.original_title,
            poster_url: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
            year: details.release_date ? parseInt(details.release_date.split('-')[0], 10) : null,
            premiere_digital: details.release_date || null,
            notified: isReleased // If already released, mark as notified so cron doesn't pick it up
        });

        res.json({ success: true, entry, isReleased });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chat/:chatId/message', async (req, res) => {
    const { chatId } = req.params;
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

    const bot = app.get('bot');
    try {
        await bot.telegram.sendMessage(chatId, `✉️ <b>Сообщение от администратора:</b>\n\n${message}`, {
            parse_mode: 'HTML'
        });
        console.log(`[Admin] Direct message sent to ${chatId}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/watchlist/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await Watchlist.destroy({ where: { id } });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * A value .env can hold safely: one line of printable ASCII. Anything with a line
 * break could smuggle a second KEY=value line in, and .env overrides the
 * container environment on every start.
 */
const isSafeEnvValue = (value) => typeof value === 'string' && /^[\x20-\x7e]*$/.test(value);

// Helper to update a value in the .env file
const updateEnvFile = (key, value) => {
    if (!isSafeEnvValue(value)) throw new Error(`Refusing to write an unsafe value to ${key}`);
    const envPath = path.join(__dirname, '../.env');
    try {
        let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(content)) {
            // A function replacement, so a "$" in a token is not read as a pattern
            content = content.replace(regex, () => `${key}=${value}`);
        } else {
            content += `\n${key}=${value}`;
        }
        fs.writeFileSync(envPath, content, 'utf-8');
    } catch (err) {
        console.error('[Admin] Failed to write .env:', err.message);
    }
};

const PROXY_SCHEMES = ['http://', 'https://', 'socks://', 'socks4://', 'socks5://', 'socks5h://'];
const isSupportedProxyUrl = (url) => !url || PROXY_SCHEMES.some((s) => url.startsWith(s));

app.get('/api/config', (req, res) => {
    // The panel has no login, so secrets only ever leave the server masked
    res.json({
        tmdbApiKey: maskToken(process.env.TMDB_API_KEY),
        tmdbProxyUrl: redactProxyUrl(process.env.TMDB_PROXY_URL),
        proxyHasPassword: hasProxyPassword(process.env.TMDB_PROXY_URL)
    });
});

// --- External services: the TG / TMDB / KP badges open a dialog backed by these ---

/** "ad5dc619-…-73ff6d34659d" -> "ad5d*****659d". Short values are hidden entirely. */
function maskToken(token) {
    if (!token) return '';
    return token.length <= 12 ? '*****' : `${token.slice(0, 4)}*****${token.slice(-4)}`;
}

const outbound = () => ({ httpsAgent: buildProxyAgent(process.env.TMDB_PROXY_URL), proxy: false, timeout: 8000 });

/**
 * One entry per external service. `check(token)` throws if the service rejects the
 * token, otherwise returns what the dialog shows: `details` rows and, where the
 * service has one, today's `quota`.
 */
const SERVICES = {
    telegram: {
        label: 'Telegram Bot API',
        env: 'BOT_TOKEN',
        statusUrl: 'https://t.me/BotFather',
        statusLabel: 'Open @BotFather',
        // Telegraf holds the token for the life of the process
        restartOnChange: true,
        // <bot id>:<secret>. Strict, because the token becomes part of the request path
        format: /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/,
        formatHint: 'a token from @BotFather, like 123456789:AA…',
        check: async (token) => {
            const res = await axios.get(`https://api.telegram.org/bot${token}/getMe`, outbound());
            const me = res.data.result;
            return {
                details: [
                    ['Bot', `@${me.username}`],
                    ['Bot ID', String(me.id)]
                ]
            };
        }
    },
    tmdb: {
        label: 'TMDB API',
        env: 'TMDB_API_KEY',
        // The v4 Read Access Token is a JWT
        format: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
        formatHint: 'the API Read Access Token (starts with eyJ…)',
        statusUrl: 'https://status.themoviedb.org',
        statusLabel: 'Status page',
        check: async (token) => {
            await axios.get('https://api.themoviedb.org/3/authentication', {
                ...outbound(),
                headers: { Authorization: `Bearer ${token}` }
            });
            return { details: [['Quota', 'No daily limit (about 50 requests per second)']] };
        }
    },
    kinopoisk: {
        label: 'Kinopoisk API',
        env: 'KINOPOISK_API_KEY',
        format: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        formatHint: 'a Kinopoisk API key (1a2b3c4d-1a2b-…)',
        statusUrl: 'https://kinopoiskapiunofficial.tech/status',
        statusLabel: 'Status page',
        check: async (token) => {
            const q = await checkKinopoiskKey(token);
            return {
                quota: { used: q.used, limit: q.limit },
                details: [
                    ['Account', q.accountType || '—'],
                    ['Today', `${q.used} of ${q.limit} requests used`]
                ]
            };
        }
    }
};

const describeError = (err) =>
    err.response
        ? `${err.response.status} ${err.response.data?.description || err.response.statusText || ''}`.trim()
        : err.message;

// Own keys only, so "constructor" and friends are not services
const findService = (name) => (Object.hasOwn(SERVICES, name) ? SERVICES[name] : null);

app.get('/api/services/:name', async (req, res) => {
    const service = findService(req.params.name);
    if (!service) return res.status(404).json({ error: 'Unknown service' });

    const token = process.env[service.env];
    const out = {
        name: req.params.name,
        label: service.label,
        configured: Boolean(token),
        masked: maskToken(token),
        statusUrl: service.statusUrl,
        statusLabel: service.statusLabel,
        restartOnChange: Boolean(service.restartOnChange),
        ok: false,
        details: []
    };
    if (!token) return res.json(out);

    try {
        Object.assign(out, await service.check(token), { ok: true });
    } catch (err) {
        out.error = describeError(err);
    }
    res.json(out);
});

app.post('/api/services/:name', async (req, res) => {
    const service = findService(req.params.name);
    if (!service) return res.status(404).json({ error: 'Unknown service' });

    const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    if (!service.format.test(token)) {
        return res.status(400).json({ error: `That doesn't look like ${service.formatHint}` });
    }

    try {
        await service.check(token);
    } catch (err) {
        return res.status(400).json({ error: `${service.label} rejected the token: ${describeError(err)}` });
    }

    process.env[service.env] = token;
    updateEnvFile(service.env, token);
    invalidateHealth();
    console.log(`[Admin] ${service.env} updated (${maskToken(token)}).`);

    res.json({ success: true, masked: maskToken(token), restarting: Boolean(service.restartOnChange) });

    // docker-compose's restart policy brings the process straight back with the new .env
    if (service.restartOnChange) setTimeout(() => process.exit(0), 800);
});

// Update configuration at runtime and persist to .env
app.post('/api/config', (req, res) => {
    // The TMDB key is changed through /api/services/tmdb, which checks it first
    const { tmdbProxyUrl } = req.body;

    if (tmdbProxyUrl !== undefined) {
        const typed = typeof tmdbProxyUrl === 'string' ? tmdbProxyUrl.trim() : '';
        const newProxy = withSavedPassword(typed, process.env.TMDB_PROXY_URL);
        if (!isSafeEnvValue(newProxy) || /\s/.test(newProxy)) {
            return res.status(400).json({ error: 'Proxy URL must be a single line without spaces' });
        }
        if (!isSupportedProxyUrl(newProxy)) {
            return res.status(400).json({
                error: 'Proxy URL must start with http://, https://, socks4://, socks5:// or socks5h://'
            });
        }
        process.env.TMDB_PROXY_URL = newProxy;
        updateEnvFile('TMDB_PROXY_URL', newProxy);
        // TMDB picks the new agent up per request; Telegram holds onto one
        applyProxyToBot(app.get('bot'));
        invalidateHealth();
    }

    console.log('[Admin] Configuration updated successfully.');
    res.json({
        success: true,
        tmdbApiKey: maskToken(process.env.TMDB_API_KEY),
        tmdbProxyUrl: redactProxyUrl(process.env.TMDB_PROXY_URL)
    });
});

app.post('/api/clear-all', async (req, res) => {
    try {
        // Order matters: children before parents (Subscription -> Chat/Series, Watchlist -> Chat)
        const subscriptions = await Subscription.destroy({ where: {} });
        const watchlist = await Watchlist.destroy({ where: {} });
        const series = await Series.destroy({ where: {} });
        const chats = await Chat.destroy({ where: {} });
        res.json({ success: true, deleted: { subscriptions, watchlist, series, chats } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/config/test-proxy', async (req, res) => {
    const typed = typeof req.body.url === 'string' ? req.body.url.trim() : '';
    const url = withSavedPassword(typed, process.env.TMDB_PROXY_URL);

    if (!isSupportedProxyUrl(url)) {
        return res.json({ success: false, error: 'Unsupported scheme' });
    }

    const started = Date.now();
    try {
        await axios.get('https://api.themoviedb.org/3/authentication', {
            headers: { Authorization: `Bearer ${process.env.TMDB_API_KEY}` },
            timeout: 10000,
            httpsAgent: buildProxyAgent(url),
            // Ignore any HTTP(S)_PROXY picked up from the environment
            proxy: false
        });
        res.json({ success: true, ms: Date.now() - started, direct: !url });
    } catch (err) {
        const reason = err.response ? `TMDB replied ${err.response.status}` : err.code || err.message;
        res.json({ success: false, error: reason, ms: Date.now() - started });
    }
});

function startAdminServer(bot) {
    // FIX: Log capture is started here, not at module load time (avoids global side effect)
    startLogCapture();
    app.set('bot', bot);
    app.listen(PORT, () => {
        console.log(`🚀 Admin Panel running on http://localhost:${PORT}`);
    });
}

module.exports = { startAdminServer };
