/**
 * Sending the year's recap to every chat that has something to show (Users / Chats → Year recap…,
 * src/recap/send.js): who would get it, then how the sending goes, with Stop.
 */

import { $, escapeHtml } from './dom.js';
import { api } from './api.js';
import { openModal, showConfirm, toast } from './ui.js';

let year = new Date().getFullYear();
// Only the latest answer may fill the dialog: a year switched meanwhile outruns the older
let request = 0;
let poll = null;
/** @type {{ audience: Record<string, number>, progress: Record<string, any> } | null} */
let last = null;

const POLL_MS = 3000;
const years = () => [new Date().getFullYear() - 1, new Date().getFullYear()];
const chats = (n) => `${n} ${n === 1 ? 'chat' : 'chats'}`;

function renderYears() {
    $('recap-send-years').innerHTML = years()
        .map(
            (y) =>
                `<button type="button" class="btn${y === year ? ' active' : ''}" data-action="recap-send-year" data-year="${y}" aria-pressed="${y === year}">${y}</button>`
        )
        .join('');
}

const fact = (label, value, note = '') =>
    `<li class="recap-fact"><span class="recap-fact-label">${label}${note ? `<small>${note}</small>` : ''}</span><b>${value}</b></li>`;

/** The same rows and buttons as the answer's, empty: nothing moves when it comes. */
function renderLoading() {
    const blank = '<span class="skeleton recap-fact-skeleton"></span>';
    $('recap-send-body').innerHTML = `
        <ul class="recap-facts">${[
            fact('Will get it', blank),
            fact('Already sent', blank, 'a chat gets its year once'),
            fact('Nothing to show', blank, 'no subscriptions or films'),
            fact('Blocked in the panel', blank)
        ].join('')}</ul>
        <p class="recap-hint">&nbsp;</p>
        <div class="modal-actions recap-send-actions">
            <button type="button" class="btn btn-ghost" data-close="recap-send-modal">Cancel</button>
            <button type="button" class="btn btn-primary" disabled>Send</button>
        </div>`;
}

/** @param {{ audience: Record<string, number>, progress: Record<string, any> }} answer */
export function renderRecapSend(answer) {
    const { audience: who, progress: p } = answer;
    const body = $('recap-send-body');
    if (p.queued + p.sending > 0) {
        const done = p.sent + p.failed;
        const share = p.total ? Math.round((done / p.total) * 100) : 0;
        body.innerHTML = `
            <div class="recap-bar" role="progressbar" aria-label="Sent" aria-valuemin="0" aria-valuemax="${p.total}" aria-valuenow="${done}"><i style="width:${share}%"></i></div>
            <ul class="recap-facts">${[
                fact('Sent', `${p.sent} of ${p.total}`),
                fact('Waiting for quiet hours to end', p.quiet),
                fact('Failed', p.failed, 'bot blocked or removed from the chat')
            ].join('')}</ul>
            <p class="recap-hint">Goes on with the panel closed. Stop takes the chats still waiting off the queue.</p>
            <div class="modal-actions recap-send-actions">
                <button type="button" class="btn btn-ghost" data-action="recap-send-stop">Stop</button>
            </div>`;
        schedule();
        return;
    }
    const rows = [
        fact('Will get it', who.eligible),
        fact('Already sent', who.sent, 'a chat gets its year once'),
        fact('Nothing to show', who.nothing, 'no subscriptions or films'),
        fact('Blocked in the panel', who.blocked)
    ];
    if (who.left) rows.push(fact('Left the bot', who.left, 'blocked it or removed it from the group'));
    if (who.failed) rows.splice(2, 0, fact('Failed earlier', who.failed, "send again from the chat's Statistics"));
    const hint =
        'One chat at a time, about a second each. Chats in quiet hours get it when their hours end. The panel can be closed meanwhile.';
    const disabled = who.eligible ? '' : ' disabled';
    body.innerHTML = `
        <ul class="recap-facts">${rows.join('')}</ul>
        <p class="recap-hint">${escapeHtml(hint)}</p>
        <div class="modal-actions recap-send-actions">
            <button type="button" class="btn btn-ghost" data-close="recap-send-modal">Cancel</button>
            <button type="button" class="btn btn-primary" data-action="recap-send-all"${disabled}>Send to ${chats(who.eligible)}</button>
        </div>`;
}

/** Asks again in a moment while the sending goes and the dialog is open. */
function schedule() {
    clearTimeout(poll);
    poll = setTimeout(() => {
        if (/** @type {HTMLDialogElement} */ ($('recap-send-modal')).open) load(false);
    }, POLL_MS);
}

async function load(blank = true) {
    const asked = ++request;
    if (blank) renderLoading();
    try {
        const answer = await api(`/recap?year=${year}`);
        if (asked !== request) return;
        last = answer;
        renderRecapSend(answer);
    } catch (err) {
        if (asked !== request) return;
        $('recap-send-body').innerHTML =
            `<p class="stats-failed">Failed to load: ${escapeHtml(err.message)}. Close and open again to retry.</p>`;
    }
}

/** The header's button (data-action="recap-send-open"). */
export function openRecapSend() {
    year = new Date().getFullYear();
    last = null;
    renderYears();
    openModal('recap-send-modal');
    load();
}

/** A year button (data-action="recap-send-year"). */
export function pickRecapYear(value) {
    year = Number(value);
    last = null;
    renderYears();
    load();
}

/** "Send to N chats" (data-action="recap-send-all"): asks first. */
export function confirmSendAll() {
    const count = last ? last.audience.eligible : 0;
    if (!count) return;
    const sending = year;
    showConfirm({
        title: `Send the ${sending} recap to ${chats(count)}?`,
        text: "Each gets its six pictures in one message, once. This can't be undone; Stop takes the chats still waiting off the queue.",
        confirmLabel: `Send to ${chats(count)}`,
        cancelLabel: 'No, cancel',
        onConfirm: async () => {
            try {
                const res = await api('/recap/send', { method: 'POST', body: { year: sending } });
                toast(`Queued for ${chats(res.queued)}`, 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
            if (year === sending) load(false);
        }
    });
}

/** Stop (data-action="recap-send-stop"). */
export async function stopRecapSend() {
    let res = null;
    try {
        res = await api('/recap/stop', { method: 'POST' });
        toast(
            `Stopped: ${chats(res.removed)} taken off the queue${res.scheduleOff ? ', sending by date turned off' : ''}`,
            'success'
        );
    } catch (err) {
        // The queue couldn't be cleared; the schedule may still have been turned off
        res = /** @type {{ data?: any }} */ (err).data || null;
        toast(`${err.message}${res && res.scheduleOff ? ' (sending by date was turned off)' : ''}`, 'error');
    }
    // Off in the running bot, but .env still says on: a restart would turn it on again
    if (res && res.scheduleOff && res.scheduleSaved === false) {
        toast("Sending by date is off until a restart: .env couldn't be written", 'error', 8000);
    }
    load(false);
}
