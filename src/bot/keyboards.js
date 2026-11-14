/** Reply keyboards and link buttons shared by the handlers. */
const { Markup } = require('telegraf');
const { getWatchLinks } = require('../constants');

/**
 * The reply-keyboard labels: the handlers match these texts, the search skips them, the statistics
 * count them. oldHelp and random are on keyboards some chats still have.
 */
const MENU = {
    search: '🔍 Поиск',
    subs: '📺 Мои подписки',
    settings: '⚙️ Настройки',
    help: 'ℹ️ Помощь',
    oldHelp: '❓ Помощь',
    random: '🎲 Случайный фильм',
    cancel: '❌ Отмена'
};

const menuOff = (ctx) => ctx.state?.chatData?.menu_enabled === false;

const mainMenu = (ctx) =>
    menuOff(ctx)
        ? Markup.removeKeyboard()
        : Markup.keyboard([
              [MENU.search, MENU.subs],
              [MENU.settings, MENU.help]
          ]).resize();

const cancelMenu = Markup.keyboard([[MENU.cancel]]).resize();

const getCancelMenu = (ctx) => (menuOff(ctx) ? Markup.removeKeyboard() : cancelMenu);

/** One URL button per watch/info link: SSPoisk (when the Kinopoisk ID is known), Kinopoisk. */
const watchButtonRows = ({ watch = true, ...opts }) =>
    getWatchLinks(opts)
        .filter((link) => watch || link.kind !== 'watch')
        .map((l) => [Markup.button.url(`${l.kind === 'watch' ? '▶️' : '🎬'} ${l.label}`, l.url)]);

module.exports = { MENU, mainMenu, getCancelMenu, watchButtonRows };
