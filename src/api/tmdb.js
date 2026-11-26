const axios = require('axios');
const { getProxyAgent } = require('../proxy');
const { installDeadline } = require('../http-deadline');
const { UPDATE_INTERVAL_HOURS } = require('../constants');
const { lruCache, fetchFresh } = require('../lru');
require('dotenv').config();
const { log } = require('../log');

/** A TMDB poster path ("/abc.jpg") as the w500 image URL stored and sent everywhere; null for none. */
const tmdbPoster = (path) => {
    if (
        /^https:\/\/static\.tvmaze\.com\/uploads\/images\/(?:original_untouched|medium_portrait)\/\d+\/\d+\.jpg$/.test(
            path || ''
        )
    )
        return path;
    return path ? `https://image.tmdb.org/t/p/w500${path}` : null;
};

const BASE_URL = 'https://api.themoviedb.org/3';

const apiClient = axios.create({
    baseURL: BASE_URL,
    timeout: 15000, // Increased timeout for slow proxies
    proxy: false
});
// The timeout above counts from the first byte to the proxy, not from when its socket is ready
installDeadline(apiClient);

apiClient.interceptors.request.use(
    (config) => {
        const apiKey = process.env.TMDB_API_KEY;
        if (apiKey) {
            config.headers['Authorization'] = `Bearer ${apiKey}`;
        }
        config.headers['Content-Type'] = 'application/json';

        // Apply proxy dynamically
        config.httpsAgent = getProxyAgent();

        return config;
    },
    (error) => Promise.reject(error)
);

// Log details on success and error to help debugging
apiClient.interceptors.response.use(
    (response) => {
        if (response.config.method === 'get') {
            log.info(`[TMDB] ✅ Successful GET: ${response.config.url}`);
        }
        return response;
    },
    (error) => {
        if (error.code === 'ECONNRESET') {
            log.error('[TMDB] ❌ Connection Reset. Check your Proxy or Network.');
        } else if (error.code === 'ETIMEDOUT') {
            log.error('[TMDB] ❌ Timeout. Proxy is too slow.');
        }
        return Promise.reject(error);
    }
);

const searchMulti = async (query) => {
    try {
        const response = await apiClient.get('/search/multi', {
            params: {
                query: query,
                language: 'ru-RU'
            }
        });

        // Return only movies and tv shows
        return (response.data.results || []).filter((item) => item.media_type === 'movie' || item.media_type === 'tv');
    } catch (error) {
        log.error(`TMDB API Error (searchMulti): ${error.message}`);
        throw error;
    }
};

// TMDB release types: 3 theatrical, 4 digital, 5 physical, 6 TV
const DIGITAL = 4;

/**
 * The digital release: its date ("2026-03-04") and country ("US"), or nulls when TMDB has none.
 * Russia's date is preferred, then the US, then the earliest anywhere.
 */
function digitalRelease(releaseDates) {
    const byCountry = (releaseDates && releaseDates.results) || [];
    const digitalIn = (country) =>
        (country.release_dates || [])
            .filter((r) => r.type === DIGITAL && r.release_date)
            .map((r) => r.release_date.slice(0, 10))
            .sort()[0] || null;

    for (const code of ['RU', 'US']) {
        const country = byCountry.find((c) => c.iso_3166_1 === code);
        const date = country && digitalIn(country);
        if (date) return { date, country: code };
    }
    const first = byCountry
        .map((c) => ({ date: digitalIn(c), country: c.iso_3166_1 }))
        .filter((r) => r.date)
        .sort((a, b) => a.date.localeCompare(b.date))[0];
    return first || { date: null, country: null };
}

const LIMITED = 2;
const THEATRICAL = 3;

/**
 * The earliest release of a type, anywhere or in one country: { date, country }, or nulls. Only
 * the type asked for: a festival screening (1) or a limited run (2) is not a cinema release.
 */
function firstRelease(releaseDates, type, onlyCountry = null) {
    const byCountry = (releaseDates && releaseDates.results) || [];
    const first = byCountry
        .filter((c) => !onlyCountry || c.iso_3166_1 === onlyCountry)
        .flatMap((c) =>
            (c.release_dates || [])
                .filter((r) => r.type === type && r.release_date)
                .map((r) => ({ date: r.release_date.slice(0, 10), country: c.iso_3166_1 }))
        )
        .sort((a, b) => a.date.localeCompare(b.date))[0];
    return first || { date: null, country: null };
}

