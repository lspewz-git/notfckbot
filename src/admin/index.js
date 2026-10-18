/**
 * The admin panel's server: static files from admin/ and the JSON API under /api.
 * Each route file owns one area of the panel; the bot instance reaches handlers via
 * req.app.get('bot').
 */
const express = require('express');
const path = require('path');
const { startLogCapture } = require('./log-buffer');
const { panelOnly } = require('./panel-only');
const { sweepPosters } = require('./posters');

const app = express();
const PORT = 3000;

// No CORS: the panel is served from here, and no other site may call the API
app.use('/api', panelOnly);
app.use(express.json());

// Serve static files from 'admin' directory
app.use(express.static(path.join(__dirname, '../../admin')));

app.use(require('./routes/stats'));
app.use(require('./routes/data'));
app.use(require('./routes/details'));
app.use(require('./routes/logs'));
app.use(require('./routes/health').router);
app.use(require('./routes/actions'));
app.use(require('./routes/records'));
app.use(require('./routes/config'));
app.use(require('./routes/services'));
app.use(require('./routes/history'));
app.use(require('./routes/settings'));

function startAdminServer(bot) {
    // FIX: Log capture is started here, not at module load time (avoids global side effect)
    startLogCapture();
    app.set('bot', bot);
    app.listen(PORT, () => {
        console.log(`🚀 Admin Panel running on http://localhost:${PORT}`);
    });
    // Posters on disk (./posters.js): what nobody opened for months goes, once a day
    const sweep = () =>
        sweepPosters()
            .then((n) => n && console.log(`[Posters] Removed ${n} unused from the disk cache`))
            .catch((err) => console.error('[Posters] Sweep failed:', err.message));
    sweep();
    setInterval(sweep, 24 * 60 * 60 * 1000).unref();
}

module.exports = { startAdminServer };
