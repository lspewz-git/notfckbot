/** The release history page: what came out in a year among the titles in the database. */
const { releaseHistory } = require('../../history');

const router = require('express').Router();

router.get('/api/history', async (req, res) => {
    const year = /^\d{4}$/.test(String(req.query.year || '')) ? Number(req.query.year) : null;
    try {
        res.json(await releaseHistory({ year }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
