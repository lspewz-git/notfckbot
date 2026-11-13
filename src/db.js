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
const RecapLook = require('./models/RecapLook');
const AlertRecipient = require('./models/AlertRecipient');
const AlertLog = require('./models/AlertLog');
const SendFailure = require('./models/SendFailure');
const SentNotification = require('./models/SentNotification');
const AccountSession = require('./models/AccountSession');
const AccountDevice = require('./models/AccountDevice');
const LoginLink = require('./models/LoginLink');
const MiniAppLaunch = require('./models/MiniAppLaunch');
const AccountPassword = require('./models/AccountPassword');
const PanelRole = require('./models/PanelRole');
const HiddenChat = require('./models/HiddenChat');
const { log } = require('./log');

const initDb = async () => {
    try {
        await sequelize.authenticate();
        log.info('Connection to MariaDB has been established successfully.');

        // Sync models
        await sequelize.sync({ alter: true });
        await require('./account/auth').capSessionLifetimes();
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
    RecapSend,
    RecapLook,
    AlertRecipient,
    AlertLog,
    SendFailure,
    SentNotification,
    AccountSession,
    AccountDevice,
    LoginLink,
    MiniAppLaunch,
    AccountPassword,
    PanelRole,
    HiddenChat
};
