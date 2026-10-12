/**
 * The Telegram bot. Telegraf runs handlers in the order they are registered, so the
 * modules go in: middleware first, then commands and menu buttons, then the free-text
 * search handler, then inline buttons.
 */
const { Telegraf } = require('telegraf');
const { getProxyAgent } = require('../proxy');
require('dotenv').config();

// Route Bot API traffic through the proxy too, not just TMDB. The agent is
// swapped at runtime by the admin panel via applyProxyToBot().
const bot = new Telegraf(process.env.BOT_TOKEN, {
    telegram: { agent: getProxyAgent() }
});

require('./middleware').register(bot);
require('./commands').register(bot);
require('./search').register(bot);
require('./subscriptions').register(bot);

// ============================================================
// Setup Bot Commands Menu (Slash commands highlighting)
// ============================================================
bot.telegram
    .setMyCommands([
        { command: 'start', description: 'Перезапустить бота' },
        { command: 'search', description: 'Найти фильм или сериал' },
        { command: 'subs', description: 'Мои подписки и список ожидания' },
        { command: 'help', description: 'Как пользоваться ботом' },
        { command: 'cancel', description: 'Отменить текущее действие' },
        { command: 'menu_on', description: 'Включить нижнее меню' },
        { command: 'menu_off', description: 'ОТКЛЮЧИТЬ нижнее меню' }
    ])
    .catch((err) => console.error('[Bot] Failed to set commands:', err));

module.exports = bot;
