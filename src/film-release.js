/**
 * When a film counts as out, the one rule for the update check, the bot's card and adding a film
 * (src/cron/films.js, src/bot/search-views.js, src/chat-ops.js). Two moments:
 *
 * - online ("Фильм вышел"): the first digital release, TMDB's anywhere or Russia's from
 *   Kinopoisk; without one, 45 days after the cinema release, when a film is usually online;
 * - the cinema premiere ("Премьера в кино"), only for chats that asked for it: the first wide
 *   cinema release anywhere, or in Russia only.
 *
 * Each needs its date to have come (a day of the chat's time zone) and TMDB's status Released: two
 * signs, as a date that was never moved or a status set by a festival screening alone each misled
 * (How to Rob a Bank, 07.11). TMDB sometimes never updates the status of a small film, so 7 days
 * after the date it counts without it. A cancelled film never comes.
 */
// Pure (no database): the message builders use it too. Days as in src/calendar.js
const { premiereMonthOnly } = require('./constants');

const DAY_MS = 86400000;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

const STATUS_GRACE_DAYS = 7;
const ONLINE_AFTER_CINEMA_DAYS = 45;
// A premiere further back than this is old news: a film added, or the setting turned on, while it
// is already in cinemas gets no premiere message. Covers the status grace above.
const PREMIERE_FRESH_DAYS = 14;

const PREMIERE_MODES = ['off', 'all', 'ru'];
// The chat setting in the bot's words (src/bot/settings.js, the change log)
const PREMIERE_LABELS = { off: 'не присылать', all: 'в любой стране', ru: 'только в России' };

const isDay = (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date);
const dayOf = (date) => (isDay(date) ? date.slice(0, 10) : null);

/** Both signs: the day has come, and TMDB says Released or has had a week to. */
function hasCome(data, date, today) {
    if (!date || date > today || data.status === 'Canceled') return false;
    return data.status === 'Released' || addDays(date, STATUS_GRACE_DAYS) <= today;
}

/** Whether TMDB lists any releases by country (not so for some old films). */
const listsReleases = (data) => Boolean(data.release_dates && (data.release_dates.results || []).length);

/**
 * When the film is online: { date, fallback }, fallback when no digital release is known and the
 * date is 45 days after the cinema (or main) release; null with no date at all.
 * @param {object} data TMDB details (src/api/tmdb.js)
 * @param {{ digital?: string | null }} [ru] Kinopoisk's Russian dates
 */
function onlineDate(data, ru = {}) {
    const digital = [dayOf(data.digital_first_date), dayOf(data.digital_release_date), dayOf(ru.digital)]
        .filter(Boolean)
        .sort()[0];
    if (digital) return { date: digital, fallback: false };
    // The wait counts from a real cinema release: wide, else limited. The main release_date only
    // when TMDB lists no releases at all (old films): it is often a festival screening, which
    // would announce a festival-only film 45 days after the festival
    const cinema =
        dayOf(data.cinema_release_date) ||
        dayOf(data.limited_release_date) ||
        (!listsReleases(data) && dayOf(data.release_date));
    return cinema ? { date: addDays(cinema, ONLINE_AFTER_CINEMA_DAYS), fallback: true } : null;
}

/**
 * Whether the film is online by `today` ("YYYY-MM-DD" in the chat's zone). Without any date and
 * any listed release TMDB's Released alone decides, as for very old films; a film with only a
 * festival screening listed waits for a real release.
 */
function isOnline(data, ru = {}, today) {
    if (data.status === 'Canceled') return false;
    const online = onlineDate(data, ru);
    if (!online) return data.status === 'Released' && !listsReleases(data);
    return hasCome(data, online.date, today);
}

/**
 * The cinema premiere to announce by `today` for a chat's mode: { date, country }, or null (mode
 * off, no such release, not yet, or long past). Russia: Kinopoisk's date when it has the day,
 * else TMDB's cinema release there.
 * @param {'off' | 'all' | 'ru'} mode
 */
function premiereDue(data, ru = {}, mode, today) {
    const premiere = premiereOf(data, ru, mode);
    if (!premiere || !hasCome(data, premiere.date, today)) return null;
    return addDays(premiere.date, PREMIERE_FRESH_DAYS) >= today ? premiere : null;
}

/** Which cinema premiere a mode is about: { date, country }, or null (off, or no such release). */
function premiereOf(data, ru = {}, mode) {
    if (mode === 'all' && dayOf(data.cinema_release_date)) {
        return { date: dayOf(data.cinema_release_date), country: data.cinema_release_country || null };
    }
    if (mode === 'ru') {
        const kp = dayOf(ru.premiere);
        const date = kp && !premiereMonthOnly(kp) ? kp : dayOf(data.cinema_ru_date);
        if (date) return { date, country: 'RU' };
    }
    return null;
}

/**
 * The dates kept on a film's Watchlist rows for the calendar and the cards (src/cron/films.js on
 * every check, src/chat-ops.js on adding): the first cinema release and Russia's, and when it is
 * online, `online_estimate` when that is the 45-day guess.
 */
function storedDates(data, ru = {}) {
    const online = onlineDate(data, ru);
    return {
        cinema_date: dayOf(data.cinema_release_date),
        cinema_country: data.cinema_release_country || null,
        cinema_ru_date: dayOf(data.cinema_ru_date),
        online_date: online ? online.date : null,
        online_estimate: Boolean(online && online.fallback)
    };
}

/**
 * A row's premiere for a mode, from its stored dates (the calendar's "In cinemas" row): null when
 * there is none, or when it falls on or after the online date — the bot then sends "Фильм вышел"
 * instead (src/cron/films.js).
 */
function rowPremiere(row, mode) {
    const premiere = premiereOf(
        {
            cinema_release_date: row.cinema_date,
            cinema_release_country: row.cinema_country,
            cinema_ru_date: row.cinema_ru_date
        },
        { premiere: row.ru_premiere },
        mode
    );
    if (!premiere || (row.online_date && premiere.date >= row.online_date)) return null;
    return premiere;
}

/** Russia's cinema date for a row: Kinopoisk's when it has the day, else TMDB's. */
function ruCinemaDate(row) {
    const kp = dayOf(row.ru_premiere);
    return (kp && !premiereMonthOnly(kp) ? kp : null) || dayOf(row.cinema_ru_date);
}

/** Where a row's online date comes from: TMDB's country, Russia (Kinopoisk), or null. */
function onlineCountry(row) {
    if (!row.online_date || row.online_estimate) return null;
    if (row.online_date === row.digital_date) return row.digital_country || null;
    return row.online_date === row.ru_digital ? 'RU' : null;
}

/**
 * Whether a cinema premiere (anywhere or in Russia) has already come by `today`: a film added
 * after it gets no premiere message — it is news only to those who were waiting, and removing and
 * adding a film again must not send it twice.
 */
function premierePassed(data, ru = {}, today) {
    const kp = dayOf(ru.premiere);
    return [dayOf(data.cinema_release_date), dayOf(data.cinema_ru_date), kp && !premiereMonthOnly(kp) ? kp : null]
        .filter(Boolean)
        .some((date) => date <= today);
}

module.exports = {
    isOnline,
    premierePassed,
    storedDates,
    rowPremiere,
    ruCinemaDate,
    onlineCountry,
    onlineDate,
    premiereDue,
    PREMIERE_MODES,
    PREMIERE_LABELS,
    STATUS_GRACE_DAYS,
    ONLINE_AFTER_CINEMA_DAYS,
    PREMIERE_FRESH_DAYS
};
