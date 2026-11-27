import { locale } from './i18n.js';
import { t as i18nText } from './i18n.js';
/**
 * Year recap → Schedule: the day and the hour the recap goes out by itself, in each chat's own
 * time zone, the switch (it asks before turning on) and who it would go to. The day and the hour
 * are saved as soon as they are picked; they can't change while it is on.
 * Server: src/admin/routes/recap-schedule.js.
 */

import { $, escapeHtml } from './dom.js';
import { api } from './api.js';
import { showConfirm, toast } from './ui.js';
import { setSelectValue } from './select.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// Only the latest answer may fill the tab
let request = 0;
/** @type {any} */
let state = null;
export const scheduleYear = () => (busy ? null : (state?.year ?? null));
let busy = false;
// Filling the fields fires their change events: those are not picks
let rendering = false;

function syncManualSend() {
    if ($('recap-sched-pane').hidden) return;
    const button = document.querySelector('#recap-section [data-action="recap-send-open"]');
    if (button) /** @type {HTMLButtonElement} */ (button).disabled = scheduleYear() === null;
}

const chats = (count) => i18nText('{{count}} chat', { count });
const dayLabel = (day, withYear = true) =>
    new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, {
        day: 'numeric',
        month: withYear ? 'long' : 'short',
        ...(withYear ? { year: 'numeric' } : {}),
        timeZone: 'UTC'
    });
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;
/** A moment in Moscow time, "03:00 MSK on 28 Dec". */
const moscow = (iso) => {
    const d = new Date(iso);
    const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    const day = d.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'Europe/Moscow' });
    return i18nText('{{v0}} MSK on {{v1}}', { v0: time, v1: day });
};
/** "65 days", "20 hours", "40 minutes" until a moment. */
function until(iso, now = Date.now()) {
    const ms = new Date(iso).getTime() - now;
    const [count, unit] =
        ms >= 2 * DAY_MS
            ? [Math.floor(ms / DAY_MS), 'day']
            : ms >= 2 * HOUR_MS
              ? [Math.floor(ms / HOUR_MS), 'hour']
              : [Math.max(1, Math.ceil(ms / MINUTE_MS)), 'minute'];
    return [count, i18nText(unit, { count })];
}

