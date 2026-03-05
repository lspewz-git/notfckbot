/**
 * test-watchlist.js — simulate a digital release notification for a movie in the Watchlist.
 *
 * Usage: node src/test-watchlist.js <KinoPoisk_ID>
 *
 * What it does:
 *  1. Finds the movie in the Watchlist table for all users who added it.
 *  2. Forces premiere_digital to yesterday's date (simulating a just-released film).
 *  3. Runs the cron update check, which will trigger the release notification.
 *  4. Restores the notified = false flag so you can re-test (optional).
 */

require('dotenv').config();
const { initDb, Watchlist } = require('./db');
const bot = require('./bot');
const { checkUpdates } = require('./cron');

async function testWatchlistRelease(kpId) {
    console.log('--- Watchlist Movie Release Test ---');

    try {
        await initDb();

        // Find all unnotified watchlist entries for this movie
        const entries = await Watchlist.findAll({
            where: { kp_id: kpId, notified: false }
        });

        if (entries.length === 0) {
            console.error(`\nNo watchlist entries found for KP ID ${kpId}.`);
            console.log('Hint: Search for the movie in the bot and click "📌 В список ожидания" first.');
            process.exit(1);
        }

        const title = entries[0].title;
        console.log(`\nFound ${entries.length} watchlist subscriber(s) for: ${title}`);

        // Set premiere_digital to yesterday to simulate a release
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const fakeDate = yesterday.toISOString();

        console.log(`\nForcing digital release date to: ${yesterday.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}`);
        await Watchlist.update(
            { premiere_digital: fakeDate },
            { where: { kp_id: kpId, notified: false } }
        );

        console.log('\nRunning cron update check — notification should be sent now...\n');
        await checkUpdates(bot);

        console.log('\n✅ Test complete! Check Telegram for the release notification.');
        process.exit(0);
    } catch (err) {
        console.error('\nTest failed:', err);
        process.exit(1);
    }
}

const kpId = process.argv[2];

if (!kpId) {
    console.log('Usage: node src/test-watchlist.js <KinoPoisk_ID>');
    console.log('Example: node src/test-watchlist.js 533447');
    process.exit(1);
}

testWatchlistRelease(kpId);
