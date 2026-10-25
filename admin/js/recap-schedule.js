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
let busy = false;
// Filling the fields fires their change events: those are not picks
let rendering = false;

const chats = (n) => `${n} ${n === 1 ? 'chat' : 'chats'}`;
const dayLabel = (day, withYear = true) =>
    new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: withYear ? 'long' : 'short',
        ...(withYear ? { year: 'numeric' } : {}),
        timeZone: 'UTC'
    });
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;
/** A moment in Moscow time, "03:00 MSK on 28 Dec". */
const moscow = (iso) => {
    const d = new Date(iso);
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Moscow' });
    return `${time} MSK on ${day}`;
};
/** "65 days", "20 hours", "40 minutes" until a moment. */
function until(iso, now = Date.now()) {
    const ms = new Date(iso).getTime() - now;
    if (ms >= 2 * DAY_MS) return [Math.floor(ms / DAY_MS), 'days'];
    if (ms >= 2 * HOUR_MS) return [Math.floor(ms / HOUR_MS), 'hours'];
    return [Math.max(1, Math.ceil(ms / MINUTE_MS)), 'minutes'];
}

/** The line at the top: off, on and waiting, sending, sent. */
function stateHtml(s) {
    if (!s.on && s.done) {
        const p = s.progress;
        const note = `${chats(p.sent)} got it${p.queued + p.sending ? `, ${p.queued + p.sending} still in the queue` : ''}${p.failed ? `, ${p.failed} failed` : ''}. Pick a new day to send again.`;
        return `<div class="recap-sched-state"><i class="recap-sched-dot" aria-hidden="true"></i><div class="recap-sched-grow"><b>Sent on ${escapeHtml(dayLabel(s.day))}</b><span>${escapeHtml(note)}</span></div></div>`;
    }
    if (!s.on) {
        // Turned off during the sending: what is queued still goes, only Stop takes it off
        const waiting = s.progress.queued + s.progress.sending;
        // Off between the first and the last zone's hour: the rest won't get it by date
        const now = Date.now();
        const midway = s.firstAt && new Date(s.firstAt).getTime() <= now && now < new Date(s.lastAt).getTime();
        const note = [
            waiting ? `${chats(waiting)} already queued still go out; Stop in the Send window takes them off.` : '',
            midway ? "Chats whose hour hasn't come won't get it by date: send them by hand." : '',
            !waiting && !midway ? 'Nothing will go out by itself. Sending by hand works as before.' : ''
        ]
            .filter(Boolean)
            .join(' ');
        return `<div class="recap-sched-state"><i class="recap-sched-dot" aria-hidden="true"></i><div class="recap-sched-grow"><b>Off</b><span>${escapeHtml(note)}</span></div></div>`;
    }
    const title = `On: ${escapeHtml(dayLabel(s.day))}, ${hourLabel(s.hour)} chat's time`;
    if (s.firstAt && Date.now() < new Date(s.firstAt).getTime()) {
        const [n, unit] = until(s.firstAt);
        const east =
            s.firstAt !== s.lastAt ? `Chats further east get it earlier: the first at ${moscow(s.firstAt)}. ` : '';
        return `<div class="recap-sched-state armed"><i class="recap-sched-dot" aria-hidden="true"></i><div class="recap-sched-grow"><b>${title}</b><span>${escapeHtml(east)}Turn it off to change the day.</span></div><div class="recap-sched-count"><b>${n}</b><span>${unit} until the first chat</span></div></div>`;
    }
    const p = s.progress;
    const waiting = p.queued + p.sending;
    const note = waiting
        ? `Sending: ${p.sent} of ${p.total} sent${p.quiet ? ` · ${p.quiet} waiting for quiet hours to end` : ''}${p.failed ? ` · ${p.failed} failed` : ''}`
        : `Sent: ${chats(p.sent)}${p.failed ? ` · ${p.failed} failed` : ''}. Chats whose hour hasn't come yet follow.`;
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
        `Sends the <b>${s.year}</b> recap, at ${hourLabel(hour)} in each chat's time zone.`;
    const sw = /** @type {HTMLButtonElement} */ ($('recap-sched-switch'));
    sw.disabled = false;
    sw.setAttribute('aria-checked', String(s.on));
    $('recap-sched-switch-note').textContent = s.on ? 'On' : 'Asks before turning on';
    const a = s.audience;
    const row = (label, n) => `<li><span>${label}</span><em>${n}</em></li>`;
    $('recap-sched-who').innerHTML =
        row('Will get it', chats(a.eligible)) +
        row('Already got it or queued', a.sent + a.queued) +
        (a.failed ? row('Failed earlier (send by hand)', a.failed) : '') +
        row('Nothing to show for the year', a.nothing) +
        row('Blocked in the panel', a.blocked) +
        (a.left ? row('Left the bot', a.left) : '');
    $('recap-sched-pane').setAttribute('aria-busy', 'false');
}

/** Opening the tab. */
export async function loadSchedule() {
    const asked = ++request;
    try {
        const answer = await api('/recap/schedule');
        if (asked === request) render(answer);
    } catch (err) {
        if (asked !== request) return;
        // A dead end, not a form that looks usable: nothing to pick, nothing to switch
        state = null;
        $('recap-sched-state').innerHTML = `<p class="stats-failed">Failed to load: ${escapeHtml(err.message)}</p>`;
        $('recap-sched-year').textContent = '-';
        $('recap-sched-who').innerHTML = '<li><span>Failed to load</span><em>-</em></li>';
        /** @type {HTMLButtonElement} */ ($('recap-sched-switch')).disabled = true;
        lockFields(true);
        $('recap-sched-pane').setAttribute('aria-busy', 'false');
    }
}

async function save(body, done) {
    if (busy) return;
    busy = true;
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
        save({ on: false, day: state.day, hour: state.hour }, 'Scheduled sending is off');
        return;
    }
    showConfirm({
        title: `Send the ${state.year} recap on ${dayLabel(day, false)}?`,
        text: `At ${hourLabel(hour)} in each chat's time zone, ${chats(state.audience.eligible)} will get the six cards, each once. Nothing goes out before that hour; you can turn it off until then.`,
        confirmLabel: 'Turn on',
        cancelLabel: 'Cancel',
        onConfirm: () => save({ on: true, day, hour }, `The ${state.year} recap goes out on ${dayLabel(day, false)}`)
    });
}

export const recapScheduleActions = {
    'recap-sched-toggle': () => toggle()
};

export function setupRecapSchedule() {
    $('recap-sched-day').addEventListener('change', () => pickTime());
    $('recap-sched-hour').addEventListener('change', () => pickTime());
}
