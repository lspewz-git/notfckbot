/**
 * Shared constants for notification types, labels, and other enums.
 * Centralizes magic strings to avoid duplication across files.
 */

/** Human-readable labels for subscription notification types */
const NOTIFY_LABELS = {
    episode: '🔔 Каждая серия',
    season: '📦 Весь сезон',
    first_and_full: '🆕 1-я серия + Сезон'
};

/** Human-readable labels for subscription confirmation messages */
const NOTIFY_LABELS_SHORT = {
    episode: 'каждую серию',
    season: 'выход всего сезона',
    first_and_full: '1-я серия + весь сезон'
};

/** TMDB series statuses after which no new episodes are expected, with their labels */
const FINISHED_STATUS_LABELS = {
    Ended: '🏁 Завершён',
    Canceled: '⛔ Отменён'
};

const isFinishedStatus = (status) => Object.hasOwn(FINISHED_STATUS_LABELS, status ?? '');

const escapeHtml = (s) =>
    String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

/** "1 декабря 2026 г." — or null for a missing or unparseable date */
const formatRuDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
};

/** A release date for the bot's messages, or a note that there isn't one yet. */
const formatDigitalDate = (date) => formatRuDate(date) || 'дата не объявлена';

const getWatchLink = (title) => {
    // HDRezka search URL:
    return `https://rezka.ag/search/?do=search&subaction=search&q=${encodeURIComponent(title)}`;
};

/**
 * Where to watch or read about a title. With a Kinopoisk ID the Kinopoisk and
 * SSPoisk links point straight at the title (SSPoisk mirrors Kinopoisk's URLs);
 * without one, Kinopoisk falls back to a search and SSPoisk is left out, as it
 * has no search.
 *
 * @param {{ title: string, kinopoiskId?: number | null, mediaType?: 'tv' | 'movie' }} opts
 * @returns {{ label: string, url: string, kind: 'watch' | 'info' }[]}
 */
const getWatchLinks = ({ title, kinopoiskId, mediaType }) => {
    const links = [{ label: 'Смотреть на HDRezka', url: getWatchLink(title), kind: 'watch' }];
    if (kinopoiskId) {
        const path = `${mediaType === 'tv' ? 'series' : 'film'}/${kinopoiskId}/`;
        links.push({ label: 'Смотреть на SSPoisk', url: `https://www.sspoisk.ru/${path}`, kind: 'watch' });
        links.push({ label: 'Страница на Кинопоиске', url: `https://www.kinopoisk.ru/${path}`, kind: 'info' });
    } else {
        const q = encodeURIComponent(title);
        links.push({
            label: 'Страница на Кинопоиске',
            url: `https://www.kinopoisk.ru/index.php?kp_query=${q}`,
            kind: 'info'
        });
    }
    return links;
};

/** The links as an HTML block for a notification: watch links, a blank line, the info link. */
const formatWatchLinks = (opts) => {
    const links = getWatchLinks(opts);
    // & must be an entity even inside href for Telegram's HTML parser
    const line = (l) => `${l.kind === 'watch' ? '▶️' : '🎬'} <a href="${l.url.replace(/&/g, '&amp;')}">${l.label}</a>`;
    const watch = links.filter((l) => l.kind === 'watch').map(line);
    const info = links.filter((l) => l.kind === 'info').map(line);
    return [watch.join('\n'), info.join('\n')].filter(Boolean).join('\n\n');
};

// How often the update check asks TMDB for new episodes and releases: UPDATE_INTERVAL_HOURS in
// .env, 3 by default. Only a divisor of 24: the schedule ("0 */N * * *") starts again at
// midnight, so with 5 the checks would run at 0, 5, 10, 15, 20 and then 0 again, 4 hours later.
const DEFAULT_INTERVAL_HOURS = 3;
const INTERVAL_CHOICES = [1, 2, 3, 4, 6, 8, 12, 24];

/** The interval from a .env value; an unusable one is reported and the default used. */
function parseIntervalHours(value) {
    if (value === undefined || String(value).trim() === '') return DEFAULT_INTERVAL_HOURS;
    const hours = Number(value);
    if (INTERVAL_CHOICES.includes(hours)) return hours;
    console.error(
        `[Cron] UPDATE_INTERVAL_HOURS=${value} is not one of ${INTERVAL_CHOICES.join(', ')}; ` +
            `checking every ${DEFAULT_INTERVAL_HOURS} hours`
    );
    return DEFAULT_INTERVAL_HOURS;
}

// Read once, at start: src/index.js loads .env before anything requires this file
const UPDATE_INTERVAL_HOURS = parseIntervalHours(process.env.UPDATE_INTERVAL_HOURS);

module.exports = {
    UPDATE_INTERVAL_HOURS,
    parseIntervalHours,
    INTERVAL_CHOICES,
    NOTIFY_LABELS,
    NOTIFY_LABELS_SHORT,
    FINISHED_STATUS_LABELS,
    isFinishedStatus,
    escapeHtml,
    formatRuDate,
    formatDigitalDate,
    getWatchLink,
    getWatchLinks,
    formatWatchLinks
};
