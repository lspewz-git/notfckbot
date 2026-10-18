const axios = require('axios');
const { getProxyAgent } = require('../proxy');
const { installDeadline } = require('../http-deadline');
const { UPDATE_INTERVAL_HOURS } = require('../constants');
const { lruCache, fetchFresh } = require('../lru');
require('dotenv').config();
const { log } = require('../log');

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

/** The digital release date alone. */
const digitalReleaseDate = (releaseDates) => digitalRelease(releaseDates).date;

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
        poster_url: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null,
        status: details.status || null,
        ...nextEpisodeFields(details)
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

const fetchDetails = async (id, media_type) => {
    try {
        const response = await apiClient.get(`/${media_type}/${id}`, {
            params: {
                language: 'ru-RU',
                // external_ids carries the IMDb ID, used to look up the Kinopoisk ID;
                // release_dates (films only) carries the digital release
                append_to_response:
                    media_type === 'movie' ? 'credits,external_ids,release_dates' : 'credits,external_ids'
            }
        });
        const data = response.data;

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
    fetchMethod: (key) => {
        const [mediaType, id] = key.split(':');
        return fetchDetails(id, mediaType);
    }
}); // "tv:1399" -> details

const cacheKey = (id, media_type) => `${media_type}:${id}`;

/**
 * Always asks TMDB (the update check needs current data) and refreshes the cache.
 * Concurrent calls for the same title share one request.
 */
const getDetails = (id, media_type) => detailsCache.fetch(cacheKey(id, media_type), { forceRefresh: true });

/** The cached details when fresh enough, otherwise a fetch. For display only. */
const getDetailsCached = (id, media_type) => fetchFresh(detailsCache, cacheKey(id, media_type));

// Returns season details including episodes
const getSeasonDetails = async (tv_id, season_number) => {
    try {
        const response = await apiClient.get(`/tv/${tv_id}/season/${season_number}`, {
            params: {
                language: 'ru-RU'
            }
        });
        return response.data;
    } catch (error) {
        log.error(`TMDB API Error (getSeasonDetails ${tv_id} s${season_number}): ${error.message}`);
        throw error;
    }
};

// Seasons for the bot's week and month views: the same lifetime as the details. Not refreshed
// by the update check, which reads only the details
const seasonCache = lruCache({
    max: DETAILS_CACHE_MAX,
    ttl: DETAILS_TTL_MS,
    fetchMethod: (key) => {
        const [tvId, seasonNumber] = key.split(':');
        return getSeasonDetails(tvId, seasonNumber);
    }
}); // "1399:2" -> season

/** A season's episodes, from memory when fresh enough; concurrent calls share one request. */
const getSeasonDetailsCached = (tvId, seasonNumber) => fetchFresh(seasonCache, `${tvId}:${seasonNumber}`);

module.exports = {
    getSeasonDetailsCached,
    searchMulti,
    digitalReleaseDate,
    digitalRelease,
    getDetails,
    getDetailsCached,
    nextEpisodeFields,
    newSeriesFields,
    getSeasonDetails
};
