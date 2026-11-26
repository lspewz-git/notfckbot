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
// The address of the last failed request while failures run on: one show's huge list timing out
// is that show's trouble, not TVmaze's, so only a 429 or a second address failing pauses them all
let lastFailedUrl = null;
// Requests waiting or running: past a few, views (cards, calendars) add none of their own, so a
// user opening card after card can't hold the update check up behind a long queue
let pending = 0;
const VIEW_QUEUE_MAX = 4;

/** client.get, one request at a time with `gapMs` between them; refused while paused */
function get(url, config) {
    let sent = false;
    pending += 1;
    // The request as a whole: every lookup shares '/lookup/shows' and differs by its params
    const target = config && config.params ? `${url} ${JSON.stringify(config.params)}` : url;
    const run = queue.then(async () => {
        if (Date.now() < pausedUntil) throw new Error('TVmaze paused after a failure');
        sent = true;
        try {
            const res = await client.get(url, config);
            lastFailedUrl = null;
            return res;
        } catch (err) {
            const status = err.response ? err.response.status : null;
            // 404 is an answer (no such series)
            if (status === 404) {
                lastFailedUrl = null;
                throw err;
            }
            // Too many requests, or two different addresses failing in a row: TVmaze isn't answering
            // well, so nothing more for a while. One address failing alone pauses nothing.
            if (status === 429 || (lastFailedUrl !== null && lastFailedUrl !== target)) {
                pausedUntil = Date.now() + limits.pauseMs;
                lastFailedUrl = null;
                log.warn(`[TVmaze] ${target} failed, paused for ${limits.pauseMs / 60000} min: ${err.message}`);
            } else {
                lastFailedUrl = target;
                log.warn(`[TVmaze] ${target} failed: ${err.message}`);
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
    lastFailedUrl = null;
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

// How long one update check may spend waiting for TVmaze in all (usually ~1 s a series): past it
// the rest of the series go by the times already cached, so a slow TVmaze can't hold up films,
// the next check or a restart
const CHECK_BUDGET_MS = 2 * 60 * 1000;

/** The TVmaze time allowance of one update check, shared by its airTimesForCheck() calls */
const checkBudget = (ms = CHECK_BUDGET_MS) => ({ left: ms });

/**
 * airTimes() for the update check: a fresh schedule, else the cached one when TVmaze doesn't
 * answer, else undefined (null: not on TVmaze). Never throws. Once the check's budget is spent,
 * the cached one at once.
 * @param {{ left: number }} [budget] from checkBudget()
 */
async function airTimesForCheck(tmdbId, externals, budget = null) {
    // undefined stays: the check holds back season completion without TVmaze (src/cron/series.js)
    const cached = () => cachedAirTimes(tmdbId);
    if (budget && budget.left <= 0) return cached();
    const started = Date.now();
    const asked = airTimes(tmdbId, externals, { fresh: true }).catch(cached);
    if (!budget) return asked;
    // One call can't outlast the budget either: waiting behind a long queue (the start's warming,
    // digests) ends with the budget, and the request stays queued for whoever asks next
    let timer;
    const over = new Promise((resolve) => {
        timer = setTimeout(() => resolve(cached()), budget.left);
    });
    try {
        return await Promise.race([asked, over]);
    } finally {
        clearTimeout(timer);
        budget.left -= Date.now() - started;
    }
}

// A schedule older than its lifetime by this much isn't used any more: a fortnight-old one may have
// lost a moved episode. The update check refreshes the tracked series every few hours.
const STALE_MAX_MS = DAY_MS;
const runtimeFallbacks = lruCache({ max: 300, ttl: 2 * UPDATE_INTERVAL_HOURS * 3600000 + STALE_MAX_MS });

/** Known reserve runtime for a show whose own schedule omits all lengths. */
function setRuntimeFallback(showId, runtime) {
    if (Number.isFinite(runtime) && runtime > 0) runtimeFallbacks.set(showId, runtime);
}

// Full snapshots are separate from the small timing cache: history needs old and undated
// episodes too. One embedded response keeps status, seasons and episodes from the same refresh.
const shows = lruCache({
    max: 300,
    maxSize: 32 * 1024 * 1024,
    sizeCalculation: (value) => Math.max(1, JSON.stringify(value).length * 2),
    ttl: 2 * UPDATE_INTERVAL_HOURS * 60 * 60 * 1000,
    fetchMethod: async (id) => {
        const { data } = await get(`/shows/${id}`, {
            params: { 'embed[]': ['episodes', 'seasons', 'cast', 'crew'] },
            timeout: EPISODES_TIMEOUT_MS
        });
        if (
            !data ||
            data.id !== Number(id) ||
            !Array.isArray(data._embedded?.episodes) ||
            !Array.isArray(data._embedded?.seasons)
        )
            throw new Error('Incomplete TVmaze show snapshot');
        return data;
    }
});

/** Last usable full snapshot; never uses an arbitrarily old schedule during an outage. */
function cachedShow(tmdbId, knownId = null) {
    const id = knownId || showIds.peek(tmdbId, { allowStale: true });
    if (id === NOT_FOUND) return showIds.getRemainingTTL(tmdbId) > 0 ? null : undefined;
    if (!id || shows.getRemainingTTL(id) < -STALE_MAX_MS) return undefined;
    return shows.peek(id, { allowStale: true });
}

/** Exact external-ID lookup only. A saved TVmaze ID also works when TMDB is unavailable. */
async function show(tmdbId, externals, { fresh = false, knownId = null, deadline = null } = {}) {
    if (!knownId) externals = await externals;
    if (deadline?.passed()) throw new Error('TVmaze view deadline expired');
    if (!knownId && !hasIds(externals)) return null;
    const id =
        knownId ||
        (await showIds.fetch(tmdbId, { context: externals, allowStale: showIds.getRemainingTTL(tmdbId) > 0 }));
    if (!id) return null;
    if (deadline?.passed()) throw new Error('TVmaze view deadline expired');
    showIds.set(tmdbId, id);
    const load = (showId) =>
        fresh ? shows.fetch(showId, { forceRefresh: true, allowStale: false }) : fetchFresh(shows, showId);
    try {
        return await load(id);
    } catch (err) {
        if (err.response?.status !== 404) throw err;
        if (deadline?.passed()) throw err;
        // The primary request may have started from a saved ID before optional TMDB
        // metadata answered. Only ID recovery needs to wait for its external identifiers.
        externals = await externals;
        if (deadline?.passed() || !hasIds(externals)) throw err;
        // A removed/merged show can have a new ID. Retry the exact external lookup once;
        // keep the old mapping and cached schedule unless the replacement fully validates.
        try {
            const replacement = await showIds.fetch(tmdbId, {
                forceRefresh: true,
                allowStale: false,
                context: externals
            });
            if (!replacement || replacement === id || deadline?.passed()) throw err;
            const data = await load(replacement);
            showIds.set(tmdbId, replacement);
            return data;
        } catch (lookupError) {
            showIds.set(tmdbId, id);
            throw lookupError;
        }
    }
}

/** Bounded by the check's shared budget or the caller's view deadline. */
async function showFor(
    tmdbId,
    externals,
    { fresh = false, knownId = null, budget = null, waitMs = 3000, deadline = null } = {}
) {
    const cached = () => cachedShow(tmdbId, knownId);
    const unavailable = () => {
        const value = cached();
        return value ? { ...value, unavailable: true } : value;
    };
    if (deadline?.passed()) return cached();
    if (budget && budget.left <= 0) return unavailable();
    const cachedId = knownId || showIds.peek(tmdbId, { allowStale: true });
    if (!fresh && cached() !== undefined) {
        if (cachedId && shows.getRemainingTTL(cachedId) <= 0 && (deadline?.patient || roomForViews()))
            show(tmdbId, externals, { knownId, deadline }).catch(() => {});
        return cached();
    }
    if (!fresh && !deadline?.patient && !roomForViews()) return unavailable();
    const started = Date.now();
    let timer;
    try {
        const timeout = deadline
            ? deadline.promise.then(unavailable)
            : new Promise((resolve) => {
                  timer = setTimeout(() => resolve(unavailable()), budget ? Math.max(0, budget.left) : waitMs);
              });
        return await Promise.race([show(tmdbId, externals, { fresh, knownId, deadline }).catch(unavailable), timeout]);
    } finally {
        clearTimeout(timer);
        if (budget) budget.left -= Date.now() - started;
    }
}

/** What the caches already hold for a series, without asking: times, null (not on TVmaze) or undefined */
function cachedAirTimes(tmdbId) {
    const full = cachedShow(tmdbId);
    if (full) return timesOf(full);
    const showId = showIds.peek(tmdbId, { allowStale: true });
    if (showId === NOT_FOUND) return null;
    if (!showId || schedules.getRemainingTTL(showId) < -STALE_MAX_MS) return undefined;
    return schedules.peek(showId, { allowStale: true });
}

/** Timing dictionary for all dated regular episodes in a full snapshot. */
function timesOf(data) {
    const times = {};
    for (const ep of data._embedded.episodes) {
        if (!Number.isInteger(ep.season) || !Number.isInteger(ep.number) || ep.number < 1) continue;
        const stamp = Date.parse(ep.airstamp);
        const date = /^\d{4}-\d{2}-\d{2}$/.test(ep.airdate || '') ? ep.airdate : null;
        if (!date && !Number.isFinite(stamp)) continue;
        times[`${ep.season}:${ep.number}`] = {
            stamp: Number.isFinite(stamp) ? stamp : null,
            date,
            runtime:
                Number(ep.runtime) > 0
                    ? Number(ep.runtime)
                    : Number(data.averageRuntime || data.runtime) > 0
                      ? Number(data.averageRuntime || data.runtime)
                      : runtimeFallbacks.get(data.id) || null,
            timed: Boolean(ep.airtime)
        };
    }
    return times;
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
    if (!hasIds(externals) || deadline.passed() || (!deadline.patient && !roomForViews())) return null;
    return Promise.race([airTimes(tmdbId, externals).catch(() => null), deadline.promise.then(() => null)]);
}

/**
 * The shared deadline for one view; cancel it when the view is done.
 * @param {number} [ms]
 * @param {{ patient?: boolean }} [options] patient: queue behind others rather than give up (a digest
 *   that goes out once, not a view someone is waiting for)
 */
function viewDeadline(ms = 3000, { patient = false } = {}) {
    let timer;
    let passed = false;
    const promise = new Promise((resolve) => {
        timer = setTimeout(() => {
            passed = true;
            resolve();
        }, ms);
    });
    return { promise, passed: () => passed, cancel: () => clearTimeout(timer), patient };
}

/**
 * Fills the caches for a series in the background (after a start); returns at once. Queued
 * like the update check's own requests: the start's warming is one pass over the tracked series.
 */
function warm(tmdbId, externals) {
    airTimes(tmdbId, externals).catch(() => {});
}

module.exports = {
    show,
    showFor,
    cachedShow,
    timesOf,
    setRuntimeFallback,
    airTimes,
    airTimesForCheck,
    checkBudget,
    airTimesQuick,
    cachedAirTimes,
    viewDeadline,
    warm,
    externalsOf,
    client,
    resetLimits
};
