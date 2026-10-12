/** Series and film cards, their posters, and TMDB search. */
const axios = require('axios');
const { Subscription, Watchlist } = require('../../db');
const { getProxyAgent } = require('../../proxy');
const tmdb = require('../../api/tmdb');

const router = require('express').Router();

router.get('/api/series/:tmdbId', async (req, res) => {
    try {
        const { tmdbId } = req.params;
        const numericId = tmdbId.replace('tv_', '');
        if (!/^\d+$/.test(numericId)) return res.status(400).json({ error: 'Bad series id' });
        const [details, subs] = await Promise.all([
            // Cached: the update check refreshes it for every tracked series
            tmdb.getDetailsCached(numericId, 'tv'),
            Subscription.count({ where: { seriesId: tmdbId } })
        ]);
        res.json({ ...details, subCount: subs });
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
        const [details, waiting, notified] = await Promise.all([
            tmdb.getDetailsCached(numericId, 'movie'),
            // Chats, not rows: a chat can hold the same film twice (old duplicates)
            Watchlist.count({ where: { tmdb_id: id, notified: false }, distinct: true, col: 'chatId' }),
            Watchlist.count({ where: { tmdb_id: id, notified: true }, distinct: true, col: 'chatId' })
        ]);
        res.json({ ...details, waiting, notified });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// TMDB posters through this server: image.tmdb.org is blocked on some networks the
// panel is opened from, while the server can reach it. Fixed host, strict path.
const POSTER_SIZES = new Set(['w185', 'w342', 'w500']);
router.get('/api/poster/:size/:file', async (req, res) => {
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

router.get('/api/tmdb/search', async (req, res) => {
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

module.exports = router;
