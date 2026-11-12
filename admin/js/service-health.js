/**
 * What went wrong with a service, for its dialog: the problem going on now and the last few
 * that ended (`problem` / `recent` from /api/health/<name>, kept in the server's memory).
 */

import { $, escapeHtml } from './dom.js';
import { api } from './api.js';

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const clock = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** "14:17", "Yesterday 22:37", "10 Nov 22:37" — the time alone when it is today. */
export function when(ms, now = Date.now()) {
    const d = new Date(ms);
    const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / DAY);
    if (days <= 0) return clock(d);
    if (days === 1) return `Yesterday ${clock(d)}`;
    return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${clock(d)}`;
}

/** "under 1 min", "3 min", "2 h 5 min" */
export function lasted(ms) {
    const min = Math.floor(ms / MINUTE);
    if (min < 1) return 'under 1 min';
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

/** "since 22:37 · 2 checks in a row" */
export const sinceText = (problem) =>
    `since ${when(problem.since)}${problem.checks > 1 ? ` · ${problem.checks} checks in a row` : ''}`;

/** The ended problems, newest first; empty when there were none. */
export function recentHtml(recent) {
    if (!recent || !recent.length) return '';
    const rows = recent
        .map(
            (p) =>
                `<dt>${escapeHtml(when(p.since))}</dt><dd>${escapeHtml(p.reason)} · ${escapeHtml(lasted(p.until - p.since))}</dd>`
        )
        .join('');
    return `<p class="health-recent-title">Recent problems</p><dl class="kv-list health-recent">${rows}</dl>`;
}

/**
 * Asks the server to check the service now (not from its cache) and returns the answer; null when
 * the request itself failed. The caller hands it to the dashboard, so its badge and banner agree.
 * @param {string} name telegram | tmdb | kinopoisk | proxy
 */
export async function checkNow(name) {
    try {
        return await api(`/health/${name}?fresh=1`);
    } catch {
        return null;
    }
}

/** Fills a block with the recent problems, hiding it when there were none. */
export function showRecent(id, recent) {
    const el = $(id);
    el.innerHTML = recentHtml(recent);
    el.hidden = !el.innerHTML;
}
