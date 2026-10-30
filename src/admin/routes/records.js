/** One record at a time: subscriptions, films, and a chat's block or direct message. */
const { Chat } = require('../../db');
const { deliver } = require('../../delivery');
const ops = require('../../chat-ops');
const { changesQuery, changesOf } = require('../../chat-changes');
const { z, valid, idOf, chatId, text } = require('../validate');

const router = require('express').Router();
const { log } = require('../../log');

/** A refusal from src/chat-ops.js with its own status; anything else (TMDB's 401 too) is a 500. */
const fail = (res, err) => res.status(err instanceof ops.OpError ? err.status : 500).json({ error: err.message });

/** The admin who made a change, for the chat's change log and statistics. */
const who = (req) => ({ userId: req.user?.userId ?? null, userName: req.user?.userName ?? null, source: 'panel' });

const seriesId = idOf(/^tv_\d+$/, 'Bad series id');
const chatParam = z.object({ chatId: chatId() });

router.delete('/api/subscription/:chatId/:seriesId', async (req, res) => {
    const params = valid(z.object({ chatId: chatId(), seriesId }), req.params, res);
    if (!params) return;
    try {
        await ops.unsubscribe(params.chatId, params.seriesId, who(req));
        res.json({ success: true });
    } catch (err) {
        fail(res, err);
    }
});

const REQUIRED = 'chatId and tmdbId are required';
const subscriptionBody = z.object({
    chatId: chatId(REQUIRED),
    tmdbId: idOf(/^(tv_)?\d+$/, REQUIRED),
    notify_type: z.enum(ops.NOTIFY_TYPES, { error: 'Bad notify_type' }).optional()
});

router.post('/api/subscription', async (req, res) => {
    const body = valid(subscriptionBody, req.body, res);
    if (!body) return;
    try {
        const { subscription, created } = await ops.subscribe(body.chatId, body.tmdbId, body.notify_type, who(req));
        res.json({ success: true, created, subscription });
    } catch (err) {
        fail(res, err);
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

router.patch('/api/chat/:chatId/settings', async (req, res) => {
    const params = valid(chatParam, req.params, res);
    const body = params && valid(ops.settingsSchema, req.body, res);
    if (!body) return;
    try {
        const { chat } = await ops.updateSettings(params.chatId, body, who(req));
        res.json({ success: true, ...ops.settingsOf(chat) });
    } catch (err) {
        fail(res, err);
    }
});

// The chat's change log: who changed its list or settings, a page at a time
router.get('/api/chat/:chatId/changes', async (req, res) => {
    const params = valid(chatParam, req.params, res);
    const query = params && valid(changesQuery, req.query, res);
    if (!query) return;
    try {
        res.json(await changesOf(params.chatId, query));
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
    try {
        const { entry, isReleased } = await ops.addFilm(body.chatId, body.tmdbId, who(req));
        res.json({ success: true, entry, isReleased });
    } catch (err) {
        fail(res, err);
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
    try {
        await ops.removeFilm(params.id, { who: who(req) });
        res.json({ success: true });
    } catch (err) {
        fail(res, err);
    }
});

module.exports = router;
