/** Notification links carry a chat choice and a title, never authorization. */
const TITLE = /^(tv|movie)_[1-9]\d{0,9}$/;

function notificationTarget(event) {
    return ['episode', 'premiere', 'complete', 'film', 'film_digital'].includes(event?.detail) &&
        TITLE.test(event?.tmdb_id || '')
        ? event.tmdb_id
        : null;
}

function notificationButton(bot, chatId, target) {
    const info = bot.botInfo;
    if (!info?.has_main_web_app || !/^[A-Za-z0-9_]+$/.test(info.username || '') || !TITLE.test(target || '')) return {};
    if (!/^-?\d{1,20}$/.test(String(chatId))) return {};
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Открыть WebApp', url: `https://t.me/${info.username}?startapp=c${chatId}_${target}` }]
            ]
        }
    };
}

module.exports = { notificationTarget, notificationButton };
