/** One record at a time: subscriptions, films, and a chat's block or direct message. */
const { Chat, Series, Subscription, Watchlist } = require('../../db');
const tmdb = require('../../api/tmdb');
const { deliver } = require('../../delivery');
const { ZONES, isHour } = require('../../quiet');
const { sentMarkOnEnable } = require('../../cron/digests');
const { NOTIFY_LABELS } = require('../../constants');
const { z, valid, idOf, chatId, text } = require('../validate');

const router = require('express').Router();
const events = require('../../chat-events');
const { log } = require('../../log');

const seriesId = idOf(/^tv_\d+$/, 'Bad series id');
const chatParam = z.object({ chatId: chatId() });

router.delete('/api/subscription/:chatId/:seriesId', async (req, res) => {
    const params = valid(z.object({ chatId: chatId(), seriesId }), req.params, res);
    if (!params) return;
    const { chatId: chat, seriesId: series } = params;
    try {
        // Changes from the panel count for the chat's statistics too, with nobody as who did them
        const removed = await Subscription.destroy({ where: { chatId: chat, seriesId: series } });
        if (removed) {
            const row = await Series.findByPk(series);
            events.record(chat, { kind: 'unsubscribed', tmdb_id: series, title: row && row.title });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const REQUIRED = 'chatId and tmdbId are required';
const subscriptionBody = z.object({
    chatId: chatId(REQUIRED),
    tmdbId: idOf(/^(tv_)?\d+$/, REQUIRED),
    notify_type: z.enum(Object.keys(NOTIFY_LABELS), { error: 'Bad notify_type' }).optional()
});

router.post('/api/subscription', async (req, res) => {
    const body = valid(subscriptionBody, req.body, res);
    if (!body) return;
    const { chatId, tmdbId, notify_type } = body;

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
            // From the latest aired episode, as the bot does: never announce what is already out
            series = await Series.create({ tmdb_id: fulltmdbId, ...tmdb.newSeriesFields(details) });
        }

        // 3. Create or update subscription
        const [sub, created] = await Subscription.findOrCreate({
            where: { chatId, seriesId: fulltmdbId },
            defaults: { notify_type: notify_type || 'episode' }
        });

        if (!created && notify_type && sub.notify_type !== notify_type) {
            await sub.update({ notify_type });
            events.record(chatId, { kind: 'mode', detail: notify_type, tmdb_id: fulltmdbId, title: series.title });
        }
        if (created) {
            events.record(chatId, {
                kind: 'subscribed',
                detail: sub.notify_type,
                tmdb_id: fulltmdbId,
                title: series.title
            });
        }

        res.json({ success: true, created, subscription: sub });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Up to a year; 5 minutes when the panel sends none
const blockBody = z.object({
    minutes: z.coerce
        .number({ error: 'Minutes: a whole number from 1' })
        .int({ error: 'Minutes: a whole number from 1' })
        .min(1, { error: 'Minutes: a whole number from 1' })
        .max(525600, { error: 'Minutes: a year at most' })
        .default(5)
});

router.post('/api/chat/:chatId/block', async (req, res) => {
    const params = valid(chatParam, req.params, res);
    const body = params && valid(blockBody, req.body, res);
    if (!body) return;
    try {
        const chat = await Chat.findByPk(params.chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });

        const duration = body.minutes;
        const blockUntil = new Date(Date.now() + duration * 60 * 1000);

        await chat.update({ blockedUntil: blockUntil });
        res.json({ success: true, blockedUntil: blockUntil });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// The chat's bot settings, the same ones its ⚙️ Settings screen in Telegram changes
const BUTTONS_MODES = ['owner', 'all'];
const QUIET = 'Quiet hours: two different hours from 0 to 23, or both off';
const quietHour = z.union([z.null(), z.number().refine(isHour)], { error: QUIET }).optional();
const chatSettingsBody = z
    .object({
        quiet_start: quietHour,
        quiet_end: quietHour,
        timezone: z
            .enum(
                ZONES.map((zone) => zone.id),
                { error: 'Unknown time zone' }
            )
            .optional(),
        digest_week: z.boolean({ error: 'Bad digest_week' }).optional(),
        digest_month: z.boolean({ error: 'Bad digest_month' }).optional(),
        buttons_mode: z.enum(BUTTONS_MODES, { error: 'Bad buttons_mode' }).optional(),
        menu_enabled: z.boolean({ error: 'Bad menu_enabled' }).optional()
    })
    // Quiet hours: both hours (0–23, not the same) or both null for off
    .refine(
        ({ quiet_start: start, quiet_end: end }) =>
            (start === undefined && end === undefined) ||
            (start === null && end === null) ||
            (isHour(start) && isHour(end) && start !== end),
        { error: QUIET }
    );

router.patch('/api/chat/:chatId/settings', async (req, res) => {
    const params = valid(chatParam, req.params, res);
    const body = params && valid(chatSettingsBody, req.body, res);
    if (!body) return;
    // What was sent, as it is stored; what was left out stays
    const changes = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
    if (!Object.keys(changes).length) return res.status(400).json({ error: 'Nothing to change' });
    try {
        const chat = await Chat.findByPk(params.chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });
        // A digest turned on starts with the next one due, as in the bot (src/cron/digests.js)
        for (const which of ['week', 'month']) {
            if (changes[`digest_${which}`] && !chat[`digest_${which}`]) {
                changes[`digest_${which}_sent`] = sentMarkOnEnable(which === 'week' ? 'w' : 'm', {
                    ...chat.get(),
                    ...changes
                });
            }
        }
        await chat.update(changes);
        res.json({
            success: true,
            buttons_mode: chat.buttons_mode,
            menu_enabled: chat.menu_enabled,
            quiet_start: chat.quiet_start,
            quiet_end: chat.quiet_end,
            timezone: chat.timezone,
            digest_week: chat.digest_week,
            digest_month: chat.digest_month
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/chat/:chatId/unblock', async (req, res) => {
    const params = valid(chatParam, req.params, res);
    if (!params) return;
    const { chatId } = params;
    try {
        const chat = await Chat.findByPk(chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });

        await chat.update({ blockedUntil: null });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Films

const watchlistBody = z.object({ chatId: chatId(REQUIRED), tmdbId: idOf(/^(movie_)?\d+$/, 'Bad film id') });

router.post('/api/watchlist', async (req, res) => {
    const body = valid(watchlistBody, req.body, res);
    if (!body) return;
    const { chatId, tmdbId } = body;

    try {
        const chat = await Chat.findByPk(chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });

        // Rows are stored as "movie_<id>": the request may send either form, so normalise it
        // before looking for a duplicate
        const numericId = tmdbId.replace('movie_', '');
        const fullTmdbId = `movie_${numericId}`;
        const rows = await Watchlist.findAll({ where: { chatId, tmdb_id: fullTmdbId } });
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
            ...tmdb.titleFacts(details, 'movie'),
            notified: isReleased // If already released, mark as notified so cron doesn't pick it up
        });
        events.record(chatId, { kind: 'film_added', tmdb_id: fullTmdbId, title: entry.title });

        res.json({ success: true, entry, isReleased });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/chat/:chatId/message', async (req, res) => {
    const params = valid(chatParam, req.params, res);
    const body = params && valid(z.object({ message: text('Message is required') }), req.body, res);
    if (!body) return;
    const { chatId } = params;
    const { message } = body;

    const bot = req.app.get('bot');
    try {
        const result = await deliver(bot, chatId, `✉️ <b>Сообщение от администратора:</b>\n\n${message}`);
        if (result.status !== 'sent') throw new Error(result.error);
        log.info(`[Admin] Direct message sent to ${chatId}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/api/watchlist/:id', async (req, res) => {
    const params = valid(z.object({ id: idOf(/^\d{1,15}$/, 'Bad id') }), req.params, res);
    if (!params) return;
    const { id } = params;
    try {
        const entry = await Watchlist.findByPk(id);
        if (entry) {
            await entry.destroy();
            events.record(entry.chatId, { kind: 'film_removed', tmdb_id: entry.tmdb_id, title: entry.title });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
