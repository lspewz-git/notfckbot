/** The Logs page. */
const { logBuffer } = require('../log-buffer');

const router = require('express').Router();

router.get('/api/logs', (req, res) => {
    res.json(logBuffer);
});

module.exports = router;
