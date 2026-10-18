const axios = require('axios');
require('dotenv').config();

/**
 * Finding a title's Kinopoisk ID, which the watch links need
 * (kinopoisk.ru/film/123, sspoisk.ru/film/123).
 *
 * Wikidata is tried first: it maps TMDB IDs to Kinopoisk IDs directly, needs no
 * key and has no quota. For the titles it doesn't know yet (usually brand new
 * ones), kinopoiskapiunofficial.tech is asked by IMDb ID.
 *
 * Both are Russian-reachable services, so requests go direct, not through the
 * TMDB proxy.
 */

const KP_API = 'https://kinopoiskapiunofficial.tech';
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
// Wikidata's TMDB properties differ for films and series
const WIKIDATA_TMDB_PROPERTY = { movie: 'P4947', tv: 'P4983' };
const WIKIDATA_KINOPOISK_PROPERTY = 'P2603';

const kpHeaders = () => ({ 'X-API-KEY': process.env.KINOPOISK_API_KEY });

const toId = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
};

async function fromWikidata(tmdbNumericId, mediaType) {
    const property = WIKIDATA_TMDB_PROPERTY[mediaType];
    // Digits only, since the value goes into the query text
    const numeric = toId(tmdbNumericId);
    if (!property || !numeric) return null;
    const query = `SELECT ?kp WHERE { ?item wdt:${property} "${numeric}"; wdt:${WIKIDATA_KINOPOISK_PROPERTY} ?kp } LIMIT 1`;
    const res = await axios.get(WIKIDATA_SPARQL, {
        params: { query },
        headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'notfckbot/1.0' },
        timeout: 8000
    });
    const binding = res.data?.results?.bindings?.[0];
    return binding ? toId(binding.kp.value) : null;
}

async function fromKinopoiskApi(imdbId) {
    if (!imdbId || !process.env.KINOPOISK_API_KEY) return null;
    const res = await axios.get(`${KP_API}/api/v2.2/films`, {
        params: { imdbId },
        headers: kpHeaders(),
        timeout: 8000
    });
    return toId(res.data?.items?.[0]?.kinopoiskId);
}

// Answers already known, so a search list, a card and the history page asking about one title
// don't repeat the lookup (and don't spend API quota). Misses expire, as both sources catch up.
const cache = new Map();
const CACHE_MAX = 1000;
const MISS_TTL_MS = 6 * 60 * 60 * 1000;
// A source that couldn't be asked (down, rejected the key): short, so it is tried again soon
const FAIL_TTL_MS = 10 * 60 * 1000;
const inFlight = new Map(); // tmdbId -> pending lookup

/**
 * @param {string} tmdbId e.g. "tv_1399" or "movie_603"
 * @param {string | null} imdbId e.g. "tt0944947", if known
 * @returns {Promise<{ id: number | null, failed: boolean }>} `failed` means a source
 *   could not be asked (network, quota) — as opposed to it not knowing the title
 */
async function lookupKinopoiskId(tmdbId, imdbId) {
    const hit = cache.get(tmdbId);
    if (hit) {
        // A found ID is kept; a miss and a failure are retried after a while
        const ttl = hit.id ? Infinity : hit.failed ? FAIL_TTL_MS : MISS_TTL_MS;
        if (Date.now() - hit.at < ttl) return { id: hit.id, failed: Boolean(hit.failed) };
    }
    // A card opened while the search list was still prefetching the same title: one lookup
    if (inFlight.has(tmdbId)) return inFlight.get(tmdbId);

    const run = (async () => {
        const [mediaType, numericId] = String(tmdbId).split('_');
        let failed = false;
        for (const lookup of [() => fromWikidata(numericId, mediaType), () => fromKinopoiskApi(imdbId)]) {
            try {
                const id = await lookup();
                if (id) {
                    remember(tmdbId, id);
                    return { id, failed: false };
                }
            } catch (err) {
                failed = true;
                console.error(`[Kinopoisk] Lookup failed for ${tmdbId}:`, err.message);
            }
        }
        // A failure is remembered too, briefly: otherwise every page of search results would
        // ask a dead API again (and log it again) for each film Wikidata doesn't know
        remember(tmdbId, null, failed);
        return { id: null, failed };
    })().finally(() => inFlight.delete(tmdbId));
    inFlight.set(tmdbId, run);
    return run;
}

function remember(tmdbId, id, failed = false) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(tmdbId, { id, at: Date.now(), failed });
}

/**
 * The ID if a lookup already found it, without asking anyone; otherwise null, and a lookup is
 * started in the background so the next call has it. For lists of many titles at once.
 */
function knownKinopoiskId(tmdbId, imdbId = null) {
    const hit = cache.get(tmdbId);
    if (hit && hit.id) return hit.id;
    // Answers from memory while a miss or a failure is recent, asks again once it has expired
    lookupKinopoiskId(tmdbId, imdbId).catch(() => {});
    return null;
}

/** @returns {Promise<number | null>} null when the title is unknown or a source was unreachable */
const findKinopoiskId = async (tmdbId, imdbId) => (await lookupKinopoiskId(tmdbId, imdbId)).id;

// A miss is retried once a day: Wikidata and Kinopoisk catch up on new titles
const RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * Fills kinopoisk_id on a model row (Series or Watchlist) if it is missing and the
 * last attempt is old enough. Never throws: links just fall back to search.
 *
 * @param {{ tmdb_id: string, kinopoisk_id: number | null, kinopoisk_checked_at: Date | null,
 *           update: Function }} row
 * @param {string | null} imdbId
 */
