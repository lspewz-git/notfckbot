const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config();

const BASE_URL = 'https://api.themoviedb.org/3';

let cachedProxyAgent = null;
let currentProxyUrl = null;

const getProxyAgent = () => {
    const proxyUrl = process.env.TMDB_PROXY_URL;
    if (!proxyUrl) {
        cachedProxyAgent = null;
        currentProxyUrl = null;
        return null;
    }

    // Reuse agent if URL hasn't changed to avoid ECONNRESET/socket leaks
    if (proxyUrl === currentProxyUrl && cachedProxyAgent) {
        return cachedProxyAgent;
    }

    currentProxyUrl = proxyUrl;
    if (proxyUrl.startsWith('socks')) {
        cachedProxyAgent = new SocksProxyAgent(proxyUrl, { rejectUnauthorized: false });
    } else if (proxyUrl.startsWith('http')) {
        cachedProxyAgent = new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false });
    } else {
        cachedProxyAgent = null;
    }
    return cachedProxyAgent;
};

const apiClient = axios.create({
    baseURL: BASE_URL,
    timeout: 15000, // Increased timeout for slow proxies
    proxy: false
});

apiClient.interceptors.request.use((config) => {
    const apiKey = process.env.TMDB_API_KEY;
    if (apiKey) {
        config.headers['Authorization'] = `Bearer ${apiKey}`;
    }
    config.headers['Content-Type'] = 'application/json';

    // Apply proxy dynamically
    config.httpsAgent = getProxyAgent();

    return config;
}, (error) => Promise.reject(error));

// Log details on success and error to help debugging
apiClient.interceptors.response.use(
    (response) => {
        if (response.config.method === 'get') {
            console.log(`[TMDB] ✅ Successful GET: ${response.config.url}`);
        }
        return response;
    },
    (error) => {
        if (error.code === 'ECONNRESET') {
            console.error('[TMDB] ❌ Connection Reset. Check your Proxy or Network.');
        } else if (error.code === 'ETIMEDOUT') {
            console.error('[TMDB] ❌ Timeout. Proxy is too slow.');
        }
        return Promise.reject(error);
    }
);

const searchMulti = async (query) => {
    try {
        const response = await apiClient.get('/search/multi', {
            params: {
                query: query,
                language: 'ru-RU',
            }
        });

        // Return only movies and tv shows
        return (response.data.results || []).filter(item =>
            item.media_type === 'movie' || item.media_type === 'tv'
        );
    } catch (error) {
        console.error('TMDB API Error (searchMulti):', error.message);
        throw error;
    }
};

const getDetails = async (id, media_type) => {
    try {
        const response = await apiClient.get(`/${media_type}/${id}`, {
            params: {
                language: 'ru-RU',
                append_to_response: 'credits'
            }
        });
        const data = response.data;

        // Extract director if it's a movie
        if (media_type === 'movie' && data.credits && data.credits.crew) {
            const director = data.credits.crew.find(person => person.job === 'Director');
            if (director) data.director_name = director.name;
        } else if (media_type === 'tv' && data.created_by && data.created_by.length > 0) {
            // For TV shows, we use "created_by" as the equivalent
            data.director_name = data.created_by.map(c => c.name).join(', ');
        }

        return data;
    } catch (error) {
        console.error(`TMDB API Error (getDetails ${media_type}/${id}):`, error.message);
        throw error;
    }
};

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
        console.error(`TMDB API Error (getSeasonDetails ${tv_id} s${season_number}):`, error.message);
        throw error;
    }
};

// Retrieves a highly-rated random movie
const getRandomMovie = async () => {
    try {
        // Random page from 1 to 50
        const randomPage = Math.floor(Math.random() * 50) + 1;
        const response = await apiClient.get('/discover/movie', {
            params: {
                language: 'ru-RU',
                page: randomPage,
                sort_by: 'popularity.desc',
                'vote_count.gte': 500,
                'vote_average.gte': 7.0,
            }
        });

        const results = response.data.results || [];
        if (results.length === 0) return null;

        // Pick a random movie from the results array (usually 20 items per page)
        const randomIndex = Math.floor(Math.random() * results.length);
        const movie = results[randomIndex];
        // Ensure its tagged as a movie for our handler
        movie.media_type = 'movie';
        return movie;
    } catch (error) {
        console.error('TMDB API Error (getRandomMovie):', error.message);
        throw error;
    }
};

module.exports = {
    searchMulti,
    getDetails,
    getSeasonDetails,
    getRandomMovie
};
