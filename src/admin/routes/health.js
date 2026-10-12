/** The dashboard's TG / TMDB / KP / Proxy badges. */
const axios = require('axios');
const { buildProxyAgent } = require('../../proxy');
const { getKinopoiskStatus } = require('../../api/kinopoisk');

const router = require('express').Router();

// The dashboard polls every 10 s. Each service is checked on its own, with its own
// cache, so a slow or dead one (a timeout takes seconds) holds up only its own badge.
// Saving a token or the proxy clears the cache.
const HEALTH_TTL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5000;

const viaProxy = () => ({ httpsAgent: buildProxyAgent(process.env.TMDB_PROXY_URL), proxy: false });

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
        } catch {
            return { telegram: false };
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
        } catch {
            return { tmdb: false };
        }
    },
    proxy: async () => {
        if (!process.env.TMDB_PROXY_URL) return { proxy: 'off' };
        try {
            const res = await axios.get('https://google.com', { timeout: HEALTH_TIMEOUT_MS, ...viaProxy() });
            return { proxy: res.status === 200 ? 'ok' : 'error' };
        } catch {
            return { proxy: 'error' };
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
        } catch {
            return { kinopoisk: 'error', kinopoiskQuota: null };
        }
    }
};

const healthCache = new Map(); // name -> { at, value }
const healthInFlight = new Map(); // name -> pending check, shared by concurrent requests
const invalidateHealth = () => healthCache.clear();

function checkHealth(name, bot) {
    const hit = healthCache.get(name);
    if (hit && Date.now() - hit.at < HEALTH_TTL_MS) return Promise.resolve(hit.value);
    if (healthInFlight.has(name)) return healthInFlight.get(name);
    const run = HEALTH_CHECKS[name](bot)
        .then((value) => {
            healthCache.set(name, { at: Date.now(), value });
            return value;
        })
        .finally(() => healthInFlight.delete(name));
    healthInFlight.set(name, run);
    return run;
}

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

module.exports = { router, invalidateHealth };
