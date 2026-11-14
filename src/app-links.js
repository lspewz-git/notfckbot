/** Notification links carry a chat choice and a title, never authorization. */
const TITLE = /^(tv|movie)_[1-9]\d{0,9}$/;

function notificationTarget(event) {
    return ['episode', 'premiere', 'complete', 'film', 'film_digital'].includes(event?.detail) &&
        TITLE.test(event?.tmdb_id || '')
        ? event.tmdb_id
        : null;
}

/**
 * The bot's Main Mini App link, or null when BotFather has none set. `start` is the startapp payload
 * (src/account/miniapp.js reads it): "c<chat id>", "c<chat id>_<title>", or none for the plain app.
 */
function appUrl(info, start = '') {
    if (!info?.has_main_web_app || !/^[A-Za-z0-9_]+$/.test(info.username || '')) return null;
    return `https://t.me/${info.username}?startapp${start ? `=${start}` : ''}`;
}

function notificationButton(bot, chatId, target) {
    if (!TITLE.test(target || '') || !/^-?\d{1,20}$/.test(String(chatId))) return {};
    const url = appUrl(bot.botInfo, `c${chatId}_${target}`);
    return url ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть WebApp', url }]] } } : {};
}

module.exports = { notificationTarget, notificationButton, appUrl };