/** The line at the top: off, on and waiting, sending, sent. */
function stateHtml(s) {
    const day = s.day || s.suggested.day;
    const hour = s.hour === null ? s.suggested.hour : s.hour;
    const summary = escapeHtml(
        s.year +
            (' ' + i18nText('recap ·') + ' ') +
            dayLabel(day, false) +
            ' · ' +
            hourLabel(hour) +
            i18nText(', each chat’s time')
    );
    if (!s.on && s.done) {
        const p = s.progress;
        const note = i18nText('{{v0}} got it{{v1}}{{v2}}. Pick a new day to send again.', {
            v0: chats(p.sent),
            v1: p.queued + p.sending ? i18nText(', {{v0}} still in the queue', { v0: p.queued + p.sending }) : '',
            v2: p.failed ? i18nText(', {{v0}} failed', { v0: p.failed }) : ''
        });
        return (
            '<div class="recap-sched-state"><i class="recap-sched-dot" aria-hidden="true"></i><div class="recap-sched-grow"><b>' +
            i18nText('Schedule finished · {{v0}}', { v0: summary }) +
            '</b><span>' +
            escapeHtml(note) +
            '</span></div></div>'
        );
    }
    if (!s.on) {
        // Turned off during the sending: what is queued still goes, only Stop takes it off
        const waiting = s.progress.queued + s.progress.sending;
        // Off between the first and the last zone's hour: the rest won't get it by date
        const now = Date.now();
        const midway = s.firstAt && new Date(s.firstAt).getTime() <= now && now < new Date(s.lastAt).getTime();
        const note = [
            waiting
                ? i18nText('{{v0}} already queued still go out; Stop in Send now takes them off.', {
                      v0: chats(waiting)
                  })
                : '',
            midway ? i18nText("Chats whose hour hasn't come won't get it by date: send them by hand.") : '',
            !waiting && !midway ? i18nText('Schedule is off. Send now is available separately.') : ''
        ]
            .filter(Boolean)
            .join(' ');
        return `<div class="recap-sched-state"><i class="recap-sched-dot" aria-hidden="true"></i><div class="recap-sched-grow"><b>${summary}</b><span>${escapeHtml(note)}</span></div></div>`;
    }
    const title = i18nText('Scheduled · {{v0}}', { v0: summary });
    if (s.firstAt && Date.now() < new Date(s.firstAt).getTime()) {
        const [n, unit] = until(s.firstAt);
        const east =
            s.firstAt !== s.lastAt
                ? i18nText('Chats further east get it earlier: the first at {{v0}}.', { v0: moscow(s.firstAt) }) + ' '
                : '';
        return (
            '<div class="recap-sched-state armed"><i class="recap-sched-dot" aria-hidden="true"></i><div class="recap-sched-grow"><b>' +
            title +
            '</b><span>' +
            i18nText('{{v1}}Turn it off to change the day.', { v1: escapeHtml(east) }) +
            '</span></div><div class="recap-sched-count"><b>' +
            n +
            '</b><span>' +
            i18nText('{{v3}} until the first chat', { v3: unit }) +
            '</span></div></div>'
        );
    }
    const p = s.progress;
    const waiting = p.queued + p.sending;
    const note = waiting
        ? i18nText('Sending: {{v0}} of {{v1}} sent{{v2}}{{v3}}', {
              v0: p.sent,
              v1: p.total,
              v2: p.quiet ? ' ' + i18nText('· {{v0}} waiting for quiet hours to end', { v0: p.quiet }) : '',
              v3: p.failed ? ' ' + i18nText('· {{v0}} failed', { v0: p.failed }) : ''
          })
        : i18nText("Sent: {{v0}}{{v1}}. Chats whose hour hasn't come yet follow.", {
              v0: chats(p.sent),
              v1: p.failed ? ' ' + i18nText('· {{v0}} failed', { v0: p.failed }) : ''
          });
    return `<div class="recap-sched-state armed"><i class="recap-sched-dot" aria-hidden="true"></i><div class="recap-sched-grow"><b>${title}</b><span>${escapeHtml(note)}</span></div></div>`;
}

/** The day and the hour locked (while it is on, or when nothing could be loaded). */
function lockFields(locked) {
    for (const id of ['recap-sched-day', 'recap-sched-hour']) {
        const el = /** @type {HTMLSelectElement} */ ($(id));
        el.disabled = locked;
        // The styled trigger beside it follows
        const trigger = el.parentElement.querySelector('.custom-select-trigger');
        if (trigger) /** @type {HTMLButtonElement} */ (trigger).disabled = locked;
    }
}

function render(s) {
    rendering = true;
    try {
        fill(s);
    } finally {
        rendering = false;
    }
}

function fill(s) {
    state = s;
    $('recap-sched-state').innerHTML = stateHtml(s);
    const days = /** @type {HTMLSelectElement} */ ($('recap-sched-day'));
    const choices = s.days.join(',');
    if (days.dataset.choices !== choices) {
        days.innerHTML = s.days
            .map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(dayLabel(d))}</option>`)
            .join('');
        days.dataset.choices = choices;
    }
    const hours = /** @type {HTMLSelectElement} */ ($('recap-sched-hour'));
    if (!hours.options.length) {
        hours.innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${hourLabel(h)}</option>`).join(
            ''
        );
    }
    const day = s.day || s.suggested.day;
    const hour = s.hour === null ? s.suggested.hour : s.hour;
    setSelectValue('recap-sched-day', day);
    setSelectValue('recap-sched-hour', String(hour));
    lockFields(s.on);
    $('recap-sched-year').innerHTML =
        i18nText('Sends the') +
        ' ' +
        '<b>' +
        s.year +
        '</b>' +
        ' ' +
        i18nText("recap, at {{v1}} in each chat's time zone.", { v1: hourLabel(hour) });
    const sw = /** @type {HTMLButtonElement} */ ($('recap-sched-switch'));
    sw.disabled = false;
    sw.setAttribute('aria-checked', String(s.on));
    $('recap-sched-switch-note').textContent = s.on ? i18nText('On') : i18nText('Asks before turning on');
    const a = s.audience;
    const row = (label, n) => `<li><span>${label}</span><em>${n}</em></li>`;
    $('recap-sched-who').innerHTML =
        row(i18nText('Will get it'), chats(a.eligible)) +
        row(i18nText('Already got it or queued'), a.sent + a.queued) +
        (a.failed ? row(i18nText('Failed earlier (send by hand)'), a.failed) : '') +
        row(i18nText('Nothing to show for the year'), a.nothing) +
        row(i18nText('Blocked in the panel'), a.blocked) +
        (a.left ? row(i18nText('Left the bot'), a.left) : '');
    $('recap-sched-pane').setAttribute('aria-busy', 'false');
    syncManualSend();
}

