/** One record at a time: subscriptions, films, and a chat's block or direct message. */
const { Chat, Series, Subscription, Watchlist } = require('../../db');
const tmdb = require('../../api/tmdb');
const { deliver } = require('../../delivery');

const router = require('express').Router();

router.delete('/api/subscription/:chatId/:seriesId', async (req, res) => {
    const { chatId, seriesId } = req.params;
    try {
        await Subscription.destroy({ where: { chatId, seriesId } });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/subscription', async (req, res) => {
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
            // From the latest aired episode, as the bot does: never announce what is already out
            series = await Series.create({ tmdb_id: fulltmdbId, ...tmdb.newSeriesFields(details) });
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

router.post('/api/chat/:chatId/block', async (req, res) => {
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

// The chat's bot settings, the same ones its ⚙️ Settings screen in Telegram changes
const BUTTONS_MODES = ['owner', 'all'];
router.patch('/api/chat/:chatId/settings', async (req, res) => {
    const { buttons_mode: buttonsMode, menu_enabled: menuEnabled } = req.body || {};
    const changes = {};
    if (buttonsMode !== undefined) {
        if (!BUTTONS_MODES.includes(buttonsMode)) return res.status(400).json({ error: 'Bad buttons_mode' });
        changes.buttons_mode = buttonsMode;
    }
    if (menuEnabled !== undefined) {
        if (typeof menuEnabled !== 'boolean') return res.status(400).json({ error: 'Bad menu_enabled' });
        changes.menu_enabled = menuEnabled;
    }
    if (!Object.keys(changes).length) return res.status(400).json({ error: 'Nothing to change' });
    try {
        const chat = await Chat.findByPk(req.params.chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });
        await chat.update(changes);
        res.json({ success: true, buttons_mode: chat.buttons_mode, menu_enabled: chat.menu_enabled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/chat/:chatId/unblock', async (req, res) => {
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

// Films

router.post('/api/watchlist', async (req, res) => {
    const { chatId, tmdbId } = req.body;
    if (!chatId || !tmdbId) {
        return res.status(400).json({ error: 'chatId and tmdbId are required' });
    }

    try {
        const chat = await Chat.findByPk(chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });

        // Rows are stored as "movie_<id>": the request may send either form, so normalise it
        // before looking for a duplicate
        const numericId = String(tmdbId).replace('movie_', '');
        if (!/^\d+$/.test(numericId)) return res.status(400).json({ error: 'Bad film id' });
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
            notified: isReleased // If already released, mark as notified so cron doesn't pick it up
        });

        res.json({ success: true, entry, isReleased });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/chat/:chatId/message', async (req, res) => {
    const { chatId } = req.params;
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

    const bot = req.app.get('bot');
    try {
        const result = await deliver(bot, chatId, `✉️ <b>Сообщение от администратора:</b>\n\n${message}`);
        if (result.status !== 'sent') throw new Error(result.error);
        console.log(`[Admin] Direct message sent to ${chatId}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/api/watchlist/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await Watchlist.destroy({ where: { id } });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
