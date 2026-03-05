require('dotenv').config();
const { initDb } = require('./db');
const bot = require('./bot');
const { setupCron } = require('./cron');
const { startAdminServer } = require('./admin');

async function start() {
    try {
        console.log('Starting NotFckBot...');

        // Initialize Database
        await initDb();

        // Setup Cron Jobs
        setupCron(bot);

        // Launch Bot with explicit configuration
        console.log('Verifying bot token...');
        const botInfo = await bot.telegram.getMe();
        console.log(`Bot verified: @${botInfo.username}`);

        console.log('Cleaning up old webhooks...');
        await bot.telegram.deleteWebhook();

        // Start Admin Dashboard
        startAdminServer(bot);

        console.log('Launching Telegram bot...');
        bot.launch({ dropPendingUpdates: true })
            .then(() => console.log('Bot is running! 🚀'))
            .catch(err => console.error('Bot launch failed:', err));

        // Enable graceful stop
        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));

    } catch (err) {
        console.error('Fatal error during startup:', err);
        process.exit(1);
    }
}

start();
