/**
 * A day of the dashboard's notifications chart, opened by clicking its bar (or the "Not
 * delivered" card, for today): which notifications didn't reach their chat and why, and, for
 * today, what waits in the queue for the next update check (/api/stats/sends,
 * src/admin/routes/stats.js).
 */

import { $, escapeHtml } from './dom.js';
import { api } from './api.js';
import { openModal } from './ui.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (day) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const when = (iso) => {
    const d = new Date(iso);
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock(iso)}`;
};

// The day asked for last: an answer for an earlier click arriving late is dropped
let asked = null;

/** Why it didn't go, in words. */
function outcome(f) {
    if (f.status === 'gave_up') {
        const since = f.since ? ` since ${when(f.since)}` : '';
        return `Gave up after ${f.tries} ${f.tries === 1 ? 'try' : 'tries'}${since}`;
    }
    if (f.status === 'too_old') return 'Dropped: waited in the queue for two days';
    if (f.status === 'gone') return 'The chat blocked or removed the bot';
    if (f.status === 'rejected') return 'Telegram refused it';
    if (f.status === 'not_queued') return "Couldn't be kept for a retry";
    return f.status;
}

const who = (r) => escapeHtml(r.chat || r.chatId);

/** A row as in Settings → Recent alerts: the time, the dot, then what and why. */
function row(dot, time, title, meta) {
    return `<li class="sends-row"><time>${time}</time><span class="alert-dot ${dot}" aria-hidden="true"></span><span class="sends-what"><span class="sends-title">${title}</span><span class="sends-meta">${meta}</span></span></li>`;
}

/** Rows of the real rows' size until the answer (panel.md: nothing jumps). */
const SKELETON = `<ul class="sends-list" aria-hidden="true">${'<li class="sends-row"><time><span class="skeleton"></span></time><span class="alert-dot"></span><span class="sends-what"><span class="sends-title"><span class="skeleton"></span></span><span class="sends-meta"><span class="skeleton"></span></span></span></li>'.repeat(2)}</ul>`;

function subtitle(counts, queued = 0) {
    const parts = [`Sent ${counts.sent}`, `Not delivered ${counts.failed}`];
    if (queued) parts.push(`Waiting to resend ${queued}`);
    return parts.join(' · ');
}

function render(res, counts) {
    const listed = res.failed.reduce((n, f) => n + f.count, 0);
    $('sends-sub').textContent = subtitle(counts, res.queued.length);

    let html = '';
    if (res.failed.length || counts.failed) {
        html += '<h4 class="sends-group">Not delivered</h4><ul class="sends-list">';
        html += res.failed
            .map((f) =>
                row(
                    'is-bad',
                    clock(f.at),
                    `${escapeHtml(f.about || 'Notification')}${f.count > 1 ? ` (${f.count})` : ''} → ${who(f)}`,
                    escapeHtml([outcome(f), f.error].filter(Boolean).join(' · '))
                )
            )
            .join('');
        // Counted but not listed: from before the details were kept (the first kept day may be
        // part counted before), or, after it, a row that couldn't be written
        if (counts.failed > listed) {
            const rest = counts.failed - listed;
            const why =
                res.keptSince && res.day > res.keptSince
                    ? 'their details could not be kept'
                    : `details are kept${res.keptSince ? ` since ${dayLabel(res.keptSince)}` : ' from now on'}`;
            html += `<li class="alerts-empty">${rest} more without details: ${why}</li>`;
        }
        html += '</ul>';
    }
    if (res.queued.length) {
        const next = res.nextCheckAt ? `at the next check, ${clock(res.nextCheckAt)}` : 'at the next check';
        html += `<h4 class="sends-group">Waiting to resend <span>${next}</span></h4><ul class="sends-list">`;
        html += res.queued
            .map((q) =>
                row(
                    'is-warn',
                    clock(q.since),
                    `${escapeHtml(q.about || 'Notification')} → ${who(q)}`,
                    escapeHtml([`Try ${q.tries + 1} of ${q.maxTries}`, q.error].filter(Boolean).join(' · '))
                )
            )
            .join('');
        html += '</ul>';
    }
    $('sends-body').innerHTML = html || '<p class="alerts-empty">Everything went out.</p>';
}

/**
 * Opens a day's details.
 * @param {string} day "YYYY-MM-DD"
 * @param {{ sent: number, failed: number }} counts the chart's bars for the day
 * @param {{ latest?: boolean }} [options] latest: the chart's last day, which shows the queue
 */
export async function openSends(day, counts, { latest = false } = {}) {
    asked = day;
    $('sends-title').textContent = dayLabel(day);
    $('sends-sub').textContent = subtitle(counts);
    $('sends-body').innerHTML = SKELETON;
    openModal('sends-modal');
    try {
        const res = await api(`/stats/sends?day=${encodeURIComponent(day)}${latest ? '&latest=1' : ''}`);
        if (asked === day) render(res, counts);
    } catch (err) {
        if (asked === day)
            $('sends-body').innerHTML = `<p class="alerts-empty">Failed to load: ${escapeHtml(err.message)}</p>`;
    }
}
