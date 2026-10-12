/** Panel-wide actions: broadcast, run the update check, test notification, wipe the database. */
const { Chat, Series, Subscription, Watchlist } = require('../../db');
const { checkUpdates, buildSeriesMessages } = require('../../cron');
const { formatWatchLinks } = require('../../constants');
const { findKinopoiskIdQuick } = require('../../api/kinopoisk');
const tmdb = require('../../api/tmdb');

const router = require('express').Router();

const BROADCAST_TARGETS = {
    all: {},
    private: { type: 'private' },
    groups: { type: ['group', 'supergroup', 'channel'] }
};

router.post('/api/broadcast', async (req, res) => {
    const { message, target = 'all' } = req.body;
    if (!message || !message.trim()) {
        return res.status(400).json({ error: 'Message is required' });
    }

    const where = BROADCAST_TARGETS[target];
    if (!where) {
        return res.status(400).json({ error: `Unknown target "${target}"` });
    }

    const bot = req.app.get('bot');
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

router.post('/api/trigger-check', async (req, res) => {
    const bot = req.app.get('bot');
    try {
        checkUpdates(bot); // Run in background, don't await
        res.json({ success: true, message: 'Update check started' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/test-notification', async (req, res) => {
    const { chatId, seriesId, mode = 'episode', season, episode, episodeName } = req.body;
    if (!chatId) {
        return res.status(400).json({ error: 'chatId is required' });
    }
    if (!seriesId) {
        return res.status(400).json({ error: 'seriesId is required' });
    }

    const bot = req.app.get('bot');
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

router.post('/api/clear-all', async (req, res) => {
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

module.exports = router;
