/**
 * Shared constants for notification types, labels, and other enums.
 * Centralizes magic strings to avoid duplication across files.
 */

/** Human-readable labels for subscription notification types */
const NOTIFY_LABELS = {
    episode: '🔔 Каждая серия',
    season: '📦 Весь сезон',
    first_and_full: '🆕 1-я серия + Сезон',
};

/** Human-readable labels for subscription confirmation messages */
const NOTIFY_LABELS_SHORT = {
    episode: 'каждую серию',
    season: 'выход всего сезона',
    first_and_full: '1-я серия + весь сезон',
};

/** Cycle order for toggling notify modes */
const NOTIFY_CYCLE = {
    episode: 'season',
    season: 'first_and_full',
    first_and_full: 'episode',
};

const getWatchLink = (title) => {
    // HDRezka search URL:
    return `https://rezka.ag/search/?do=search&subaction=search&q=${encodeURIComponent(title)}`;
};

module.exports = { NOTIFY_LABELS, NOTIFY_LABELS_SHORT, NOTIFY_CYCLE, getWatchLink };