/** Opening the tab. */
export async function loadSchedule() {
    const asked = ++request;
    state = null;
    syncManualSend();
    lockFields(true);
    /** @type {HTMLButtonElement} */ ($('recap-sched-switch')).disabled = true;
    $('recap-sched-pane').setAttribute('aria-busy', 'true');
    try {
        const answer = await api('/recap/schedule');
        if (asked === request) render(answer);
    } catch (err) {
        if (asked !== request) return;
        // A dead end, not a form that looks usable: nothing to pick, nothing to switch
        state = null;
        $('recap-sched-state').innerHTML =
            '<p class="stats-failed">' + i18nText('Failed to load: {{v0}}', { v0: escapeHtml(err.message) }) + '</p>';
        $('recap-sched-year').textContent = '-';
        $('recap-sched-who').innerHTML = '<li><span>' + i18nText('Failed to load') + '</span><em>-</em></li>';
        /** @type {HTMLButtonElement} */ ($('recap-sched-switch')).disabled = true;
        lockFields(true);
        $('recap-sched-pane').setAttribute('aria-busy', 'false');
    }
}

async function save(body, done) {
    if (busy) return;
    busy = true;
    syncManualSend();
    const sw = $('recap-sched-switch');
    sw.setAttribute('aria-busy', 'true');
    ++request;
    try {
        render(await api('/recap/schedule', { method: 'PUT', body }));
        if (done) toast(done, 'success');
    } catch (err) {
        toast(err.message, 'error');
        // The fields go back to what is saved: asked again, as the save may have gone through
        // with only the answer failing
        loadSchedule();
    } finally {
        busy = false;
        syncManualSend();
        sw.removeAttribute('aria-busy');
    }
}

const picked = () => ({
    day: /** @type {HTMLSelectElement} */ ($('recap-sched-day')).value,
    hour: Number(/** @type {HTMLSelectElement} */ ($('recap-sched-hour')).value)
});

/** A day or an hour picked: saved at once (only while off; the fields are locked while on). */
function pickTime() {
    if (rendering || !state || state.on) return;
    const { day, hour } = picked();
    if (day === state.day && hour === state.hour) return;
    save({ on: false, day, hour });
}

function toggle() {
    if (!state || busy) return;
    const { day, hour } = picked();
    if (state.on) {
        save({ on: false, day: state.day, hour: state.hour }, i18nText('Scheduled sending is off'));
        return;
    }
    showConfirm({
        title: i18nText('Send the {{v0}} recap on {{v1}}?', { v0: state.year, v1: dayLabel(day, false) }),
        text: i18nText(
            "At {{v0}} in each chat's time zone, {{v1}} will get the six cards, each once. Nothing goes out before that hour; you can turn it off until then.",
            { v0: hourLabel(hour), v1: chats(state.audience.eligible) }
        ),
        confirmLabel: i18nText('Turn on'),
        cancelLabel: i18nText('Cancel'),
        onConfirm: () =>
            save(
                { on: true, day, hour },
                i18nText('The {{v0}} recap goes out on {{v1}}', { v0: state.year, v1: dayLabel(day, false) })
            )
    });
}

export const recapScheduleActions = {
    'recap-sched-toggle': () => toggle()
};

export function setupRecapSchedule() {
    $('recap-sched-day').addEventListener('change', () => pickTime());
    $('recap-sched-hour').addEventListener('change', () => pickTime());
}
