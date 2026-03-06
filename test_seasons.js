require('dotenv').config();
const { getSeasons } = require('./src/api/kinopoisk');

async function test() {
    // Kinopoisk ID for some series, maybe Breaking Bad: 404900, Sopranos: 4574
    const seasons = await getSeasons(4574);
    if (seasons && seasons.length > 0) {
        const lastSeason = seasons[seasons.length - 1];
        if (lastSeason.episodes && lastSeason.episodes.length > 0) {
            console.log(lastSeason.episodes[0]); // Check episode shape
        }
    }
}
test().catch(console.error);
