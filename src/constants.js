/**
 * Shared constants for notification types, labels, and other enums.
 * Centralizes magic strings to avoid duplication across files.
 */
const { log } = require('./log');

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

const COUNTRY_NAMES = {
    RU: 'Россия',
    US: 'США',
    GB: 'Великобритания',
    CA: 'Канада',
    AU: 'Австралия',
    DE: 'Германия',
    FR: 'Франция',
    KR: 'Южная Корея',
    JP: 'Япония'
};

/**
 * Whether a Russian cinema premiere from Kinopoisk is only a month: Kinopoisk puts a month it
 * knows no day of on the 1st, and films open in Russian cinemas on Thursdays, so a 1st that isn't
 * a Thursday is "some time that month". 1 January stays a day: New Year premieres are real.
 */
function premiereMonthOnly(iso) {
    const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
    return !isNaN(d.getTime()) && d.getUTCDate() === 1 && d.getUTCMonth() !== 0 && d.getUTCDay() !== 4;
}

/** "16 января 2027 г.", or "февраль 2027 г." for a premiere known only to the month. */
const formatRuPremiere = (iso) =>
    premiereMonthOnly(iso)
        ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('ru-RU', {
              month: 'long',
              year: 'numeric',
              timeZone: 'UTC'
          })
        : formatRuDate(iso);

/**
 * A film's dates besides its main release, for its card and its "out" message: the premiere in
 * Russia and the digital release (TMDB's, with its country; Russia's from Kinopoisk with the
 * online cinemas, when that is another date or TMDB's is not Russia's).
 * @param {{ digital_release_date?: string | null, digital_release_country?: string | null }} data
 * @param {{ premiere?: string | null, digital?: string | null, services?: string[] }} [ru]
 * @param {{ markExpected?: Date }} [options] markExpected: "(ожидается)" on a digital date after it
 * @returns {string[]} lines with HTML, each ending in a line break
 */
function extraFilmDates(data, ru = {}, { markExpected } = {}) {
    const lines = [];
    const expected = (date) => (markExpected && new Date(date) > markExpected ? ' (ожидается)' : '');
    if (ru.premiere) lines.push(`🎟 Премьера в России: <b>${formatRuPremiere(ru.premiere)}</b>\n`);
    const tmdbDate = data.digital_release_date;
    const tmdbCountry = data.digital_release_country;
    if (tmdbDate) {
        const where = tmdbCountry ? ` (${escapeHtml(COUNTRY_NAMES[tmdbCountry] || tmdbCountry)})` : '';
        lines.push(`💻 Цифровой релиз: <b>${formatRuDate(tmdbDate)}</b>${where}${expected(tmdbDate)}\n`);
    }
    if (ru.digital && !(tmdbCountry === 'RU' && tmdbDate === ru.digital)) {
        const services = (ru.services || []).length ? ` · ${escapeHtml(ru.services.join(', '))}` : '';
        lines.push(
            `💻 Цифровой релиз в России: <b>${formatRuDate(ru.digital)}</b>${services}${expected(ru.digital)}\n`
        );
    }
    return lines;
}

/** A release date for the bot's messages, or a note that there isn't one yet. */
const formatDigitalDate = (date) => formatRuDate(date) || 'дата не объявлена';

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
    const links = [];
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

/**
 * The interval from a .env value; an unusable one is reported (unless `quiet`: the panel reads it
 * on every refresh) and the default used.
 */
function parseIntervalHours(value, { quiet = false } = {}) {
    if (value === undefined || String(value).trim() === '') return DEFAULT_INTERVAL_HOURS;
    const hours = Number(value);
    if (INTERVAL_CHOICES.includes(hours)) return hours;
    if (quiet) return DEFAULT_INTERVAL_HOURS;
    log.error(
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
    extraFilmDates,
    premiereMonthOnly,
    formatDigitalDate,
    getWatchLinks,
    formatWatchLinks
};
