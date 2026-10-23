/**
 * A chat's statistics for the panel (src/chat-stats.js): a year by default, or any days; and its
 * year's recap cards as images.
 */
const { loadChatStats } = require('../../chat-stats');
const { recapImages } = require('../../recap/render');
const { z, valid, chatId } = require('../validate');
const { log } = require('../../log');

const router = require('express').Router();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Days as YYYY-MM-DD' });
const periodQuery = z.object({
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    from: day.optional(),
    to: day.optional()
});

router.get('/api/chat/:chatId/stats', async (req, res) => {
    const params = valid(z.object({ chatId: chatId() }), req.params, res);
    const query = params && valid(periodQuery, req.query, res);
    if (!query) return;
    const year = query.year || new Date().getFullYear();
    const period = { from: query.from || `${year}-01-01`, to: query.to || `${year}-12-31` };
    if (period.from > period.to) return res.status(400).json({ error: 'The period ends before it starts' });
    try {
        const stats = await loadChatStats(params.chatId, period);
        if (!stats) return res.status(404).json({ error: 'Chat not found' });
        res.json(stats);
    } catch (err) {
        log.error(`[Admin] Chat stats for ${params.chatId} failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// The year's recap cards (src/recap/), one PNG each, for the panel's preview. Not sent anywhere
router.get('/api/chat/:chatId/recap/:n', async (req, res) => {
    const params = valid(
        z.object({ chatId: chatId(), n: z.coerce.number().int().min(1).max(6, { error: 'Cards 1 to 6' }) }),
        req.params,
        res
    );
    const query =
        params && valid(z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }), req.query, res);
    if (!query) return;
    const year = query.year || new Date().getFullYear();
    try {
        const images = await recapImages(params.chatId, year);
        if (!images) return res.status(404).json({ error: 'Chat not found' });
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.send(images[params.n - 1]);
    } catch (err) {
        log.error(`[Admin] Recap card ${params.n} for ${params.chatId} failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
