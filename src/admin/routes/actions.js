/** Panel-wide actions: broadcast, run the update check, test notification. */
const { Chat, Series } = require('../../db');
const { checkUpdates } = require('../../cron');
const { buildTestMessage, TEST_MODES, EPISODE_MODES, STATUS_MODES } = require('../../cron/messages');
const { formatWatchLinks } = require('../../constants');
const { findKinopoiskIdQuick } = require('../../api/kinopoisk');
const tmdb = require('../../api/tmdb');
const { deliver } = require('../../delivery');
const { z, valid, idOf, chatId, text } = require('../validate');

const router = require('express').Router();
const { log } = require('../../log');

const BROADCAST_TARGETS = {
    all: {},
    private: { type: 'private' },
    groups: { type: ['group', 'supergroup', 'channel'] }
};

const broadcastBody = z.object({
    message: text('Message is required'),
    target: z
        .enum(Object.keys(BROADCAST_TARGETS), { error: (issue) => `Unknown target "${issue.input}"` })
        .default('all')
});

router.post('/api/broadcast', async (req, res) => {
    const body = valid(broadcastBody, req.body, res);
    if (!body) return;
    const { message, target } = body;
    const where = BROADCAST_TARGETS[target];

    const bot = req.app.get('bot');
    try {
        const chats = await Chat.findAll({ where });
        let successCount = 0;
        let failCount = 0;

        for (const chat of chats) {
            const result = await deliver(bot, chat.id, `📣 <b>ОБЪЯВЛЕНИЕ:</b>\n\n${message}`);
            if (result.status === 'sent') successCount++;
            else failCount++;
            // FIX: Rate limit — Telegram allows ~30 messages/sec; 50ms keeps us safe
            await new Promise((r) => setTimeout(r, 50));
        }
        log.info(`[Admin] Broadcast to "${target}": ${successCount} delivered, ${failCount} failed.`);
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

// --- Test notifications ---
// Every alert the bot sends can be tried out; the texts come from buildTestMessage (cron/messages.js)
/** A film's "out now" test: the details the release check would have, and its poster. */
async function filmTest(filmId) {
    const numericId = String(filmId).replace('movie_', '');
    if (!/^\d+$/.test(numericId)) throw Object.assign(new Error('Bad film id'), { status: 400 });
    const data = await tmdb.getDetails(numericId, 'movie');
    const title = data.title || data.original_title;
    const entry = { title, year: data.release_date ? parseInt(data.release_date.slice(0, 4), 10) : null };
    const kinopoiskId = await findKinopoiskIdQuick(`movie_${numericId}`, data.imdb_id, 2000);
    const links = formatWatchLinks({ title, kinopoiskId, mediaType: 'movie' });
    return {
        title,
        msg: buildTestMessage('film', { film: { entry, data }, links }),
        posterUrl: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null
    };
}

/** A series test: an episode alert (with its season and episode) or a status alert. */
async function seriesTest(seriesId, mode, { season, episode, episodeName }) {
    const fullSeriesId = String(seriesId).startsWith('tv_') ? String(seriesId) : `tv_${seriesId}`;
    const numericId = String(seriesId).replace('tv_', '');

    // 1. What the database knows
    const series = await Series.findByPk(fullSeriesId);
    let title = series?.title;
    let posterUrl = series?.poster_url;
    let kinopoiskId = series?.kinopoisk_id;
    let currentSeason = season ? parseInt(season, 10) : series?.last_season || 1;
    let currentEpisode = episode ? parseInt(episode, 10) : series?.last_episode || 1;
    let epName = episodeName || series?.last_episode_name || '';

    // 2. Fresh or missing details from TMDB
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
            if (!epName && lastE && lastE.season_number === currentSeason && lastE.episode_number === currentEpisode) {
                epName = lastE.name || '';
            }

            // If the episode name is still unknown, try the specific season
            if (EPISODE_MODES.includes(mode) && !epName && currentSeason && currentEpisode) {
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
        log.info(`[Admin] TMDB fetch note for ${numericId}: ${tmdbErr.message}`);
    }

    if (!title) throw Object.assign(new Error('Series details could not be found'), { status: 404 });

    const msg = buildTestMessage(mode, {
        title,
        season: currentSeason,
        episode: currentEpisode,
        episodeName: epName || `Серия ${currentEpisode}`,
        links: formatWatchLinks({ title, kinopoiskId, mediaType: 'tv' })
    });
    // Status alerts go out as plain text, without the poster, like the real ones
    return { title, msg, posterUrl: STATUS_MODES[mode] ? null : posterUrl };
}

// Season and episode left out: the latest aired one
const episodeNumber = z.coerce.number().int().positive({ error: 'Season and episode: whole numbers from 1' });
const testBody = z
    .object({
        chatId: chatId('chatId is required'),
        mode: z.enum(TEST_MODES, { error: (issue) => `Unknown notification type: ${issue.input}` }).default('episode'),
        seriesId: idOf(/^(tv_)?\d+$/, 'Bad series id').optional(),
        filmId: idOf(/^(movie_)?\d+$/, 'Bad film id').optional(),
        season: episodeNumber.optional(),
        episode: episodeNumber.optional(),
        episodeName: z.string({ error: 'Bad episodeName' }).optional()
    })
    .superRefine((body, ctx) => {
        const field = body.mode === 'film' ? 'filmId' : 'seriesId';
        if (!body[field]) ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required` });
    });

router.post('/api/test-notification', async (req, res) => {
    const body = valid(testBody, req.body, res);
    if (!body) return;
    const { chatId, seriesId, filmId, mode, season, episode, episodeName } = body;

    const bot = req.app.get('bot');
    if (!bot) return res.status(500).json({ error: 'Bot instance not available' });

    try {
        const { title, msg, posterUrl } =
            mode === 'film'
                ? await filmTest(filmId)
                : await seriesTest(seriesId, mode, { season, episode, episodeName });

        const result = await deliver(bot, chatId, msg, { photo: posterUrl });
        if (result.status !== 'sent') throw new Error(result.error);

        log.info(`[Admin] Test notification sent to chat ${chatId} for "${title}" (mode: ${mode})`);
        res.json({ success: true, message: 'Test notification sent successfully', title, chatId, mode });
    } catch (err) {
        log.error(`[Admin] Test notification error: ${err.message}`);
        res.status(err.status || 500).json({ error: `Не удалось отправить уведомление: ${err.message}` });
    }
});

module.exports = router;
