const sequelize = require('./database');
const Chat = require('./models/Chat');
const Series = require('./models/Series');
const Subscription = require('./models/Subscription');
const Watchlist = require('./models/Watchlist');
const PendingMessage = require('./models/PendingMessage');
const HeldNotification = require('./models/HeldNotification');
const DailyStat = require('./models/DailyStat');
const ChatEvent = require('./models/ChatEvent');
const RecapSend = require('./models/RecapSend');
const { log } = require('./log');

const initDb = async () => {
    try {
        await sequelize.authenticate();
        log.info('Connection to MariaDB has been established successfully.');

        // Sync models
        await sequelize.sync({ alter: true });
        log.info('Database models synchronized.');
    } catch (error) {
        log.error({ err: error }, 'Unable to connect to the database');
        process.exit(1);
    }
};

module.exports = {
    initDb,
    Chat,
    Series,
    Subscription,
    Watchlist,
    PendingMessage,
    HeldNotification,
    DailyStat,
    ChatEvent,
    RecapSend
};
