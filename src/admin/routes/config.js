/** The proxy dialog: current settings, saving them, and testing a candidate. */
const axios = require('axios');
const {
    buildProxyAgent,
    proxyUrlProblem,
    applyProxyToBot,
    redactProxyUrl,
    hasProxyPassword,
    withSavedPassword
} = require('../../proxy');
const { isSafeEnvValue, updateEnvFile, maskToken } = require('../env');
const { invalidateHealth } = require('./health');

const router = require('express').Router();
const { log } = require('../../log');

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
        const problem = proxyUrlProblem(newProxy);
        if (problem) return res.status(400).json({ error: problem });
        process.env.TMDB_PROXY_URL = newProxy;
        updateEnvFile('TMDB_PROXY_URL', newProxy);
        // TMDB picks the new agent up per request; Telegram holds onto one
        applyProxyToBot(req.app.get('bot'));
        invalidateHealth();
    }

    log.info('[Admin] Configuration updated successfully.');
    res.json({
        success: true,
        tmdbApiKey: maskToken(process.env.TMDB_API_KEY),
        tmdbProxyUrl: redactProxyUrl(process.env.TMDB_PROXY_URL)
    });
});

// What the test asks through the candidate proxy: the two services the bot depends on, and a
// neutral site, so a service that is down can be told from a proxy that is
const PROXY_TARGETS = {
    telegram: () => ({ url: `https://api.telegram.org/bot${process.env.BOT_TOKEN}/getMe` }),
    tmdb: () => ({
        url: 'https://api.themoviedb.org/3/authentication',
        headers: { Authorization: `Bearer ${process.env.TMDB_API_KEY}` }
    }),
    // Answers with the address the request came from: the proxy's way out to the internet
    internet: () => ({ url: 'https://ifconfig.me/ip', headers: { Accept: 'text/plain' } })
};
const TEST_TIMEOUT_MS = 10000;
const IP = /^[0-9a-f.:]{3,45}$/i;

/**
 * Asks every target at once through `agent`.
 * @returns {Promise<{ checks: object, proxyDown: string | null }>} each check { ok, ms, error?, ip? };
 *   proxyDown: the connection error when no target could be reached at all (the proxy itself)
 */
async function checkThroughProxy(agent, get = axios.get) {
    const entries = await Promise.all(
        Object.entries(PROXY_TARGETS).map(async ([name, target]) => {
            const { url, headers } = target();
            const started = Date.now();
            try {
                const res = await get(url, {
                    headers,
                    timeout: TEST_TIMEOUT_MS,
                    httpsAgent: agent,
                    // Ignore any HTTP(S)_PROXY picked up from the environment
                    proxy: false,
                    // Here, not only through installDeadline(): the test must end in 10 s
                    // even where the default instance has no deadline (tests/unit)
                    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
                    responseType: 'text'
                });
                const check = { ok: true, ms: Date.now() - started };
                const ip = String(res.data || '').trim();
                if (name === 'internet' && IP.test(ip)) check.ip = ip;
                return [name, check];
            } catch (err) {
                // An HTTP answer means the proxy got through: the service itself said no
                let error = err.response
                    ? `replied ${err.response.status}`
                    : axios.isCancel(err)
                      ? `no answer in ${TEST_TIMEOUT_MS / 1000} s`
                      : err.code || err.message;
                // Telegram's address carries the bot token; an error quoting it must not show it
                if (process.env.BOT_TOKEN) error = String(error).split(process.env.BOT_TOKEN).join('***');
                return [name, { ok: false, ms: Date.now() - started, error, reached: Boolean(err.response) }];
            }
        })
    );
    const checks = Object.fromEntries(entries);
    const all = Object.values(checks);
    const proxyDown = all.every((c) => !c.ok && !c.reached) ? all[0].error : null;
    for (const check of all) delete check.reached;
    return { checks, proxyDown };
}

router.post('/api/config/test-proxy', async (req, res) => {
    const typed = typeof req.body.url === 'string' ? req.body.url.trim() : '';
    const url = withSavedPassword(typed, process.env.TMDB_PROXY_URL);

    const problem = proxyUrlProblem(url);
    if (problem) return res.json({ success: false, error: problem });

    const { checks, proxyDown } = await checkThroughProxy(buildProxyAgent(url));
    // The bot can't work without Telegram; the rest is reported, not required
    res.json({ success: checks.telegram.ok, direct: !url, checks, proxyDown });
});

module.exports = router;
module.exports.checkThroughProxy = checkThroughProxy;
