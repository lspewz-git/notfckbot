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

/**
 * @param {string} tmdbId e.g. "tv_1399" or "movie_603"
 * @param {string | null} imdbId e.g. "tt0944947", if known
 * @returns {Promise<number | null>} null when neither source knows the title
 */
async function findKinopoiskId(tmdbId, imdbId) {
    const [mediaType, numericId] = String(tmdbId).split('_');
    for (const lookup of [() => fromWikidata(numericId, mediaType), () => fromKinopoiskApi(imdbId)]) {
        try {
            const id = await lookup();
            if (id) return id;
        } catch (err) {
            console.error(`[Kinopoisk] Lookup failed for ${tmdbId}:`, err.message);
        }
    }
    return null;
}

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

    const id = await findKinopoiskId(row.tmdb_id, imdbId);
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

/** For the admin health badge. */
async function getKinopoiskStatus() {
    const key = process.env.KINOPOISK_API_KEY;
    if (!key) return { state: 'off' };
    const { used, limit } = await checkKinopoiskKey(key);
    return { state: 'ok', used, limit };
}

module.exports = {
    findKinopoiskId,
    findKinopoiskIdQuick,
    ensureKinopoiskId,
    checkKinopoiskKey,
    getKinopoiskStatus
};
