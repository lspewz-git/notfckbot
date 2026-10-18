/** The dashboard's TG / TMDB / KP / Proxy badges. */
const axios = require('axios');
const { buildProxyAgent } = require('../../proxy');
const { getKinopoiskStatus } = require('../../api/kinopoisk');
const { lruCache } = require('../../lru');

const router = require('express').Router();

// The dashboard polls every 10 s. Each service is checked on its own, with its own
// cache, so a slow or dead one (a timeout takes seconds) holds up only its own badge.
// Saving a token or the proxy clears the cache.
const HEALTH_TTL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5000;

const viaProxy = () => ({ httpsAgent: buildProxyAgent(process.env.TMDB_PROXY_URL), proxy: false });

/**
 * "HTTP 401", "timeout of 5000ms exceeded": the HTTP status when an axios request got an answer,
 * else the message. Telegraf's errors carry a `response` too, but with no `status`; their message
 * already reads "401: Unauthorized".
 */
const reasonOf = (err) => (err.response && err.response.status ? `HTTP ${err.response.status}` : err.message);

/** Each returns its part of the /api/health answer; none throws. Telegram gets the bot. */
const HEALTH_CHECKS = {
    telegram: async (bot) => {
        try {
            // Telegraf has no request timeout of its own: without this a hung connection
            // would keep the badge spinning, and every poll would reuse the stuck check
            await Promise.race([
                bot.telegram.getMe(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), HEALTH_TIMEOUT_MS))
            ]);
            return { telegram: true };
        } catch (err) {
            return { telegram: false, reason: reasonOf(err) };
        }
    },
    tmdb: async () => {
        try {
            const res = await axios.get('https://api.themoviedb.org/3/authentication', {
                headers: { Authorization: `Bearer ${process.env.TMDB_API_KEY}` },
                timeout: HEALTH_TIMEOUT_MS,
                ...viaProxy()
            });
            return { tmdb: res.status === 200 };
        } catch (err) {
            return { tmdb: false, reason: reasonOf(err) };
        }
    },
    proxy: async () => {
        if (!process.env.TMDB_PROXY_URL) return { proxy: 'off' };
        try {
            const res = await axios.get('https://google.com', { timeout: HEALTH_TIMEOUT_MS, ...viaProxy() });
            return { proxy: res.status === 200 ? 'ok' : 'error' };
        } catch (err) {
            return { proxy: 'error', reason: reasonOf(err) };
        }
    },
    // Kinopoisk API (watch-link lookups): 'off' without a key, else ok/error plus today's quota
    kinopoisk: async () => {
        try {
            const kp = await getKinopoiskStatus();
            return {
                kinopoisk: kp.state,
                kinopoiskQuota: kp.state === 'ok' ? { used: kp.used, limit: kp.limit } : null
            };
        } catch (err) {
            return { kinopoisk: 'error', kinopoiskQuota: null, reason: reasonOf(err) };
        }
    }
};

// Whether each check failed, as last seen, so the log gets one line per change rather than one
// per poll: "[Health] KP: error (HTTP 401)" when it breaks, "[Health] KP: ok again" when it heals
const LOG_NAMES = { telegram: 'TG', tmdb: 'TMDB', proxy: 'Proxy', kinopoisk: 'KP' };
const lastFailed = new Map();

function logChange(name, value) {
    const failed = value[name] === false || value[name] === 'error';
    const before = lastFailed.get(name);
    lastFailed.set(name, failed);
    // The first check after a start only speaks up if something is wrong
    if (before === failed || (before === undefined && !failed)) return;
    if (failed) console.error(`[Health] ${LOG_NAMES[name]}: error (${value.reason || 'no details'})`);
    // A failing proxy or key that was then removed is "off", not "ok"
    else console.log(`[Health] ${LOG_NAMES[name]}: ${value[name] === 'off' ? 'off' : 'ok again'}`);
}

// name -> the check's answer; concurrent requests share one check
const healthCache = lruCache({
    max: Object.keys(HEALTH_CHECKS).length,
    ttl: HEALTH_TTL_MS,
    fetchMethod: async (name, _stale, { context: bot }) => {
        const value = await HEALTH_CHECKS[name](bot);
        logChange(name, value);
        return value;
    }
});
const invalidateHealth = () => healthCache.clear();

const checkHealth = (name, bot) => healthCache.fetch(name, { context: bot });

// One service: what the dashboard badges use, so each shows up as soon as it's known
router.get('/api/health/:name', async (req, res) => {
    if (!Object.hasOwn(HEALTH_CHECKS, req.params.name)) return res.status(404).json({ error: 'Unknown service' });
    res.json(await checkHealth(req.params.name, req.app.get('bot')));
});

// All services at once (waits for the slowest)
router.get('/api/health', async (req, res) => {
    const parts = await Promise.all(Object.keys(HEALTH_CHECKS).map((name) => checkHealth(name, req.app.get('bot'))));
    res.json(Object.assign({}, ...parts));
});

module.exports = { router, invalidateHealth, reasonOf, logChange };
