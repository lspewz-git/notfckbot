/**
 * TVmaze (api.tvmaze.com, free, no key): when each episode of a series comes out. TMDB gives an
 * episode only its US day; TVmaze gives the moment (`airstamp`) and the length (`runtime`). A
 * series is found by its IMDb ID, else its TheTVDB ID (both come with TMDB's details); TVmaze's
 * season and episode numbers usually match TMDB's (src/episode-times.js checks each one).
 *
 * Goes through the same proxy as TMDB (TMDB_PROXY_URL). TVmaze allows about 20 requests in 10 s
 * per address: requests go one at a time with a gap, and after a failure (timeout, 429, 5xx) none
 * are sent for a couple of minutes. Optional: without an answer the dates come from TMDB. The
 * dashboard's TVmaze badge and the "TVmaze not answering" alert check it apart from this
 * (src/admin/routes/health.js).
 */
const axios = require('axios');
const { getProxyAgent } = require('../proxy');
const { installDeadline } = require('../http-deadline');
const { UPDATE_INTERVAL_HOURS } = require('../constants');
const { lruCache, fetchFresh } = require('../lru');
const { log } = require('../log');

const client = axios.create({ baseURL: 'https://api.tvmaze.com', timeout: 5000, proxy: false });
installDeadline(client);
client.interceptors.request.use((config) => {
    config.httpsAgent = getProxyAgent();
    return config;
});

// Own queue rather than p-limit (not a direct dependency, and it limits concurrency, not pace)
const limits = { gapMs: 600, pauseMs: 2 * 60 * 1000 };
let queue = Promise.resolve();
let pausedUntil = 0;
// Requests waiting or running: past a few, views (cards, calendars) add none of their own, so a
// user opening card after card can't hold the update check up behind a long queue
let pending = 0;
const VIEW_QUEUE_MAX = 4;

/** client.get, one request at a time with `gapMs` between them; refused while paused */
function get(url, config) {
    let sent = false;
    pending += 1;
    const run = queue.then(async () => {
        if (Date.now() < pausedUntil) throw new Error('TVmaze paused after a failure');
        sent = true;
        try {
            return await client.get(url, config);
        } catch (err) {
            // 404 is an answer (no such series); anything else means TVmaze isn't answering well
            if (!err.response || err.response.status !== 404) {
                pausedUntil = Date.now() + limits.pauseMs;
                log.warn(`[TVmaze] ${url} failed, paused for ${limits.pauseMs / 60000} min: ${err.message}`);
            }
            throw err;
        }
    });
    run.then(
        () => (pending -= 1),
        () => (pending -= 1)
    );
    queue = run
        .catch(() => {})
        .then(() => sent && limits.gapMs > 0 && new Promise((resolve) => setTimeout(resolve, limits.gapMs)));
    return run;
}

/** Whether a view may add requests now (see VIEW_QUEUE_MAX) */
const roomForViews = () => pending < VIEW_QUEUE_MAX;

