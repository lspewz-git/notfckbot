const sequelize = require('./src/database');
require('./src/models/Chat');
require('./src/models/Series');
require('./src/models/Subscription');
require('./src/models/Watchlist');

async function resetDb() {
    try {
        await sequelize.authenticate();
        console.log('Connected.');
        await sequelize.sync({ force: true });
        console.log('Database forcefully synchronized (all tables dropped and recreated).');
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

resetDb();
