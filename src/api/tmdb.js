const axios = require('axios');
const https = require('https');
require('dotenv').config();

const BASE_URL = 'https://api.themoviedb.org/3';

const apiClient = axios.create({
    baseURL: BASE_URL,
    timeout: 10000,
    httpsAgent: new https.Agent({
        rejectUnauthorized: process.env.TMDB_IGNORE_SSL !== 'true'
    })
});

apiClient.interceptors.request.use((config) => {
    const apiKey = process.env.TMDB_API_KEY;
    if (apiKey) {
        config.headers['Authorization'] = `Bearer ${apiKey}`;
    }
    config.headers['Content-Type'] = 'application/json';

    return config;
});

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
                language: 'ru-RU'
            }
        });
        return response.data;
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
