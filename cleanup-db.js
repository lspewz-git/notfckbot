const { Series, Subscription } = require('./src/db');
const sequelize = require('./src/database');

async function cleanup() {
    try {
        await sequelize.authenticate();
        console.log('Connected to DB.');

        const allSeries = await Series.findAll();
        for (const s of allSeries) {
            if (!s.tmdb_id.includes('_')) {
                const newId = `tv_${s.tmdb_id}`;
                console.log(`Fixing ${s.tmdb_id} -> ${newId}`);

                // We can't just update primary key easily in some DBs without cascades
                // Better approach: Create new, move subs, delete old

                const [newSeries] = await Series.findOrCreate({
                    where: { tmdb_id: newId },
                    defaults: {
                        title: s.title,
                        last_season: s.last_season,
                        last_episode: s.last_episode,
                        last_episode_name: s.last_episode_name,
                        poster_url: s.poster_url
                    }
                });

                await Subscription.update({ seriesId: newId }, { where: { seriesId: s.tmdb_id } });
                await s.destroy();
            }
        }
        console.log('Cleanup complete.');
        process.exit(0);
    } catch (err) {
        console.error('Cleanup failed:', err);
        process.exit(1);
    }
}

cleanup();