/** Tests: no gap, no pause or stuck request left over */
function resetLimits({ gapMs = 0 } = {}) {
    limits.gapMs = gapMs;
    pausedUntil = 0;
    queue = Promise.resolve();
    pending = 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// 0: TVmaze has no such series (kept too, so it isn't asked again every time)
const NOT_FOUND = 0;
// Episodes aired longer ago than this are left out: nothing dates them any more (TMDB's last
// aired stands for them), and a soap's full list runs to 10–15 thousand episodes
const KEEP_PAST_MS = 60 * DAY_MS;
// A long list through the proxy takes longer than a lookup
const EPISODES_TIMEOUT_MS = 15000;

/**
 * The TVmaze show ID by TMDB ID ("tv_1399"); the IMDb/TheTVDB IDs come as the context. A day:
 * TVmaze often links a new series' IDs only around its premiere
 */
const showIds = lruCache({
    max: 2000,
    ttl: DAY_MS,
    fetchMethod: async (_tmdbId, _stale, { context }) => {
        const { imdb, tvdb } = context || {};
        for (const [param, value] of [
            ['imdb', imdb],
            ['thetvdb', tvdb]
        ]) {
            if (!value) continue;
            try {
                const { data } = await get('/lookup/shows', { params: { [param]: value } });
                if (data && data.id) return data.id;
            } catch (err) {
                // 404: not by this ID; anything else isn't an answer and isn't kept
                if (!err.response || err.response.status !== 404) throw err;
            }
        }
        return NOT_FOUND;
    }
});

/**
 * @typedef {{ stamp: number | null, date: string | null, runtime: number | null, timed?: boolean }} EpisodeTime
 *   stamp: the moment it airs (ms); date: its day where it airs ("YYYY-MM-DD"); runtime: minutes;
 *   timed: false when TVmaze has no time of day (streaming: its stamp is a 12:00 UTC stand-in)
 */

/**
 * "season:episode" -> EpisodeTime, by TVmaze show ID: the episodes from KEEP_PAST_MS ago on.
 * Specials (no number) are left out.
 */
const schedules = lruCache({
    max: 300,
    // Refreshed by every update check (src/cron/series.js), so this is the longest it is kept
    ttl: 2 * UPDATE_INTERVAL_HOURS * 60 * 60 * 1000,
    fetchMethod: async (showId) => {
        const { data } = await get(`/shows/${showId}/episodes`, { timeout: EPISODES_TIMEOUT_MS });
        const since = Date.now() - KEEP_PAST_MS;
        /** @type {Record<string, EpisodeTime>} */
        const times = {};
        for (const ep of Array.isArray(data) ? data : []) {
            if (!Number.isInteger(ep.season) || !Number.isInteger(ep.number)) continue;
            const stamp = ep.airstamp ? Date.parse(ep.airstamp) : NaN;
            const date = /^\d{4}-\d{2}-\d{2}$/.test(ep.airdate || '') ? ep.airdate : null;
            if (Number.isNaN(stamp) && !date) continue;
            if ((Number.isNaN(stamp) ? Date.parse(`${date}T23:59:59Z`) : stamp) < since) continue;
            times[`${ep.season}:${ep.number}`] = {
                stamp: Number.isNaN(stamp) ? null : stamp,
                date,
                runtime: Number.isFinite(ep.runtime) && ep.runtime > 0 ? ep.runtime : null,
                timed: Boolean(ep.airtime)
            };
        }
        return times;
    }
});

/** The IDs TVmaze can be asked by, from TMDB's details of a series */
const externalsOf = (details) => ({
    imdb: (details && (details.imdb_id || (details.external_ids && details.external_ids.imdb_id))) || null,
    tvdb: (details && details.external_ids && details.external_ids.tvdb_id) || null
});

const hasIds = (externals) => Boolean(externals && (externals.imdb || externals.tvdb));

/**
 * The series' episode times, or null when TVmaze doesn't know it. Throws when TVmaze doesn't
 * answer (nothing cached).
 * @param {string} tmdbId "tv_1399"
 * @param {{ imdb: string | null, tvdb: number | null }} externals
 * @param {{ fresh?: boolean }} [options] fresh: ask again now (the update check)
 * @returns {Promise<Record<string, EpisodeTime> | null>}
 */
async function airTimes(tmdbId, externals, { fresh = false } = {}) {
    if (!hasIds(externals)) return null;
    const showId = await showIds.fetch(tmdbId, { context: externals, allowStale: true });
    if (!showId) return null;
    if (fresh) return (await schedules.fetch(showId, { forceRefresh: true, allowStale: false })) || null;
    return (await fetchFresh(schedules, showId)) || null;
}

/**
 * airTimes() for the update check: a fresh schedule, else the cached one when TVmaze doesn't
 * answer, else null. Never throws.
 */
async function airTimesForCheck(tmdbId, externals) {
    try {
        return await airTimes(tmdbId, externals, { fresh: true });
    } catch {
        return cachedAirTimes(tmdbId) || null;
    }
}

/** What the caches already hold for a series, without asking: times, null (not on TVmaze) or undefined */
function cachedAirTimes(tmdbId) {
    const showId = showIds.peek(tmdbId, { allowStale: true });
    if (showId === NOT_FOUND) return null;
    return showId ? schedules.peek(showId, { allowStale: true }) : undefined;
}

/**
 * airTimes() for a view (a calendar, a card): the cached times at once (refreshed in the
 * background when old), else whatever comes before the view's deadline (shared by all its
 * series), else null. Once the deadline has passed, nothing new is asked.
 * @param {{ promise: Promise<unknown>, passed: () => boolean }} deadline from viewDeadline()
 */
async function airTimesQuick(tmdbId, externals, deadline) {
    const cached = cachedAirTimes(tmdbId);
    if (cached !== undefined) {
        airTimes(tmdbId, externals).catch(() => {});
        return cached;
    }
    if (!hasIds(externals) || deadline.passed() || !roomForViews()) return null;
    return Promise.race([airTimes(tmdbId, externals).catch(() => null), deadline.promise.then(() => null)]);
}

/** The shared deadline for one view; cancel it when the view is done */
function viewDeadline(ms = 3000) {
    let timer;
    let passed = false;
    const promise = new Promise((resolve) => {
        timer = setTimeout(() => {
            passed = true;
            resolve();
        }, ms);
    });
    return { promise, passed: () => passed, cancel: () => clearTimeout(timer) };
}

/**
 * Fills the caches for a series in the background (after a start); returns at once. Queued
 * like the update check's own requests: the start's warming is one pass over the tracked series.
 */
function warm(tmdbId, externals) {
    airTimes(tmdbId, externals).catch(() => {});
}

module.exports = {
    airTimes,
    airTimesForCheck,
    airTimesQuick,
    cachedAirTimes,
    viewDeadline,
    warm,
    externalsOf,
    client,
    resetLimits
};
