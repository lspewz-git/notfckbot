/** The notification texts the update check sends. Pure: no Telegram, database or network. */
const { isFinishedStatus, escapeHtml, formatRuDate, extraFilmDates, COUNTRY_NAMES } = require('../constants');
const { onlineDate } = require('../film-release');

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
    // The title on a line of its own, as in the episode alerts: inside a sentence it got lost
    return isFinishedStatus(newStatus)
        ? `${newStatus === 'Canceled' ? '⛔ <b>Сериал отменён</b>' : '🏁 <b>Сериал завершён</b>'}\n\n` +
              `📺 <b>${t}</b>\n\n` +
              'Новых серий не будет. Перенёс его в 📺 Мои подписки → 🗄 Завершённые. Если сериал продлят, я сообщу.'
        : `🎉 <b>Сериал продлили!</b>\n\n📺 <b>${t}</b>\n\n` +
              'Он снова в активных подписках — уведомления о новых сериях придут как обычно.';
}

/** A film message's title and director lines. */
const filmHead = (entry, data) =>
    `🍿 <b>${escapeHtml(entry.title)}</b>${entry.year ? ` (${entry.year})` : ''}\n` +
    (data.director_name ? `🎬 Режиссер: <b>${escapeHtml(data.director_name)}</b>\n` : '');

const NO_DIGITAL_DATE = '💻 Даты цифрового релиза нет — обычно к этому сроку фильм уже онлайн\n';

/**
 * The "film is out" message for one watchlist entry: it goes out when the film is online
 * (src/film-release.js), with the digital releases; without one, a note that the date is a guess.
 * @param {{ entry: object, data: object, links: string, now?: Date, ru?: object }} parts
 *   ru: Kinopoisk's Russian dates (russianDates)
 */
function buildFilmMessage({ entry, data, links, now = new Date(), ru = {} }) {
    const online = onlineDate(data, ru);
    const dates = extraFilmDates(data, ru, { markExpected: now, cinema: false }).join('');
    return (
        `🎬 <b>Фильм вышел!</b>\n\n` +
        filmHead(entry, data) +
        (dates || (online && online.fallback ? NO_DIGITAL_DATE : '')) +
        '\n' +
        links
    );
}

/**
 * The cinema premiere message, for a chat with premieres on: the release it is about, with its
 * country, and the info link only — there is nothing to watch online yet.
 * @param {{ entry: object, data: object, premiere: { date: string, country: string | null },
 *   links: string }} parts links: the info links (formatWatchLinks of kind 'info')
 */
function buildPremiereMessage({ entry, data, premiere, links }) {
    const country = premiere.country ? ` (${escapeHtml(COUNTRY_NAMES[premiere.country] || premiere.country)})` : '';
    return (
        `🎞 <b>Премьера в кино!</b>\n\n` +
        filmHead(entry, data) +
        `📅 Дата релиза: <b>${formatRuDate(premiere.date)}</b>${country}\n\n` +
        'Онлайн фильма пока нет — напишу, когда выйдет.' +
        (links ? `\n\n${links}` : '')
    );
}

// --- Test notifications ---
// Every alert the bot sends, by the name the admin panel uses for it. A test message is built by
// the same function as the real one, so it shows exactly what subscribers would get.
const EPISODE_MODES = ['episode', 'first_and_full', 'season'];
// The status each status alert is about: finished, cancelled, back on air
const STATUS_MODES = { ended: 'Ended', canceled: 'Canceled', renewed: 'Returning Series' };
const TEST_MODES = [...EPISODE_MODES, ...Object.keys(STATUS_MODES), 'film'];
const TEST_PREFIX = '🧪 <b>[Тестовое уведомление]</b>\n\n';

/**
 * The real message for `mode`, marked as a test.
 * @param {string} mode one of TEST_MODES
 * @param {{ title?: string, season?: number, episode?: number, episodeName?: string, links?: string,
 *   film?: { entry: object, data: object } }} parts what that mode's message is made of
 */
function buildTestMessage(mode, { title, season, episode, episodeName, links, film }) {
    if (mode === 'film') return TEST_PREFIX + buildFilmMessage({ entry: film.entry, data: film.data, links });
    if (STATUS_MODES[mode]) return TEST_PREFIX + buildStatusMessage(title, STATUS_MODES[mode]);
    const messages = buildSeriesMessages({ title, season, episode, episodeName, links });
    const real =
        mode === 'season' ? messages.complete : mode === 'first_and_full' ? messages.premiere : messages.episode;
    return TEST_PREFIX + real;
}

/**
 * A held notification's line in the list that comes after quiet hours, and its button.
 * @param {{ kind: 'episode' | 'premiere' | 'complete' | 'status' | 'film' | 'cinema', title: string,
 *   season?: number, episode?: number, episodeName?: string, status?: string }} what
 * @returns {{ line: string, label: string }}
 */
function heldLine({ kind, title, season, episode, episodeName, status }) {
    const t = escapeHtml(title);
    const code = `S${season}E${episode}`;
    switch (kind) {
        case 'episode':
            return {
                line: `📺 <b>${t}</b> — серия ${code}${episodeName ? ` «${escapeHtml(episodeName)}»` : ''}`,
                label: `${title} ${code}`
            };
        case 'premiere':
            return { line: `📺 <b>${t}</b> — премьера ${season} сезона`, label: `${title} ${code}` };
        case 'complete':
            return { line: `📺 <b>${t}</b> — вышел весь ${season} сезон`, label: `${title}: ${season} сезон` };
        case 'status': {
            const what = !isFinishedStatus(status)
                ? 'сериал продлили'
                : status === 'Canceled'
                  ? 'сериал отменён'
                  : 'сериал завершён';
            return { line: `📺 <b>${t}</b> — ${what}`, label: title };
        }
        case 'cinema':
            return { line: `🎞 <b>${t}</b> — премьера в кино`, label: title };
        default:
            return { line: `🎬 <b>${t}</b> — фильм вышел`, label: title };
    }
}

module.exports = {
    heldLine,
    buildSeriesMessages,
    buildStatusMessage,
    buildFilmMessage,
    buildPremiereMessage,
    buildTestMessage,
    TEST_MODES,
    EPISODE_MODES,
    STATUS_MODES
};
