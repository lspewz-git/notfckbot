import { locale } from './i18n.js';
import { t as i18nText } from './i18n.js';
/** Turning API values into the strings and badges the UI shows. */

import { escapeHtml } from './dom.js';

// Stored catalog genres use Russian labels; keep the source's genre membership in every view.
const GENRE_KEYS = Object.fromEntries(
    Object.entries({
        Боевик: 'Action',
        Приключения: 'Adventure',
        Аниме: 'Anime',
        Мультфильм: 'Animation',
        Комедия: 'Comedy',
        Криминал: 'Crime',
        Документальный: 'Documentary',
        Драма: 'Drama',
        Шпионский: 'Espionage',
        Семейный: 'Family',
        Фэнтези: 'Fantasy',
        История: 'History',
        Ужасы: 'Horror',
        Медицина: 'Medical',
        Музыка: 'Music',
        Детектив: 'Mystery',
        Мелодрама: 'Romance',
        Фантастика: 'Science-Fiction',
        Спорт: 'Sports',
        Сверхъестественное: 'Supernatural',
        'Телевизионный фильм': 'TV Movie',
        Триллер: 'Thriller',
        Военный: 'War',
        Вестерн: 'Western',
        'Боевик и приключения': 'Action & Adventure',
        'НФ и Фэнтези': 'Sci-Fi & Fantasy',
        Детский: 'Kids',
        Новости: 'News',
        'Реалити-шоу': 'Reality',
        'Мыльная опера': 'Soap',
        'Ток-шоу': 'Talk',
        'Война и политика': 'War & Politics'
    }).flatMap(([ru, en]) => [
        [ru.toLowerCase(), en],
        [en.toLowerCase(), en]
    ])
);
// TMDB spells this label with a space; TVmaze uses a hyphen.
GENRE_KEYS['science fiction'] = 'Science-Fiction';

/** Display only; unfamiliar provider labels stay intact. */
export function genreName(name) {
    const value = String(name || '').trim();
    const key = GENRE_KEYS[value.toLowerCase()];
    return key ? i18nText(key) : value;
}

/** A country code in the panel's language, falling back to the code itself. */
export function countryName(code) {
    try {
        return new Intl.DisplayNames([locale], { type: 'region' }).of(code) || code;
    } catch {
        return code;
    }
}

/**
 * Release countries as every card shows them: the first three names, then "+N" for the rest
 * (09.11; TMDB may list dozens). `withCount: false` leaves the count to the caller (calendar rows).
 */
export function compactCountries(codes, { withCount = true } = {}) {
    const list = (codes || []).filter(Boolean);
    const names = list.slice(0, 3).map(countryName).join(', ');
    return withCount && list.length > 3 ? `${names} +${list.length - 3}` : names;
}

export function chatLabel(chat) {
    if (chat.username) return chat.username;
    return chat.type === 'private' ? i18nText('Unknown user') : i18nText('Unnamed group');
}

// Avatar tints: hues spread round the wheel; the CSS turns each into a quiet background
// and a readable letter colour
const AVATAR_HUES = [262, 165, 22, 210, 330, 45, 125, 190];

/** The same chat always gets the same hue: a small string hash of its ID. */
function avatarHue(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return AVATAR_HUES[h % AVATAR_HUES.length];
}

/** First letter of the name, leading at sign skipped; "#" when it starts with no letter, "?" when unnamed. */
function avatarInitial(chat) {
    if (!chat.username) return '?';
    const first = Array.from(chat.username.replace(/^@/, ''))[0] || '';
    return /\p{L}/u.test(first) ? first.toUpperCase() : '#';
}

const svg = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}" /></svg>`;
// Groups and channels carry a small mark in the avatar's corner; private chats don't
const CHAT_KIND_MARK = {
    group: svg('users'),
    channel: svg('megaphone')
};

export function chatDisplayName(chat) {
    const kind = chat.type === 'private' ? null : chat.type === 'channel' ? 'channel' : 'group';
    const mark = kind ? `<span class="avatar-mark">${CHAT_KIND_MARK[kind]}</span>` : '';
    // Decorative: the name is right next to it and the type has its own column. The letter
    // is drawn from data-initial by CSS, so it isn't text: the table filter matches on a
    // row's text and would otherwise see "K@kent2357"
    const avatar = `<span class="avatar${kind ? ' avatar-group' : ''}" style="--avatar-hue:${avatarHue(chat.id)}" data-initial="${escapeHtml(avatarInitial(chat))}" aria-hidden="true">${mark}</span>`;
    const label = escapeHtml(chatLabel(chat));
    return `<span class="chat-name${chat.username ? '' : ' chat-name-unknown'}">${avatar}<span class="chat-name-text">${label}</span></span>`;
}

