/**
 * A day of the dashboard's notifications chart, opened by clicking its bar (or the "Not
 * delivered" card, for today): which notifications didn't reach their chat and why, which did,
 * and, for today, what waits in the queue for the next update check (/api/stats/sends,
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

/** What a sent one was, under its title: src/models/SentNotification.js's kinds. */
const KINDS = {
    episode: 'New episode',
    premiere: 'Season premiere',
    complete: 'Season complete',
    status: 'Series status',
    film: 'Film release',
    film_digital: 'Film out digitally',
    retry: 'Resent from the queue',
    held: 'Sent after quiet hours',
    digest_w: 'Digest',
    digest_m: 'Digest'
};

/** The title with its episode: "Fallout S2E8"; a whole season, "S2". */
function sentTitle(s) {
    const title = escapeHtml(s.about || 'Notification');
    if (!s.season) return title;
    if (s.kind === 'complete') return `${title} S${s.season}`;
    return s.episode ? `${title} S${s.season}E${s.episode}` : title;
}

/** A row as in Settings → Recent alerts: the time, the dot, then what and why. */
function row(dot, time, title, meta) {
    return `<li class="sends-row"><time>${time}</time><span class="alert-dot ${dot}" aria-hidden="true"></span><span class="sends-what"><span class="sends-title">${title}</span><span class="sends-meta">${meta}</span></span></li>`;
}

const EMPTY = '<p class="alerts-empty">Everything went out.</p>';
const NONE = '<p class="alerts-empty">Nothing was sent this day.</p>';
// The sent list's stand-in rows: past this many the list grows on its answer
const MAX_SENT_SKELETON = 6;
const SKELETON_ROW =
    '<li class="sends-row"><time><span class="skeleton"></span></time><span class="alert-dot"></span><span class="sends-what"><span class="sends-title"><span class="skeleton"></span></span><span class="sends-meta"><span class="skeleton"></span><span class="skeleton"></span></span></span></li>';
// A sent one's line under its title is short: one bar, where a failure's reason takes two
const SENT_SKELETON_ROW = SKELETON_ROW.replace(
    '<span class="skeleton"></span><span class="skeleton"></span>',
    '<span class="skeleton"></span>'
);

const sentHeading = (counts) => `<h4 class="sends-group">Sent <span>${counts.sent}</span></h4>`;

/**
 * Until the answer, what it will most likely be, from the chart's counts (panel.md: nothing
 * jumps): the headings with a row of the real rows' size per notification, up to three failures
 * and six sent; a day with nothing at all says so at once.
 */
function placeholder(counts) {
    if (!counts.failed && !counts.sent) return NONE;
    let html = '';
    if (counts.failed) {
        const rows = SKELETON_ROW.repeat(Math.min(counts.failed, 3));
        html += `<h4 class="sends-group">Not delivered</h4><ul class="sends-list" aria-hidden="true">${rows}</ul>`;
    }
    if (counts.sent) {
        const rows = SENT_SKELETON_ROW.repeat(Math.min(counts.sent, MAX_SENT_SKELETON));
        html += `${sentHeading(counts)}<ul class="sends-list" aria-hidden="true">${rows}</ul>`;
    }
    return html;
}

/** Counted but not listed: from before the details were kept, or a row that couldn't be written. */
function withoutDetails(rest, noun, keptSince, day) {
    const why =
        keptSince && day > keptSince
            ? 'their details could not be kept'
            : `details are kept${keptSince ? ` since ${dayLabel(keptSince)}` : ' from now on'}`;
    return `<li class="alerts-empty">${rest} ${noun} without details: ${why}</li>`;
}

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
        if (counts.failed > listed) html += withoutDetails(counts.failed - listed, 'more', res.keptSince, res.day);
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
    const sent = res.sent || [];
    if (sent.length || counts.sent) {
        const sentListed = sent.reduce((n, s) => n + s.count, 0);
        html += `${sentHeading(counts)}<ul class="sends-list">`;
        html += sent
            .map((s) =>
                row(
                    '',
                    clock(s.at),
                    `${sentTitle(s)}${s.count > 1 && s.kind !== 'held' ? ` (${s.count})` : ''} → ${who(s)}`,
                    escapeHtml(KINDS[s.kind] || 'Notification')
                )
            )
            .join('');
        if (counts.sent > sentListed)
            html += withoutDetails(counts.sent - sentListed, 'sent', res.sentKeptSince, res.day);
        html += '</ul>';
    }
    $('sends-body').innerHTML = html || (counts.sent ? EMPTY : NONE);
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
    $('sends-body').innerHTML = placeholder(counts);
    openModal('sends-modal');
    // A past day with nothing counted has nothing more to tell; today may still have its queue
    if (!counts.failed && !counts.sent && !latest) return;
    try {
        const res = await api(`/stats/sends?day=${encodeURIComponent(day)}${latest ? '&latest=1' : ''}`);
        if (asked === day) render(res, counts);
    } catch (err) {
        if (asked === day)
            $('sends-body').innerHTML = `<p class="alerts-empty">Failed to load: ${escapeHtml(err.message)}</p>`;
    }
}
