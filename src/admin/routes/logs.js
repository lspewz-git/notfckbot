/** The Logs page: the logger's last entries (src/log.js). */
const { logBuffer } = require('../../log');

const router = require('express').Router();

router.get('/api/logs', (req, res) => {
    res.json(logBuffer);
});

module.exports = router;
