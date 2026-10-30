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

// First: every handler after it reads and writes where the conversation is (ctx.session)
bot.use(require('./state').stateSession);
// Before the middleware creates a row for it: a group turned supergroup takes its data along
require('./migration').register(bot);
// Before the throttle: a block or a removal right after a button tap must not be dropped
require('./membership').register(bot);
require('./middleware').register(bot);
// Right after the middleware, which loads the chat's settings: decides who may press buttons
require('./access').register(bot);
// For the chat's statistics: what it opens (only updates that got past the throttle and the block)
require('./usage').register(bot);
// Before the commands: "/start L<code>" is a sign-in to the panel, not the usual /start
require('./login').register(bot);
require('./commands').register(bot);
// Before the search: its free-text handler would otherwise see "⚙️ Настройки" first
require('./settings').register(bot);
require('./search').register(bot);
require('./subscriptions').register(bot);
require('./history').register(bot);
require('./calendar').register(bot);
require('./held').register(bot);
const { log } = require('../log');

// Without this, Telegraf rethrows a handler's error and its polling loop stops for good: one
// failed edit or a button answered too late, and the bot would stop answering everyone until
// restarted. Log it, tell the user if they pressed a button, and go on with the next update.
bot.catch((err, ctx) => {
    log.error(`[Bot] Error in update ${ctx.update && ctx.update.update_id}: ${err.message}`);
    if (ctx.callbackQuery) ctx.answerCbQuery('Что-то пошло не так. Попробуйте ещё раз.').catch(() => {});
});

// ============================================================
// Setup Bot Commands Menu (Slash commands highlighting)
// ============================================================
bot.telegram
    .setMyCommands([
        { command: 'start', description: 'Перезапустить бота' },
        { command: 'search', description: 'Найти фильм или сериал' },
        { command: 'subs', description: 'Мои подписки и список ожидания' },
        { command: 'help', description: 'Как пользоваться ботом' },
        { command: 'week', description: 'Календарь: неделя и месяц' },
        { command: 'history', description: 'Календарь: по годам' },
        { command: 'settings', description: 'Настройки чата' },
        { command: 'cancel', description: 'Отменить текущее действие' },
        { command: 'menu_on', description: 'Включить нижнее меню' },
        { command: 'menu_off', description: 'ОТКЛЮЧИТЬ нижнее меню' }
    ])
    .catch((err) => log.error({ err }, '[Bot] Failed to set commands'));

module.exports = bot;
