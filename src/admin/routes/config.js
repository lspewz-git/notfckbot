/** The proxy dialog: current settings, saving them, and testing a candidate. */
const axios = require('axios');
const {
    buildProxyAgent,
    applyProxyToBot,
    redactProxyUrl,
    hasProxyPassword,
    withSavedPassword
} = require('../../proxy');
const { isSafeEnvValue, updateEnvFile, maskToken } = require('../env');
const { invalidateHealth } = require('./health');

const router = require('express').Router();

const PROXY_SCHEMES = ['http://', 'https://', 'socks://', 'socks4://', 'socks5://', 'socks5h://'];
const isSupportedProxyUrl = (url) => !url || PROXY_SCHEMES.some((s) => url.startsWith(s));

router.get('/api/config', (req, res) => {
    // The panel has no login, so secrets only ever leave the server masked
    res.json({
        tmdbApiKey: maskToken(process.env.TMDB_API_KEY),
        tmdbProxyUrl: redactProxyUrl(process.env.TMDB_PROXY_URL),
        proxyHasPassword: hasProxyPassword(process.env.TMDB_PROXY_URL)
    });
});

// Update configuration at runtime and persist to .env
router.post('/api/config', (req, res) => {
    // The TMDB key is changed through /api/services/tmdb, which checks it first
    const { tmdbProxyUrl } = req.body;

    if (tmdbProxyUrl !== undefined) {
        const typed = typeof tmdbProxyUrl === 'string' ? tmdbProxyUrl.trim() : '';
        const newProxy = withSavedPassword(typed, process.env.TMDB_PROXY_URL);
        if (!isSafeEnvValue(newProxy) || /\s/.test(newProxy)) {
            return res.status(400).json({ error: 'Proxy URL must be a single line without spaces' });
        }
        if (!isSupportedProxyUrl(newProxy)) {
            return res.status(400).json({
                error: 'Proxy URL must start with http://, https://, socks4://, socks5:// or socks5h://'
            });
        }
        process.env.TMDB_PROXY_URL = newProxy;
        updateEnvFile('TMDB_PROXY_URL', newProxy);
        // TMDB picks the new agent up per request; Telegram holds onto one
        applyProxyToBot(req.app.get('bot'));
        invalidateHealth();
    }

    console.log('[Admin] Configuration updated successfully.');
    res.json({
        success: true,
        tmdbApiKey: maskToken(process.env.TMDB_API_KEY),
        tmdbProxyUrl: redactProxyUrl(process.env.TMDB_PROXY_URL)
    });
});

router.post('/api/config/test-proxy', async (req, res) => {
    const typed = typeof req.body.url === 'string' ? req.body.url.trim() : '';
    const url = withSavedPassword(typed, process.env.TMDB_PROXY_URL);

    if (!isSupportedProxyUrl(url)) {
        return res.json({ success: false, error: 'Unsupported scheme' });
    }

    const started = Date.now();
    try {
        await axios.get('https://api.themoviedb.org/3/authentication', {
            headers: { Authorization: `Bearer ${process.env.TMDB_API_KEY}` },
            timeout: 10000,
            httpsAgent: buildProxyAgent(url),
            // Ignore any HTTP(S)_PROXY picked up from the environment
            proxy: false
        });
        res.json({ success: true, ms: Date.now() - started, direct: !url });
    } catch (err) {
        const reason = err.response ? `TMDB replied ${err.response.status}` : err.code || err.message;
        res.json({ success: false, error: reason, ms: Date.now() - started });
    }
});

module.exports = router;