async function ensureKinopoiskId(row, imdbId) {
    if (row.kinopoisk_id) return row.kinopoisk_id;
    const last = row.kinopoisk_checked_at ? new Date(row.kinopoisk_checked_at).getTime() : 0;
    if (Date.now() - last < RETRY_MS) return null;

    const { id, failed } = await lookupKinopoiskId(row.tmdb_id, imdbId);
    // An outage is not an answer: leave checked_at alone so the next run tries again
    if (failed && !id) return null;
    try {
        await row.update({ kinopoisk_id: id, kinopoisk_checked_at: new Date() });
    } catch (err) {
        console.error(`[Kinopoisk] Could not save ID for ${row.tmdb_id}:`, err.message);
    }
    if (id) console.log(`[Kinopoisk] ${row.tmdb_id} -> ${id}`);
    return id;
}

/**
 * For interactive replies: gives up after `ms` so a slow lookup never holds the
 * user's answer back; the links then fall back to search.
 */
const findKinopoiskIdQuick = (tmdbId, imdbId, ms = 3000) =>
    Promise.race([findKinopoiskId(tmdbId, imdbId), new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

/**
 * Validates a key and reads its quota. The key-info endpoint does not count
 * against the quota, so it is safe for health checks.
 */
async function checkKinopoiskKey(key) {
    const res = await axios.get(`${KP_API}/api/v1/api_keys/${encodeURIComponent(key)}`, {
        headers: { 'X-API-KEY': key },
        timeout: 5000
    });
    const daily = res.data?.dailyQuota || {};
    return { used: daily.used, limit: daily.value, accountType: res.data?.accountType };
}

// --- A film's Russian dates: the cinema premiere and the digital release ---

const NO_DATES = Object.freeze({ premiere: null, digital: null, services: [] });
const DATES_TTL_MS = 24 * 60 * 60 * 1000;
const datesCache = new Map(); // kinopoiskId -> { dates, at, ttl }

const earliest = (items) =>
    items
        .map((i) => i.date)
        .filter(Boolean)
        .sort()[0] || null;

/**
 * The Russian premiere and digital release from Kinopoisk's distributions, or nulls (no key, not
 * known, or the API failing; then also `failed`, so stored dates aren't wiped). Never throws.
 * Kept a day: the dates change rarely, the quota is 500 requests a day.
 * @returns {Promise<{ premiere: string | null, digital: string | null, services: string[], failed?: true }>}
 *   "YYYY-MM-DD" dates; services: the online cinemas of the digital release ("START")
 */
async function russianDates(kinopoiskId) {
    const id = toId(kinopoiskId);
    if (!id || !process.env.KINOPOISK_API_KEY) return NO_DATES;
    const hit = datesCache.get(id);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.dates;
    let dates = NO_DATES;
    let ttl = DATES_TTL_MS;
    try {
        const res = await axios.get(`${KP_API}/api/v2.2/films/${id}/distributions`, {
            headers: kpHeaders(),
            timeout: 8000
        });
        const items = (res.data && res.data.items) || [];
        const inRussia = (i) => Boolean(i.country) && i.country.country === 'Россия';
        // Kinopoisk lists Russia's online releases, with or without the country filled in
        const online = items.filter((i) => i.type === 'DIGITAL' && i.date && (!i.country || inRussia(i)));
        const digital = earliest(online);
        dates = {
            premiere: earliest(
                items.filter((i) => (i.type === 'PREMIERE' || i.type === 'COUNTRY_SPECIFIC') && inRussia(i))
            ),
            digital,
            services: [
                ...new Set(
                    online
                        .filter((i) => i.date === digital)
                        .flatMap((i) => (i.companies || []).map((c) => c.name))
                        .filter(Boolean)
                )
            ]
        };
    } catch (err) {
        // 404 is "no such film": as good as no dates. Anything else is tried again soon
        if (!(err.response && err.response.status === 404)) {
            ttl = FAIL_TTL_MS;
            dates = { ...NO_DATES, failed: true };
        }
        console.error(`[Kinopoisk] Release dates of ${id} failed: ${err.message}`);
    }
    if (datesCache.size >= CACHE_MAX) datesCache.delete(datesCache.keys().next().value);
    datesCache.set(id, { dates, at: Date.now(), ttl });
    return dates;
}

/**
 * For the bot's card: the Kinopoisk ID and then the dates, given up on after `ms` in all, so a
 * slow Kinopoisk never holds the card back (it then shows TMDB's dates only).
 * @returns {Promise<{ kinopoiskId: number | null, ru: typeof NO_DATES }>}
 */
async function kinopoiskQuick(tmdbId, imdbId, ms = 3000) {
    let settled = { kinopoiskId: null, ru: NO_DATES };
    const lookup = (async () => {
        const kinopoiskId = await findKinopoiskId(tmdbId, imdbId);
        settled = { kinopoiskId, ru: NO_DATES };
        const ru = kinopoiskId ? await russianDates(kinopoiskId) : NO_DATES;
        settled = { kinopoiskId, ru };
    })().catch(() => {});
    let timer;
    await Promise.race([lookup, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
    return settled;
}

/** For the admin health badge. */
async function getKinopoiskStatus() {
    const key = process.env.KINOPOISK_API_KEY;
    if (!key) return { state: 'off' };
    const { used, limit } = await checkKinopoiskKey(key);
    return { state: 'ok', used, limit };
}

module.exports = {
    russianDates,
    kinopoiskQuick,
    NO_DATES,
    findKinopoiskId,
    findKinopoiskIdQuick,
    knownKinopoiskId,
    ensureKinopoiskId,
    checkKinopoiskKey,
    getKinopoiskStatus
};
