import { t as i18nText } from './i18n.js';
/**
 * Sending the year's recap to every chat that has something to show (Tools → Year recap → Send…,
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
const chats = (count) => i18nText('{{count}} chat', { count });

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
    $('recap-send-body').innerHTML =
        '\n        <ul class="recap-facts">' +
        [
            fact(i18nText('Will get it'), blank),
            fact(i18nText('Already sent'), blank, i18nText('a chat gets its year once')),
            fact(i18nText('Nothing to show'), blank, i18nText('no subscriptions or films')),
            fact(i18nText('Blocked in the panel'), blank)
        ].join('') +
        '</ul>\n        <p class="recap-hint">&nbsp;</p>\n        <div class="modal-actions recap-send-actions">\n            <button type="button" class="btn btn-ghost" data-close="recap-send-modal">' +
        i18nText('Cancel') +
        '</button>\n            <button type="button" class="btn btn-primary" disabled>' +
        i18nText('Send') +
        '</button>\n        </div>';
}

/** @param {{ audience: Record<string, number>, progress: Record<string, any> }} answer */
export function renderRecapSend(answer) {
    const { audience: who, progress: p } = answer;
    const body = $('recap-send-body');
    if (p.queued + p.sending > 0) {
        const done = p.sent + p.failed;
        const share = p.total ? Math.round((done / p.total) * 100) : 0;
        body.innerHTML =
            '\n            <div class="recap-bar" role="progressbar" aria-label="' +
            i18nText('Sent') +
            '" aria-valuemin="0" aria-valuemax="' +
            p.total +
            '" aria-valuenow="' +
            done +
            '"><i style="width:' +
            share +
            '%"></i></div>\n            <ul class="recap-facts">' +
            [
                fact(i18nText('Sent'), i18nText('{{v0}} of {{v1}}', { v0: p.sent, v1: p.total })),
                fact(i18nText('Waiting for quiet hours to end'), p.quiet),
                fact(i18nText('Failed'), p.failed, i18nText('bot blocked or removed from the chat'))
            ].join('') +
            '</ul>\n            <p class="recap-hint">' +
            i18nText('Goes on with the panel closed. Stop takes the chats still waiting off the queue.') +
            '</p>\n            <div class="modal-actions recap-send-actions">\n                <button type="button" class="btn btn-ghost" data-action="recap-send-stop">' +
            i18nText('Stop') +
            '</button>\n            </div>';
        schedule();
        return;
    }
    const rows = [
        fact(i18nText('Will get it'), who.eligible),
        fact(i18nText('Already sent'), who.sent, i18nText('a chat gets its year once')),
        fact(i18nText('Nothing to show'), who.nothing, i18nText('no subscriptions or films')),
        fact(i18nText('Blocked in the panel'), who.blocked)
    ];
    if (who.left)
        rows.push(fact(i18nText('Left the bot'), who.left, i18nText('blocked it or removed it from the group')));
    if (who.failed)
        rows.splice(
            2,
            0,
            fact(i18nText('Failed earlier'), who.failed, i18nText("send again from the chat's Statistics"))
        );
    const hint = i18nText(
        'One chat at a time, about a second each. Chats in quiet hours get it when their hours end. The panel can be closed meanwhile.'
    );
    const disabled = who.eligible ? '' : ' disabled';
    body.innerHTML =
        '\n        <ul class="recap-facts">' +
        rows.join('') +
        '</ul>\n        <p class="recap-hint">' +
        escapeHtml(hint) +
        '</p>\n        <div class="modal-actions recap-send-actions">\n            <button type="button" class="btn btn-ghost" data-close="recap-send-modal">' +
        i18nText('Cancel') +
        '</button>\n            <button type="button" class="btn btn-primary" data-action="recap-send-all"' +
        disabled +
        '>' +
        i18nText('Send to {{v3}}', { v3: chats(who.eligible) }) +
        '</button>\n        </div>';
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
            '<p class="stats-failed">' +
            i18nText('Failed to load: {{v0}}. Close and open again to retry.', { v0: escapeHtml(err.message) }) +
            '</p>';
    }
}

/** The header's button (data-action="recap-send-open"). */
export function openRecapSend(selectedYear = new Date().getFullYear()) {
    year = selectedYear;
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
        title: i18nText('Send the {{v0}} recap to {{v1}}?', { v0: sending, v1: chats(count) }),
        text: i18nText(
            "Each gets its six pictures in one message, once. This can't be undone; Stop takes the chats still waiting off the queue."
        ),
        confirmLabel: i18nText('Send to {{v0}}', { v0: chats(count) }),
        cancelLabel: i18nText('No, cancel'),
        onConfirm: async () => {
            try {
                const res = await api('/recap/send', { method: 'POST', body: { year: sending } });
                toast(i18nText('Queued for {{v0}}', { v0: chats(res.queued) }), 'success');
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
            i18nText('Stopped: {{v0}} taken off the queue{{v1}}', {
                v0: chats(res.removed),
                v1: res.scheduleOff ? i18nText(', sending by date turned off') : ''
            }),
            'success'
        );
    } catch (err) {
        // The queue couldn't be cleared; the schedule may still have been turned off
        res = /** @type {{ data?: any }} */ (err).data || null;
        toast(
            `${err.message}${res && res.scheduleOff ? ' ' + i18nText('(sending by date was turned off)') : ''}`,
            'error'
        );
    }
    // Off in the running bot, but .env still says on: a restart would turn it on again
    if (res && res.scheduleOff && res.scheduleSaved === false) {
        toast(i18nText("Sending by date is off until a restart: .env couldn't be written"), 'error', 8000);
    }
    load(false);
}
