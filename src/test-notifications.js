const { initDb, Series } = require('./db');
const bot = require('./bot');
const { checkUpdates } = require('./cron');
const { Subscription } = require('./db');

async function testNotification(kpId, forceMode = 'episode') {
    try {
        console.log('--- Notification Test Tool ---');
        await initDb();

        const series = await Series.findByPk(kpId);
        if (!series) {
            console.error(`Series with KP ID ${kpId} not found in database.`);
            console.log('Hint: Subscribe to the series in the bot first.');
            process.exit(1);
        }

        console.log(`Testing notifications for: ${series.title}`);
        console.log(`Current state: S${series.last_season}E${series.last_episode}`);

        // Simulate an older state to trigger "new episode" detection
        const originalSeason = series.last_season;
        const originalEpisode = series.last_episode;

        if (series.last_episode > 1) {
            await series.update({ last_episode: series.last_episode - 1 });
        } else if (series.last_season > 1) {
            await series.update({ last_season: series.last_season - 1, last_episode: 10 }); // Assume previous season had some episodes
        } else {
            // If it's 1x1, just reset to 0/0
            await series.update({ last_season: 0, last_episode: 0 });
        }

        console.log(`Simulated old state: S${series.last_season}E${series.last_episode}`);

        if (forceMode === 'season') {
            console.log('Forcing "season" mode for ALL subscribers of this series...');
            await Subscription.update({ notify_type: 'season' }, { where: { seriesId: kpId } });
        } else if (forceMode === 'first_episode') {
            console.log('Forcing "first_and_full" mode for ALL subscribers and resetting state to 0x0...');
            await Subscription.update({ notify_type: 'first_and_full' }, { where: { seriesId: kpId } });
            await series.update({ last_season: 0, last_episode: 0 });
        }

        console.log('Running update check...');
        await checkUpdates(bot);

        console.log('\nTest completed! 🚀');
        console.log('If the season is complete in the API, you should receive a "Whole Season" notification.');
        console.log('Otherwise, you will receive an "Episode" notification (if you didn\'t force season mode).');
        process.exit(0);
    } catch (err) {
        console.error('Test failed:', err);
        process.exit(1);
    }
}

const kpId = process.argv[2];
const mode = process.argv[3] || 'episode';

if (!kpId) {
    console.log('Usage: node src/test-notifications.js <KinoPoisk_ID> [episode|season|first_episode]');
    console.log('Example: node src/test-notifications.js 464963 first_episode');
    process.exit(1);
}

testNotification(kpId, mode);
