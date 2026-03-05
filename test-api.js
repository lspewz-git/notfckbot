const axios = require('./node_modules/axios');
require('./node_modules/dotenv').config();

const API_KEY = process.env.KINOPOISK_API_KEY;
const BASE_URL = 'https://api.poiskkino.dev';

async function test() {
    try {
        const response = await axios.get(`${BASE_URL}/v1.4/season`, {
            params: {
                movieId: 464963, // Game of Thrones
                limit: 10
            },
            headers: { 'X-API-KEY': API_KEY }
        });
        const season = response.data.docs[0];
        console.log('Season Number:', season.number);
        console.log('Episodes Count:', season.episodesCount);
        console.log('Is Complete:', season.episodesCount === (season.episodes ? season.episodes.length : 0));
        if (season.episodes && season.episodes.length > 0) {
            console.log('Last Episode Date:', season.episodes[season.episodes.length - 1].date);
        }
        // console.log(JSON.stringify(season, null, 2));
    } catch (err) {
        console.error(err.message);
    }
}
test();
