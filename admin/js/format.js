/** Turning API values into the strings and badges the UI shows. */

import { escapeHtml } from './dom.js';

export function chatLabel(chat) {
    if (chat.username) return chat.username;
    return chat.type === 'private' ? 'Unknown user' : 'Unnamed group';
}

export function chatDisplayName(chat) {
    const icon = chat.type === 'private' ? '👤' : chat.type === 'channel' ? '📣' : '👥';
    const label = escapeHtml(chatLabel(chat));
    const dim = chat.username ? '' : ' style="color:var(--text-dim); font-style:italic"';
    return `<span${dim}>${icon} ${label}</span>`;
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
