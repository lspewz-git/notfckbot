/** The notification texts the update check sends. Pure: no Telegram, database or network. */
const { isFinishedStatus, escapeHtml, formatRuDate } = require('../constants');

/**
 * The three series notifications, as sent to subscribers. Exported so the admin
 * panel's test message is the real one, not a copy that can drift.
 */
function buildSeriesMessages({ title, season, episode, episodeName, links }) {
    const t = escapeHtml(title);
    const ep = escapeHtml(episodeName || 'Без названия');
    return {
        episode: `⚡️ Новая серия! <b>${t}</b> — Сезон ${season}, Серия ${episode}: ${ep}\n\n${links}`,
        premiere: `🆕 <b>Премьера сезона!</b>\n\n📺 <b>${t}</b>\n🎞 Сезон ${season}, Серия 1: ${ep}\n\n${links}\n\n<i>(Вы также получите уведомление, когда сезон выйдет целиком)</i>`,
        complete: `✅ <b>Весь сезон вышел!</b>\n\n📺 <b>${t}</b>\n📦 Сезон ${season} полностью доступен (${episode} сер.).\n\n${links}`
    };
}

/** A show crossed the running/finished line: cancelled, finished, or renewed. */
function buildStatusMessage(title, newStatus) {
    const t = escapeHtml(title);
    return isFinishedStatus(newStatus)
        ? `${newStatus === 'Canceled' ? '⛔ <b>Сериал отменён</b>' : '🏁 <b>Сериал завершён</b>'}\n\n` +
              `📺 <b>${t}</b> — новых серий не будет.\n\n` +
              'Перенёс его в 📺 Мои подписки → 🗄 Завершённые. Если сериал продлят, я сообщу.'
        : `🎉 <b>Сериал продлили!</b>\n\n📺 <b>${t}</b> снова в активных подписках — ` +
              'уведомления о новых сериях придут как обычно.';
}

/**
 * The "film is out" message for one watchlist entry. The notification goes out on the
 * main release; the digital date is added for information, since that's when it can
 * usually be streamed.
 */
function buildFilmMessage({ entry, data, links, now = new Date() }) {
    const formattedDate = formatRuDate(data.release_date || null);
    const digital = data.digital_release_date;
    const digitalLine = digital
        ? `💻 Цифровой релиз: <b>${formatRuDate(digital)}</b>${new Date(digital) > now ? ' (ожидается)' : ''}\n`
        : '';
    const directorInfo = data.director_name ? `🎬 Режиссер: <b>${escapeHtml(data.director_name)}</b>\n` : '';
    return (
        `🎬 <b>Фильм доступен!</b>\n\n` +
        `🍿 <b>${escapeHtml(entry.title)}</b>${entry.year ? ` (${entry.year})` : ''}\n` +
        `${directorInfo}` +
        `📅 Дата релиза: <b>${formattedDate || 'уже вышел'}</b>\n` +
        digitalLine +
        '\n' +
        links
    );
}

module.exports = { buildSeriesMessages, buildStatusMessage, buildFilmMessage };