/**
 * The columns of a newly tracked series. It starts at the latest episode already aired, so the
 * first update check announces only what comes after; with nothing aired yet, at season 0, so
 * the first episode counts as new. Starting anywhere else made that check announce episodes
 * that were out long before (a season's finale, "the whole season is out").
 */
function newSeriesFields(details) {
    const last = details.last_episode_to_air;
    return {
        title: details.name || details.original_name || 'Без названия',
        last_season: last ? last.season_number : 0,
        last_episode: last ? last.episode_number : 0,
        last_episode_name: (last && last.name) || '',
        poster_url: details.poster_url || tmdbPoster(details.poster_path),
        status: details.status || null,
        tvmaze_id: details.tvmaze_id || null,
        episode_source: details.data_source || 'tmdb',
        ...nextEpisodeFields(details),
        ...titleFacts(details, 'tv')
    };
}

/**
 * What a title is, for the chats' statistics: genres and countries ("Драма, Комедия", "US,GB"),
 * a series' channels ("HBO, Max"), the length in minutes (a series': its usual episode) and the
 * TMDB rating. Columns of Series (all) and Watchlist (all but networks).
 */
function titleFacts(details, mediaType) {
    const names = (list, max) =>
        (list || [])
            .map((x) => x.name)
            .filter(Boolean)
            .join(', ')
            .slice(0, max) || null;
    const countries =
        mediaType === 'tv'
            ? details.origin_country || []
            : (details.production_countries || []).map((c) => c.iso_3166_1);
    const runtime =
        mediaType === 'tv'
            ? (details.episode_run_time || [])[0] ||
              (details.last_episode_to_air && details.last_episode_to_air.runtime)
            : details.runtime;
    const rating = Number(details.vote_average);
    return {
        genres: names(details.genres, 255),
        ...(mediaType === 'tv'
            ? { networks: names(details.networks, 255), rating_source: details.rating_source || 'tmdb' }
            : {}),
        countries: countries.filter(Boolean).join(',').slice(0, 40) || null,
        runtime: Number(runtime) > 0 ? Math.round(Number(runtime)) : null,
        rating: rating > 0 ? Math.round(rating * 10) / 10 : null
    };
}

/** Series columns for TMDB's next announced episode; all null when none is announced. */
function nextEpisodeFields(data) {
    const next = data && data.next_episode_to_air;
    return {
        next_episode_date: (next && next.air_date) || null,
        // ?? not ||: season 0 holds TMDB's specials
        next_episode_season: next ? (next.season_number ?? null) : null,
        next_episode_number: next ? (next.episode_number ?? null) : null
    };
}

/**
 * @param {number[]} [seasons] series only: seasons to bring in the same request (TMDB appends up
 *   to 20 parts); they go to the season cache, not into the details
 */
const fetchDetails = async (id, media_type, seasons = []) => {
    try {
        const response = await apiClient.get(`/${media_type}/${id}`, {
            params: {
                language: 'ru-RU',
                // external_ids carries the IMDb ID, used to look up the Kinopoisk ID;
                // release_dates (films only) carries the digital release
                append_to_response: [
                    'credits',
                    'external_ids',
                    ...(media_type === 'movie' ? ['release_dates'] : seasons.map((s) => `season/${s}`))
                ].join(',')
            }
        });
        const data = response.data;
        if (media_type === 'tv') keepSeasons(id, 'ru-RU', data);

        // Extract director if it's a movie
        if (media_type === 'movie' && data.credits && data.credits.crew) {
            const director = data.credits.crew.find((person) => person.job === 'Director');
            if (director) data.director_name = director.name;
        } else if (media_type === 'tv' && data.created_by && data.created_by.length > 0) {
            // For TV shows, we use "created_by" as the equivalent
            data.director_name = data.created_by.map((c) => c.name).join(', ');
        }

        data.imdb_id = data.imdb_id || (data.external_ids && data.external_ids.imdb_id) || null;
        if (media_type === 'movie') {
            const digital = digitalRelease(data.release_dates);
            data.digital_release_date = digital.date;
            data.digital_release_country = digital.country;
            // What src/film-release.js decides by: the first wide cinema release anywhere and in
            // Russia, and the first digital release anywhere (shown above is Russia's or the US's)
            const cinema = firstRelease(data.release_dates, THEATRICAL);
            data.cinema_release_date = cinema.date;
            data.cinema_release_country = cinema.country;
            data.cinema_ru_date = firstRelease(data.release_dates, THEATRICAL, 'RU').date;
            const limited = firstRelease(data.release_dates, LIMITED);
            data.limited_release_date = limited.date;
            data.limited_release_country = limited.country;
            const firstDigital = firstRelease(data.release_dates, DIGITAL);
            data.digital_first_date = firstDigital.date;
            data.digital_first_country = firstDigital.country;
        }

        return data;
    } catch (error) {
        log.error(`TMDB API Error (getDetails ${media_type}/${id}): ${error.message}`);
        throw error;
    }
};

