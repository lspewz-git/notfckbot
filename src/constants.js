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

/** Cycle order for toggling notify modes */
const NOTIFY_CYCLE = {
    episode: 'season',
    season: 'first_and_full',
    first_and_full: 'episode'
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

const getWatchLink = (title) => {
    // HDRezka search URL:
    return `https://rezka.ag/search/?do=search&subaction=search&q=${encodeURIComponent(title)}`;
};

module.exports = {
    NOTIFY_LABELS,
    NOTIFY_LABELS_SHORT,
    NOTIFY_CYCLE,
    FINISHED_STATUS_LABELS,
    isFinishedStatus,
    escapeHtml,
    formatRuDate,
    getWatchLink
};
