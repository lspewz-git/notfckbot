require('dotenv').config();
const { getSeriesData } = require('./src/api/kinopoisk');

async function test() {
    // 404900 = Breaking Bad (completed)
    // 4574 = Sopranos (completed)
    // Try to inspect the status field
    try {
        const data = await getSeriesData(404900);
        console.log("Status:", data.status);
        console.log("ReleaseYears:", data.releaseYears);
    } catch (e) {
        console.error(e);
    }
}
test();