// --- Details cache ---
// Every fetch is stored, so the update check keeps the cache fresh for the tracked titles
// and the admin panel's cards are served from it. Two intervals of lifetime: one failed
// check doesn't send the panel back to TMDB. Failures are not stored.
const DETAILS_TTL_MS = 2 * UPDATE_INTERVAL_HOURS * 60 * 60 * 1000;
const DETAILS_CACHE_MAX = 500;
const detailsCache = lruCache({
    max: DETAILS_CACHE_MAX,
    ttl: DETAILS_TTL_MS,
    fetchMethod: (key, _stale, { context }) => {
        const [mediaType, id] = key.split(':');
        return fetchDetails(id, mediaType, context);
    }
}); // "tv:1399" -> details

const cacheKey = (id, media_type) => `${media_type}:${id}`;

/**
 * Always asks TMDB (the update check needs current data) and refreshes the cache.
 * Concurrent calls for the same title share one request.
 * @param {{ seasons?: number[] }} [options] series: seasons to refresh in the same request
 */
const getDetails = (id, media_type, { seasons = [], tvmazeBudget = null, fallbackSeries = null } = {}) => {
    const load = () => detailsCache.fetch(cacheKey(id, media_type), { forceRefresh: true, context: seasons });
    return media_type === 'tv'
        ? require('./series-data')
              .resolve(id, load, { fresh: true, budget: tvmazeBudget, fallback: fallbackSeries })
              .then((data) => migrationCursor(data, fallbackSeries))
              .then(localizeSeries)
        : load();
};

/** Read the already-announced episode, not just TMDB's newest episode, before changing catalogs. */
async function migrationCursor(data, previous) {
    if (
        !data.tvmaze_primary ||
        data.tvmaze_missing ||
        data.seed_only ||
        !previous?.last_episode ||
        previous.episode_source === 'tvmaze'
    )
        return data;
    const last = data.tmdb_last_episode;
    if (last?.season_number === previous.last_season && last?.episode_number === previous.last_episode) {
        data.tmdb_cursor_episode = last;
        return data;
    }
    const season = await require('./series-data').optional(
        fetchFresh(seasonCache, seasonKey(String(data.id), previous.last_season, 'ru-RU')),
        3000
    );
    const episode = season?.episodes?.find((e) => e.episode_number === previous.last_episode);
    data.tmdb_cursor_episode = episode ? { ...episode, season_number: previous.last_season } : null;
    return data;
}

/** The cached details when fresh enough, otherwise a fetch. For display only. */
const getDetailsCached = (id, media_type, { deadline = null } = {}) => {
    const load = () => fetchFresh(detailsCache, cacheKey(id, media_type));
    return media_type === 'tv'
        ? require('./series-data')
              .resolve(id, load, { deadline })
              .then((data) => localizeSeries(data, deadline))
        : load();
};

/** Optional Russian episode text never replaces TVmaze's numbering or dates. */
async function localizeSeries(data, deadline = null) {
    if (!data.tvmaze_primary || data.tvmaze_missing || data.seed_only || deadline?.passed()) return data;
    const episodes = [data.last_episode_to_air, data.next_episode_to_air].filter(Boolean);
    const numbers = [...new Set(episodes.filter((e) => !/[а-яё]/i.test(e.name || '')).map((e) => e.season_number))];
    if (!numbers.length) return data;
    const localize = Promise.all(
        numbers.map(async (number) => {
            const season = await getSeasonDetailsCached(String(data.id), number, 'ru-RU', { deadline }).catch(
                () => null
            );
            for (const field of ['last_episode_to_air', 'next_episode_to_air']) {
                const current = data[field];
                const translated = season?.episodes?.find(
                    (e) =>
                        e.season_number === current?.season_number &&
                        e.episode_number === current?.episode_number &&
                        e.air_date === current?.air_date
                );
                if (translated) data[field] = { ...current, name: translated.name, overview: translated.overview };
            }
        })
    );
    await require('./series-data').optional(localize, 3000, null, deadline);
    return data;
}