// Normalized catalog status; a status change alone does not confirm a renewal.
const SERIES_STATUS = {
    'Returning Series': { label: i18nText('Running'), cls: 'ok' },
    'In Production': { label: i18nText('In production'), cls: 'warn' },
    Planned: { label: i18nText('Planned'), cls: 'warn' },
    Pilot: { label: i18nText('Pilot'), cls: 'warn' },
    Ended: { label: i18nText('Ended'), cls: 'muted' },
    Canceled: { label: i18nText('Canceled'), cls: 'error' }
};

export function seriesStatusBadge(status) {
    if (!status) {
        return (
            '<span class="badge muted" title="' +
            i18nText('Filled in by the next update check') +
            '">' +
            i18nText('Unknown') +
            '</span>'
        );
    }
    const known = SERIES_STATUS[status];
    if (!known) return `<span class="badge muted">${escapeHtml(status)}</span>`;
    return (
        '<span class="badge ' +
        known.cls +
        '" title="' +
        i18nText('Catalog status: {{v1}}', { v1: escapeHtml(status) }) +
        '">' +
        known.label +
        '</span>'
    );
}

/** "2026-12-15" -> "15 Dec 2026"; "TBA" while TMDB has no date. Plain text — escape it for HTML. */
export function formatReleaseDate(iso) {
    if (!iso) return i18nText('TBA');
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    // "YYYY-MM-DD" parses as UTC midnight; formatting it in local time would show the
    // day before for anyone west of UTC
    return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Whether a Russian cinema premiere from Kinopoisk is only a month: Kinopoisk puts a month it
 * knows no day of on the 1st, and films open in Russian cinemas on Thursdays, so a 1st that isn't
 * a Thursday is "some time that month". 1 January stays a day: New Year premieres are real.
 * Same rule as premiereMonthOnly() in src/constants.js (the bot's).
 */
function premiereMonthOnly(iso) {
    const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
    return !isNaN(d.getTime()) && d.getUTCDate() === 1 && d.getUTCMonth() !== 0 && d.getUTCDay() !== 4;
}

/** "16 Jan 2027", or "Feb 2027" for a premiere known only to the month. */
export function formatPremiereRu(iso) {
    return premiereMonthOnly(iso)
        ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString(locale, {
              month: 'short',
              year: 'numeric',
              timeZone: 'UTC'
          })
        : formatReleaseDate(iso);
}

/** "16 Jan", with the year when it isn't `sameYearAs`'s ("16 Jan 2028"). */
function shortDate(iso, sameYearAs) {
    const full = formatReleaseDate(iso);
    return sameYearAs && String(iso).slice(0, 4) === String(sameYearAs).slice(0, 4)
        ? full.replace(/ \d{4}$/, '')
        : full;
}

/**
 * A film's dates besides its main release, for the Movies table: "Russia: cinema 16 Jan · digital
 * 27 Feb, Okko" (from Kinopoisk) and "Digital 6 Feb (US)" (TMDB's, unless it is that same
 * Russian date). Plain text; empty when nothing is known.
 * @param {{ premiere_digital?: string | null, digital_date?: string | null, digital_country?: string | null,
 *   ru_premiere?: string | null, ru_digital?: string | null, ru_services?: string | null }} film
 * @returns {string[]}
 */
export function releaseExtras(film) {
    const main = film.premiere_digital;
    const lines = [];
    const russia = [];
    if (film.ru_premiere) {
        // A month alone keeps its year: "cinema Feb 2027"
        russia.push(
            i18nText('cinema {{v0}}', {
                v0: premiereMonthOnly(film.ru_premiere)
                    ? formatPremiereRu(film.ru_premiere)
                    : shortDate(film.ru_premiere, main)
            })
        );
    }
    if (film.ru_digital)
        russia.push(
            i18nText('digital {{v0}}{{v1}}', {
                v0: shortDate(film.ru_digital, main),
                v1: film.ru_services ? `, ${film.ru_services}` : ''
            })
        );
    if (russia.length) lines.push(i18nText('Russia: {{v0}}', { v0: russia.join(' · ') }));
    const sameAsRussia = film.digital_country === 'RU' && film.digital_date === film.ru_digital;
    if (film.digital_date && !sameAsRussia) {
        lines.push(
            i18nText('Digital {{v0}}{{v1}}', {
                v0: shortDate(film.digital_date, main),
                v1: film.digital_country ? ` (${film.digital_country})` : ''
            })
        );
    }
    return lines;
}

/**
 * "S2E5 · 15 Oct 2026" for the next announced episode, "S2E5 · TBA" when it has
 * no date yet, plain "TBA" when TMDB announces nothing. Plain text.
 */
export function formatNextEpisode(series) {
    if (!series) return i18nText('TBA');
    const { next_episode_season: season, next_episode_number: episode, next_episode_date: date } = series;
    const known = (n) => n !== null && n !== undefined;
    const num = known(season) && known(episode) ? `S${season}E${episode} · ` : '';
    return num + formatReleaseDate(date);
}

export const MODE_LABELS = {
    episode: i18nText('Every episode'),
    season: i18nText('Whole season'),
    first_and_full: i18nText('1st + season')
};

export const BROADCAST_AUDIENCE_LABELS = {
    all: i18nText('every private chat and group'),
    private: i18nText('every private chat'),
    groups: i18nText('every group and channel')
};

/** "12 Oct", with the year when it isn't this one; in the viewer's time. Plain text. */
export function shortDay(iso, now = new Date()) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const year = d.getFullYear() === now.getFullYear() ? undefined : 'numeric';
    return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year });
}

