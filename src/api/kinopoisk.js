const axios = require('axios');
require('dotenv').config();

const BASE_URL = 'https://api.poiskkino.dev';

const apiClient = axios.create({
    baseURL: BASE_URL,
    timeout: 10000,
});

// Read API key dynamically on every request so runtime changes take effect immediately
apiClient.interceptors.request.use((config) => {
    config.headers['X-API-KEY'] = process.env.KINOPOISK_API_KEY;
    config.headers['Content-Type'] = 'application/json';

    // Create a safe copy of headers for logging
    const safeHeaders = { ...config.headers };
    if (safeHeaders['X-API-KEY'] && safeHeaders['X-API-KEY'].length > 4) {
        safeHeaders['X-API-KEY'] = '***' + safeHeaders['X-API-KEY'].slice(-4);
    }

    console.log(`[API Request] ${config.method.toUpperCase()} ${config.baseURL || ''}${config.url} | Params: ${JSON.stringify(config.params || {})} | Headers: ${JSON.stringify(safeHeaders)}`);

    return config;
});

const searchSeries = async (query) => {
    try {
        const response = await apiClient.get('/v1.4/movie/search', {
            params: {
                query: query,
                limit: 10
            }
        });
        return response.data.docs || [];
    } catch (error) {
        console.error('API Error (search):', error.message);
        throw error;
    }
};

const getSeriesData = async (kp_id) => {
    try {
        const response = await apiClient.get(`/v1.4/movie/${kp_id}`);
        return response.data;
    } catch (error) {
        console.error('API Error (getDetails):', error.message);
        throw error;
    }
};

const getSeasons = async (kp_id) => {
    try {
        const response = await apiClient.get('/v1.4/season', {
            params: {
                movieId: kp_id,
                limit: 100 // Get all seasons
            }
        });
        // poiskkino.dev returns seasons in 'docs'
        // Sort by number just in case
        return (response.data.docs || []).sort((a, b) => a.number - b.number);
    } catch (error) {
        console.error('API Error (getSeasons):', error.message);
        throw error;
    }
};

module.exports = {
    searchSeries,
    getSeriesData,
    getSeasons
};
