/**
 * The admin panel's server: static files from admin/ and the JSON API under /api.
 * Each route file owns one area of the panel; the bot instance reaches handlers via
 * req.app.get('bot').
 */
const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { isIP } = require('node:net');
const { panelOnly } = require('./panel-only');
const { localHttpsRedirect } = require('./http-redirect');
const { guard } = require('../account/guard');
const { panelUrl } = require('../account/auth');
const { useBot } = require('../account/members');
const { sweepPosters } = require('./posters');
const { sweepChanges } = require('../chat-changes');
const { log } = require('../log');

const app = express();
const PORT = 3000;
const REDIRECT_PORT = 3001;

app.use((req, res, next) => {
    res.set({
        'Content-Security-Policy': "frame-ancestors 'self' https://web.telegram.org",
        'X-Content-Type-Options': 'nosniff'
    });
    next();
});

// The public origin is available through Caddy. Local HTTPS clients can still use the LAN address.
app.use((req, res, next) => {
    const origin = app.get('panel proxy origin');
    if (!origin) return next();
    const publicHost = `https://${req.headers.host}` === origin;
    const trustedPeer = app.get('trust proxy fn')(req.socket.remoteAddress, 0);
    if (!trustedPeer && !publicHost && !app.get('panel proxy only')) return next();
    if (!trustedPeer || !publicHost || !req.secure) return res.sendStatus(403);
    req.panelProxyOrigin = origin;
    next();
});

// Brotli (light, level 4) or gzip, whichever the browser takes, for the page, its modules, styles
// and the API's JSON: 685 KB of panel files go as ~200 KB (measured 25.10). Pictures (posters,
// recap cards) are left alone: they are compressed already
app.use(compression());

// No CORS: the panel is served from here, and no other site may call the API
app.use('/api', panelOnly);
// Then a session: admins get the whole panel, users their own chats (src/account/)
app.use('/api', guard);
app.use(express.json());

// Serve static files from 'admin' directory
app.use(express.static(path.join(__dirname, '../../admin')));
// A sign-in link from the bot (/login/<token>): the panel's page, which reads the path
app.get('/login/:token', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.sendFile(path.join(__dirname, '../../admin/index.html'));
});

// Signing in and the users' own pages
app.use(require('../account/routes').router);

app.use(require('./routes/stats'));
app.use(require('./routes/data'));
app.use(require('./routes/details'));
app.use(require('./routes/logs'));
app.use(require('./routes/health').router);
app.use(require('./routes/actions'));
app.use(require('./routes/records'));
app.use(require('./routes/chat-stats'));
app.use(require('./routes/recap'));
app.use(require('./routes/recap-cards'));
app.use(require('./routes/recap-schedule'));
app.use(require('./routes/config'));
app.use(require('./routes/services'));
app.use(require('./routes/history'));
app.use(require('./routes/settings'));
app.use(require('./routes/access'));
app.use(require('./routes/alerts'));

// Malformed JSON and the like: a short answer, never Express's page with the stack
// eslint-disable-next-line no-unused-vars
app.use('/api', (err, req, res, next) => {
    res.status(err.status && err.status < 500 ? err.status : 500).json({ error: 'Bad request' });
});

function startAdminServer(bot) {
    app.set('bot', bot);
    useBot(bot);
    const { PANEL_PROXY_IP: proxyIp, PANEL_TLS_CERT: cert, PANEL_TLS_KEY: key } = process.env;
    if (proxyIp) {
        const origin = panelUrl();
        if (!isIP(proxyIp) || !origin) {
            log.error('[Admin] Proxy mode requires a valid PANEL_PROXY_IP and HTTPS PANEL_URL');
            return;
        }
        app.set('trust proxy', proxyIp);
        app.set('panel proxy origin', origin);
        app.set('panel proxy only', !cert && !key);
    }
    if (!cert && !key) {
        const bindAddress = proxyIp ? '0.0.0.0' : '127.0.0.1';
        app.listen(PORT, bindAddress, () => log.info(`Admin panel listening on HTTP ${bindAddress}:${PORT}`));
    } else {
        try {
            const server = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, app);
            server.listen(PORT, () => {
                log.info(`Admin panel listening on HTTPS port ${PORT}`);
                const origin = panelUrl();
                if (origin) {
                    const redirect = http.createServer(localHttpsRedirect);
                    redirect.on('error', (err) => log.error(`[Admin] HTTP redirect failed: ${err.message}`));
                    redirect.listen(REDIRECT_PORT);
                }
            });
        } catch (err) {
            log.error(`[Admin] TLS configuration failed: ${err.message}`);
        }
    }
    // Posters on disk (./posters.js): what nobody opened for months goes, once a day
    const sweep = () =>
        sweepPosters()
            .then((n) => n && log.info(`[Posters] Removed ${n} unused from the disk cache`))
            .catch((err) => log.error(`[Posters] Sweep failed: ${err.message}`));
    // The chats' settings changes past the time their change log keeps (src/chat-changes.js)
    const sweepLog = () =>
        sweepChanges()
            .then((n) => n && log.info(`[Changes] Removed ${n} old settings change(s)`))
            .catch((err) => log.error(`[Changes] Sweep failed: ${err.message}`));
    const daily = () => {
        sweep();
        sweepLog();
    };
    daily();
    setInterval(daily, 24 * 60 * 60 * 1000).unref();
}

module.exports = { startAdminServer, app };
