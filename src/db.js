const sequelize = require('./database');
const Chat = require('./models/Chat');
const Series = require('./models/Series');
const Subscription = require('./models/Subscription');
const Watchlist = require('./models/Watchlist');

const initDb = async () => {
    try {
        await sequelize.authenticate();
        console.log('Connection to MariaDB has been established successfully.');

        // Sync models
        await sequelize.sync({ alter: true });
        console.log('Database models synchronized.');
    } catch (error) {
        console.error('Unable to connect to the database:', error);
        process.exit(1);
    }
};

module.exports = { initDb, Chat, Series, Subscription, Watchlist };
