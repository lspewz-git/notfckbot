/** The dashboard's TG / TMDB / TVmaze / KP / Proxy badges. */
const axios = require('axios');
const { buildProxyAgent } = require('../../proxy');
const { getKinopoiskStatus } = require('../../api/kinopoisk');
const { lruCache } = require('../../lru');

const router = require('express').Router();
const { log } = require('../../log');

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
            // Telegraf's own timeout is 500 s: without this a hung connection would keep the badge
            // spinning. Aborted, not raced: a raced request stays open, one more each poll
            await bot.telegram.callApi('getMe', {}, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
            return { telegram: true };
        } catch (err) {
            return { telegram: false, reason: err.name === 'AbortError' ? 'timeout' : reasonOf(err) };
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
    // TVmaze (episode air times): no key, so a public show stands in for an authentication call
    tvmaze: async () => {
        try {
            const res = await axios.get('https://api.tvmaze.com/shows/1', {
                timeout: HEALTH_TIMEOUT_MS,
                ...viaProxy()
            });
            return { tvmaze: res.status === 200 };
        } catch (err) {
            return { tvmaze: false, reason: reasonOf(err) };
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

const failedOf = (name, value) => value[name] === false || value[name] === 'error';

// A failed check is asked once more after this pause: a single dropped connection (Telegram's
// ECONNRESET came several times a day) is not an outage worth a red badge
const RETRY_DELAY_MS = 1000;

async function runCheck(name, bot) {
    const first = await HEALTH_CHECKS[name](bot);
    if (!failedOf(name, first)) return first;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return HEALTH_CHECKS[name](bot);
}

/**
 * What the panel shows instead of a raw error: short words for the usual network failures,
 * and never the bot token, which Telegraf's messages carry in the request URL.
 * @param {string | undefined} reason
 */
function plainReason(reason) {
    if (!reason) return 'no details';
    if (/timeout|ETIMEDOUT|ESOCKETTIMEDOUT|aborted/i.test(reason)) return 'timeout';
    if (/ECONNRESET|socket hang up/i.test(reason)) return 'connection reset';
    if (/ECONNREFUSED/.test(reason)) return 'connection refused';
    if (/ENOTFOUND|EAI_AGAIN/.test(reason)) return 'DNS lookup failed';
    return reason.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot…');
}

// The dialogs' "what went wrong": the problem going on now and the last few that ended, per service.
// In memory: a restart starts the list over
const MAX_RECENT = 3;
const ongoing = new Map(); // name -> { since, reason, checks }
const recent = new Map(); // name -> [{ since, until, reason }], newest first

/**
 * Notes one check's result and adds what the panel shows: `problem` (failing now: since when, why,
 * how many checks in a row) and `recent` (ended problems).
 */
function track(name, value, now = Date.now()) {
    const open = ongoing.get(name);
    if (failedOf(name, value)) {
        const reason = plainReason(value.reason);
        ongoing.set(name, open ? { ...open, reason, checks: open.checks + 1 } : { since: now, reason, checks: 1 });
    } else if (open) {
        ongoing.delete(name);
        recent.set(
            name,
            [{ since: open.since, until: now, reason: open.reason }, ...(recent.get(name) || [])].slice(0, MAX_RECENT)
        );
    }
    return { ...value, problem: ongoing.get(name) || null, recent: recent.get(name) || [] };
}

const resetProblems = () => {
    ongoing.clear();
    recent.clear();
};

// Whether each check failed, as last seen, so the log gets one line per change rather than one
// per poll: "[Health] KP: error (HTTP 401)" when it breaks, "[Health] KP: ok again" when it heals
const LOG_NAMES = { telegram: 'TG', tmdb: 'TMDB', tvmaze: 'TVmaze', proxy: 'Proxy', kinopoisk: 'KP' };
const lastFailed = new Map();

function logChange(name, value) {
    const failed = failedOf(name, value);
    const before = lastFailed.get(name);
    lastFailed.set(name, failed);
    // The first check after a start only speaks up if something is wrong
    if (before === failed || (before === undefined && !failed)) return;
    if (failed) log.error(`[Health] ${LOG_NAMES[name]}: error (${value.reason || 'no details'})`);
    // A failing proxy or key that was then removed is "off", not "ok"
    else log.info(`[Health] ${LOG_NAMES[name]}: ${value[name] === 'off' ? 'off' : 'ok again'}`);
}

// name -> the number of the latest check started. A check overtaken by a newer one (the cache was
// cleared while it ran) doesn't count: it would add a check to the row or reopen a healed problem
const started = new Map();

// name -> the check's answer; concurrent requests share one check
const healthCache = lruCache({
    max: Object.keys(HEALTH_CHECKS).length,
    ttl: HEALTH_TTL_MS,
    fetchMethod: async (name, _stale, { context: bot }) => {
        const mine = (started.get(name) || 0) + 1;
        started.set(name, mine);
        const value = await runCheck(name, bot);
        if (started.get(name) !== mine) {
            return { ...value, problem: ongoing.get(name) || null, recent: recent.get(name) || [] };
        }
        logChange(name, value);
        return track(name, value);
    }
});
const invalidateHealth = () => healthCache.clear();

/**
 * @param {boolean} [fresh] check again instead of answering from the cache; a check already
 *        running is joined, not doubled
 */
const checkHealth = (name, bot, fresh = false) => healthCache.fetch(name, { context: bot, forceRefresh: fresh });

/** The panel gets the plain reason in `problem`; the raw one may hold the bot token. */
const forPanel = (value, ...drop) => {
    const out = { ...value };
    for (const key of ['reason', ...drop]) delete out[key];
    return out;
};

// One service: what the dashboard badges use, so each shows up as soon as it's known.
// ?fresh=1 (a service's dialog opening) checks again instead of answering from the cache
router.get('/api/health/:name', async (req, res) => {
    const { name } = req.params;
    if (!Object.hasOwn(HEALTH_CHECKS, name)) return res.status(404).json({ error: 'Unknown service' });
    res.json(forPanel(await checkHealth(name, req.app.get('bot'), req.query.fresh === '1')));
});

// All services at once (waits for the slowest); the problems are per service, so left out here
router.get('/api/health', async (req, res) => {
    const parts = await Promise.all(Object.keys(HEALTH_CHECKS).map((name) => checkHealth(name, req.app.get('bot'))));
    res.json(Object.assign({}, ...parts.map((part) => forPanel(part, 'problem', 'recent'))));
});

module.exports = {
    router,
    invalidateHealth,
    reasonOf,
    logChange,
    checkHealth,
    plainReason,
    track,
    resetProblems,
    runCheck,
    HEALTH_CHECKS
};