/** When a chat last used the bot: "Just now", "5 min ago", "2 h ago", "Yesterday", "9 Oct"; "-" if never seen. */
export function lastSeenText(iso, now = new Date()) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return '-';
    const minutes = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60000));
    if (minutes < 1) return i18nText('Just now');
    if (minutes < 60) return i18nText('{{v0}} min ago', { v0: minutes });
    if (minutes < 24 * 60) return i18nText('{{v0}} h ago', { v0: Math.floor(minutes / 60) });
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return d.toDateString() === yesterday.toDateString() ? i18nText('Yesterday') : shortDay(iso, now);
}

/** "active 2 h ago", "active yesterday" for a line after a chat's name; empty if never seen. */
export function activeLine(iso, now = new Date()) {
    const seen = lastSeenText(iso, now);
    return seen === '-' ? '' : i18nText('active {{v0}}', { v0: seenInLine(iso, now) });
}

/** The statuses of a chat the bot can't reach (src/bot-status.js); the panel's block is separate. */
const LEFT_LABELS = {
    stopped: () => i18nText('Stopped the bot'),
    removed: () => i18nText('Removed from group'),
    deleted: (chat) => (chat.type === 'private' ? i18nText('Account deleted') : i18nText('Chat deleted'))
};

/** Whether the bot has lost the chat: blocked by the user, removed from the group, deleted. */
export const botLeft = (chat) => Boolean(LEFT_LABELS[chat.bot_status]);

/** How the bot lost the chat ("Stopped the bot"), or '' when it hasn't. */
export const leftLabel = (chat) => (botLeft(chat) ? LEFT_LABELS[chat.bot_status](chat) : '');

/** "2 h ago", "yesterday", "9 Oct": lastSeenText for the middle of a line. */
export const seenInLine = (iso, now = new Date()) =>
    lastSeenText(iso, now).replace(/^(Yesterday|Just now)$/, (w) => w.toLowerCase());

/**
 * A chat's status badge and the quiet line under it: lost to the bot (and since when, by whom),
 * blocked in the panel (until when), or active (and back since when, if it had left).
 * @returns {{ badge: string, note: string }} badge: HTML; note: plain text, escape it for HTML
 */
export function chatStatus(chat, now = new Date()) {
    const since = chat.bot_status_at ? shortDay(chat.bot_status_at, now) : '';
    if (botLeft(chat)) {
        const by = chat.bot_status_by ? i18nText('by {{v0}}', { v0: chat.bot_status_by }) : '';
        const note = by ? [by, since].filter(Boolean).join(' · ') : since && i18nText('since {{v0}}', { v0: since });
        return {
            badge: `<span class="badge warn">${LEFT_LABELS[chat.bot_status](chat)}</span>`,
            note
        };
    }
    const until = chat.blockedUntil ? new Date(chat.blockedUntil) : null;
    if (until && until > now) {
        const when = until.toLocaleString(locale, {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit'
        });
        return {
            badge: '<span class="badge error">' + i18nText('Blocked') + '</span>',
            note: i18nText('until {{v0}}', { v0: when })
        };
    }
    return {
        badge: '<span class="badge ok">' + i18nText('Active') + '</span>',
        note: since ? i18nText('came back {{v0}}', { v0: since }) : ''
    };
}
