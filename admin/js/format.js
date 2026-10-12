/** Turning API values into the strings and badges the UI shows. */

import { escapeHtml } from './dom.js';

export function chatLabel(chat) {
    if (chat.username) return chat.username;
    return chat.type === 'private' ? 'Unknown user' : 'Unnamed group';
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

const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
// Groups and channels carry a small mark in the avatar's corner; private chats don't
const CHAT_KIND_MARK = {
    group: svg(
        '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />'
    ),
    channel: svg('<path d="m3 11 18-5v12L3 14v-3z" /><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />')
};

export function chatDisplayName(chat) {
    const kind = chat.type === 'private' ? null : chat.type === 'channel' ? 'channel' : 'group';
    const mark = kind ? `<span class="avatar-mark">${CHAT_KIND_MARK[kind]}</span>` : '';
    // Decorative: the name is right next to it and the type has its own column. The letter
    // is drawn from data-initial by CSS, so it isn't text: the table filter matches on a
    // row's text and would otherwise see "K@kent2357"
    const avatar = `<span class="avatar" style="--avatar-hue:${avatarHue(chat.id)}" data-initial="${escapeHtml(avatarInitial(chat))}" aria-hidden="true">${mark}</span>`;
    const label = escapeHtml(chatLabel(chat));
    return `<span class="chat-name${chat.username ? '' : ' chat-name-unknown'}">${avatar}<span class="chat-name-text">${label}</span></span>`;
}

// TMDB reports one of: Returning Series / In Production / Planned / Pilot /
// Ended / Canceled. There is no "paused" state in the API.
const SERIES_STATUS = {
    'Returning Series': { label: 'On Air', cls: 'ok' },
    'In Production': { label: 'In Production', cls: 'warn' },
    Planned: { label: 'Planned', cls: 'warn' },
    Pilot: { label: 'Pilot', cls: 'warn' },
    Ended: { label: 'Ended', cls: 'muted' },
    Canceled: { label: 'Canceled', cls: 'error' }
};

export function seriesStatusBadge(status) {
    if (!status) {
        return '<span class="badge muted" title="Filled in by the next update check">Unknown</span>';
    }
    const known = SERIES_STATUS[status];
    if (!known) return `<span class="badge muted">${escapeHtml(status)}</span>`;
    return `<span class="badge ${known.cls}" title="TMDB: ${escapeHtml(status)}">${known.label}</span>`;
}

/** "2026-12-15" -> "15 Dec 2026"; "TBA" while TMDB has no date. Plain text — escape it for HTML. */
export function formatReleaseDate(iso) {
    if (!iso) return 'TBA';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    // "YYYY-MM-DD" parses as UTC midnight; formatting it in local time would show the
    // day before for anyone west of UTC
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * "S2E5 · 15 Oct 2026" for the next announced episode, "S2E5 · TBA" when it has
 * no date yet, plain "TBA" when TMDB announces nothing. Plain text.
 */
export function formatNextEpisode(series) {
    if (!series) return 'TBA';
    const { next_episode_season: season, next_episode_number: episode, next_episode_date: date } = series;
    const known = (n) => n !== null && n !== undefined;
    const num = known(season) && known(episode) ? `S${season}E${episode} · ` : '';
    return num + formatReleaseDate(date);
}

export const MODE_LABELS = {
    episode: 'Every episode',
    season: 'Whole season',
    first_and_full: '1st + season'
};

export const BROADCAST_AUDIENCE_LABELS = {
    all: 'every private chat and group',
    private: 'every private chat',
    groups: 'every group and channel'
};
