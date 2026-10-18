/** Reply keyboards and link buttons shared by the handlers. */
const { Markup } = require('telegraf');
const { getWatchLinks } = require('../constants');

const mainMenu = (ctx) => {
    if (ctx.state && ctx.state.chatData && ctx.state.chatData.menu_enabled === false) {
        return Markup.removeKeyboard();
    }
    return Markup.keyboard([
        ['🔍 Поиск', '📺 Мои подписки'],
        ['⚙️ Настройки', 'ℹ️ Помощь']
    ]).resize();
};

const cancelMenu = Markup.keyboard([['❌ Отмена']]).resize();

/** One URL button per watch/info link: SSPoisk (when the Kinopoisk ID is known), Kinopoisk. */
const watchButtonRows = (opts) =>
    getWatchLinks(opts).map((l) => [Markup.button.url(`${l.kind === 'watch' ? '▶️' : '🎬'} ${l.label}`, l.url)]);

const getCancelMenu = (ctx) => {
    if (ctx.state && ctx.state.chatData && ctx.state.chatData.menu_enabled === false) {
        return Markup.removeKeyboard();
    }
    return cancelMenu;
};

module.exports = { mainMenu, getCancelMenu, watchButtonRows };