/** Optional display metadata only: never fetch or wait for TMDB on a cache miss. */
const peekDetails = (id, media_type) =>
    (media_type === 'tv' && require('./series-data').peek(id)) || detailsCache.peek(cacheKey(id, media_type));

// Returns season details including episodes
const getSeasonDetailsRaw = async (tv_id, season_number, language = 'ru-RU') => {
    try {
        const response = await apiClient.get(`/tv/${tv_id}/season/${season_number}`, {
            params: { language }
        });
        return response.data;
    } catch (error) {
        log.error(`TMDB API Error (getSeasonDetails ${tv_id} s${season_number}): ${error.message}`);
        throw error;
    }
};

async function preferredSeason(tvId, seasonNumber, load, deadline = null, cached = null) {
    const show = require('./tvmaze').cachedShow(`tv_${tvId}`);
    if (!show) {
        if (require('./series-data').sourceOf(tvId) === 'tvmaze')
            throw new Error('TVmaze season unavailable; keeping stored statistics');
        if (!deadline) return load();
        const season = deadline.passed()
            ? cached
            : await require('./series-data').optional(load(), 3000, cached, deadline);
        if (!season) throw new Error('Series view deadline expired');
        return season;
    }
    const russian = deadline?.passed()
        ? cached
        : await require('./series-data').optional(load(), 3000, cached, deadline);
    return require('./series-data').seasonOf(show, seasonNumber, russian);
}

const getSeasonDetails = (tvId, seasonNumber, language = 'ru-RU') =>
    preferredSeason(tvId, seasonNumber, () => getSeasonDetailsRaw(tvId, seasonNumber, language));

// Seasons for the bot's week and month views: the same lifetime as the details. Not refreshed
// by the update check, which reads only the details
const seasonCache = lruCache({
    max: DETAILS_CACHE_MAX,
    ttl: DETAILS_TTL_MS,
    fetchMethod: (key) => {
        const [tvId, seasonNumber, language] = key.split(':');
        return getSeasonDetailsRaw(tvId, seasonNumber, language).then(slimSeason);
    }
}); // "1399:2:ru-RU" -> season

const seasonKey = (tvId, seasonNumber, language) => `${tvId}:${seasonNumber}:${language}`;

/** A season without each episode's crew and guest stars: nothing reads them, they are most of the size. */
const slimSeason = (season) => ({
    ...season,
    episodes: (season.episodes || []).map(({ crew, guest_stars, ...episode }) => episode)
});

/** Moves the "season/N" parts of a series response into the season cache. */
function keepSeasons(tvId, language, data) {
    for (const part of Object.keys(data)) {
        const number = part.startsWith('season/') ? Number(part.slice(7)) : NaN;
        if (!Number.isInteger(number)) continue;
        if (data[part]) seasonCache.set(seasonKey(tvId, number, language), slimSeason(data[part]));
        delete data[part];
    }
}

/** A season's episodes, from memory when fresh enough; concurrent calls share one request. */
const getSeasonDetailsCached = (tvId, seasonNumber, language = 'ru-RU', { deadline = null } = {}) => {
    const key = seasonKey(tvId, seasonNumber, language);
    const cached = seasonCache.getRemainingTTL(key) > 0 ? seasonCache.peek(key) : null;
    return preferredSeason(tvId, seasonNumber, () => fetchFresh(seasonCache, key), deadline, cached);
};

/** Whether the season is in memory and not yet expired. */
const hasSeason = (tvId, seasonNumber, language = 'ru-RU') =>
    seasonCache.getRemainingTTL(seasonKey(tvId, seasonNumber, language)) > 0;

/** Several seasons of a series in one request, into the season cache. */
async function refreshSeasons(tvId, seasons, language = 'ru-RU') {
    if (!seasons.length) return;
    try {
        const response = await apiClient.get(`/tv/${tvId}`, {
            params: { language, append_to_response: seasons.map((s) => `season/${s}`).join(',') }
        });
        keepSeasons(tvId, language, response.data);
    } catch (error) {
        log.error(`TMDB API Error (refreshSeasons ${tvId} ${seasons.join(',')} ${language}): ${error.message}`);
        throw error;
    }
}

module.exports = {
    tmdbPoster,
    hasSeason,
    refreshSeasons,
    getSeasonDetailsCached,
    searchMulti,
    digitalRelease,
    firstRelease,
    getDetails,
    getDetailsCached,
    peekDetails,
    nextEpisodeFields,
    newSeriesFields,
    titleFacts,
    getSeasonDetails
};
