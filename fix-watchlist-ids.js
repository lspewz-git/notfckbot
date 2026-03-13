const { Watchlist, initDb } = require('./src/db');

async function fixWatchlist() {
    console.log('Starting Watchlist ID migration...');
    const entries = await Watchlist.findAll();
    let fixedCount = 0;

    for (const entry of entries) {
        if (!entry.tmdb_id.includes('_')) {
            const oldId = entry.tmdb_id;
            const newId = `movie_${oldId}`;
            console.log(`Fixing entry ${entry.id}: ${oldId} -> ${newId}`);
            await entry.update({ tmdb_id: newId });
            fixedCount++;
        }
    }

    console.log(`Migration complete. Fixed ${fixedCount} entries.`);
    process.exit(0);
}

// Ensure database is initialized before running
async function run() {
    await initDb();
    await fixWatchlist();
}

run();
