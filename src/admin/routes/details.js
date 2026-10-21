/** Series and film cards, their posters, and TMDB search. */
const { Chat, Series, Subscription, Watchlist } = require('../../db');
const tmdb = require('../../api/tmdb');
const { findKinopoiskIdQuick } = require('../../api/kinopoisk');
const { getWatchLinks } = require('../../constants');
const { servePoster } = require('../posters');

// What the card shows of a chat: enough for its name and avatar
const CHAT_FIELDS = ['id', 'username', 'type'];

const router = require('express').Router();
const { log } = require('../../log');
const { z, valid, text } = require('../validate');

router.get('/api/series/:tmdbId', async (req, res) => {
    try {
        const { tmdbId } = req.params;
        const numericId = tmdbId.replace('tv_', '');
        if (!/^\d+$/.test(numericId)) return res.status(400).json({ error: 'Bad series id' });
        const [details, subs] = await Promise.all([
            // Cached: the update check refreshes it for every tracked series
            tmdb.getDetailsCached(numericId, 'tv'),
            Subscription.findAll({
                where: { seriesId: tmdbId },
                attributes: ['notify_type'],
                include: [{ model: Chat, attributes: CHAT_FIELDS }]
            })
        ]);
        const subscribers = subs.filter((s) => s.Chat).map((s) => ({ chat: s.Chat, mode: s.notify_type }));
        res.json({ ...details, subCount: subs.length, subscribers });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Film card: TMDB details plus how many chats wait for it / were told it's out
router.get('/api/movie/:tmdbId', async (req, res) => {
    try {
        const numericId = String(req.params.tmdbId).replace('movie_', '');
        if (!/^\d+$/.test(numericId)) return res.status(400).json({ error: 'Bad film id' });
        const id = `movie_${numericId}`;
        const [details, entries] = await Promise.all([
            tmdb.getDetailsCached(numericId, 'movie'),
            Watchlist.findAll({
                where: { tmdb_id: id },
                attributes: ['notified', 'ru_premiere', 'ru_digital', 'ru_services', 'ru_checked_at'],
                include: [{ model: Chat, attributes: CHAT_FIELDS }]
            })
        ]);
        // Chats, not rows: a chat can hold the same film twice (old duplicates)
        const chats = new Map();
        for (const e of entries) {
            if (!e.Chat) continue;
            const known = chats.get(e.Chat.id);
            // Told once is told: a duplicate row still waiting doesn't undo it
            chats.set(e.Chat.id, { chat: e.Chat, notified: Boolean(e.notified) || Boolean(known && known.notified) });
        }
        // The Russian dates the update check keeps, from the row it asked Kinopoisk for last
        const ruRow = entries
            .filter((e) => e.ru_checked_at)
            .sort((a, b) => new Date(b.ru_checked_at) - new Date(a.ru_checked_at))[0];
        const dates = {
            release: details.release_date || null,
            digital: details.digital_release_date || null,
            digitalCountry: details.digital_release_country || null,
            ruPremiere: (ruRow && ruRow.ru_premiere) || null,
            ruDigital: (ruRow && ruRow.ru_digital) || null,
            ruServices: (ruRow && ruRow.ru_services) || null
        };
        const list = [...chats.values()];
        res.json({
            ...details,
            dates,
            waiting: list.filter((c) => !c.notified).length,
            notified: list.filter((c) => c.notified).length,
            chats: list
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * The card's Kinopoisk link, asked separately so the card never waits for the lookup:
 * straight to the title when its ID is known, a search otherwise. `type` is tv or movie,
 * `id` the numeric TMDB ID.
 */
router.get('/api/kinopoisk/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    if (!['tv', 'movie'].includes(type) || !/^\d+$/.test(id)) return res.status(400).json({ error: 'Bad id' });
    try {
        const tmdbId = `${type}_${id}`;
        // TMDB only adds the title and IMDb ID here; a stored Kinopoisk ID works without it
        const details = await tmdb.getDetailsCached(id, type).catch(() => null);
        const title = (details && (details.name || details.title)) || '';
        // A tracked series has its ID stored by the update check; anything else is looked up
        const row = type === 'tv' ? await Series.findByPk(tmdbId, { attributes: ['kinopoisk_id'] }) : null;
        const kinopoiskId =
            (row && row.kinopoisk_id) || (await findKinopoiskIdQuick(tmdbId, (details && details.imdb_id) || null));
        const link = getWatchLinks({ title, kinopoiskId, mediaType: type }).find((l) => l.kind === 'info');
        res.json({ id: kinopoiskId || null, url: link.url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// TMDB posters through this server: image.tmdb.org is blocked on some networks the
// panel is opened from, while the server can reach it. Kept on disk after the first fetch.
router.get('/api/poster/:size/:file', (req, res) => servePoster(req.params.size, req.params.file, res));

router.get('/api/tmdb/search', async (req, res) => {
    // One query: ?q=a&q=b arrives as an array
    const query = valid(z.object({ q: text('Query is required') }), req.query, res);
    if (!query) return;
    const { q } = query;
    try {
        const results = await tmdb.searchMulti(q);
        log.info(`[Admin] Search results for "${q}": ${results.length} items found.`);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
