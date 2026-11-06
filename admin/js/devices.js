/**
 * Account → Devices: the browsers signed in to this account (GET /api/account/sessions). This one on
 * its own card; the others in a list, each opening a sheet with its details and "Sign out this
 * device"; "Sign out of other sessions" ends them all. The entry row on Account settings shows how
 * many are signed in. The current session can't be ended here: that is Sign out in the profile menu.
 */
import { api } from './api.js';
import { $, escapeHtml } from './dom.js';
import { toast, openModal, closeModal, showConfirm } from './ui.js';

const icon = (name) =>
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#${name}" /></svg>`;

/** Other sessions shown before "Show more" */
const SHOWN = 4;

/** @typedef {{ id: string, name: string | null, country: string | null, network: string | null,
 *   seenAt: string, current: boolean }} Device */

/** @type {Device[] | null} null: not loaded (yet) */
let list = null;
let error = '';
let loading = false;
let expanded = false;
// Which load is the latest, and whose: an answer for an earlier load or another account is dropped
let loadNo = 0;
let owner = '';
// A sign-out on its way: another press does nothing
let busy = false;
/** @type {Device | null} The session the sheet shows */
let opened = null;

/** Signed in as someone (else): their list is fetched afresh. */
export function setDevicesOwner(id) {
    if (owner === id) return;
    owner = id;
    list = null;
    error = '';
    expanded = false;
    loadNo += 1;
    render();
}

export async function loadDevices() {
    const no = ++loadNo;
    const who = owner;
    loading = true;
    if (!list) render();
    try {
        const fresh = await api('/account/sessions');
        if (no !== loadNo || who !== owner) return;
        list = fresh;
        error = '';
    } catch (err) {
        if (no !== loadNo || who !== owner) return;
        error = err.message;
    }
    loading = false;
    render();
}

// --- Words ---

let regions;
function countryName(code) {
    if (!code) return '';
    try {
        regions ??= new Intl.DisplayNames(['en'], { type: 'region' });
        return regions.of(code) || code;
    } catch {
        return code;
    }
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const dayMonthYear = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** "5 minutes ago", "2 hours ago", "yesterday", then "2 Nov" */
export function seenWhen(iso, now = Date.now()) {
    const at = new Date(iso);
    const minutes = Math.floor((now - at.getTime()) / 60000);
    if (!(minutes >= 0)) return '';
    if (minutes < 1) return 'Active now';
    if (minutes < 60) return relative.format(-minutes, 'minute');
    if (minutes < 24 * 60) return relative.format(-Math.floor(minutes / 60), 'hour');
    const today = new Date(now);
    const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (Math.round((midnight(today) - midnight(at)) / 86400000) === 1) return relative.format(-1, 'day');
    return (at.getFullYear() === today.getFullYear() ? dayMonth : dayMonthYear).format(at);
}

const nameOf = (device) => device.name || 'Unknown browser';
const placeOf = (device) => [countryName(device.country), device.network].filter(Boolean).join(', ');
const kindIcon = (device) =>
    icon(
        /^Telegram/.test(device.name || '')
            ? 'send'
            : /iPhone|iPad|Android/.test(device.name || '')
              ? 'smartphone'
              : 'laptop'
    );

// --- The Account settings row ---

// "1 active", "3 active": the word is the same in English, the rule still picks it by count
const plural = new Intl.PluralRules('en');
const ACTIVE = { one: 'active', other: 'active' };
const activeCount = (n) => `${n} ${ACTIVE[plural.select(n)] || ACTIVE.other}`;

function renderEntry() {
    const holder = $('my-devices');
    if (!holder) return;
    // From the list already loaded for the page: no request of its own
    const count = list ? activeCount(list.length) : '';
    holder.innerHTML =
        '<h2 class="group-title">Security</h2><ul class="group-list">' +
        '<li><button type="button" class="group-row" data-action="devices-open" data-section="my-devices">' +
        `<span class="row-tile">${icon('monitor-smartphone')}</span>` +
        '<span class="row-text"><span class="row-name">Devices</span></span>' +
        `<span class="row-value" data-devices-count>${escapeHtml(count)}</span>` +
        `<span class="row-chevron">${icon('chevron-right')}</span></button></li></ul>`;
}

// --- The Devices page ---

const SKELETON =
    '<div class="group-card" aria-hidden="true"><span class="row-tile row-tile-lg"></span>' +
    '<span class="row-skeleton"><span class="skeleton"></span><span class="skeleton"></span></span></div>' +
    '<ul class="group-list" aria-hidden="true">' +
    '<li><div class="group-row"><span class="row-tile"></span><span class="row-skeleton"><span class="skeleton"></span><span class="skeleton"></span></span></div></li>'.repeat(
        2
    ) +
    '</ul>';

function currentCard(device) {
    const place = placeOf(device);
    return (
        `<div class="group-card"><span class="row-tile row-tile-lg">${kindIcon(device)}</span>` +
        `<span class="row-text"><span class="card-name">${escapeHtml(nameOf(device))}</span>` +
        '<span class="row-status"><span class="status-dot" aria-hidden="true"></span>This device · Active now</span>' +
        (place ? `<span class="row-meta">${escapeHtml(place)}</span>` : '') +
        '</span></div>'
    );
}

function row(device) {
    const meta = [placeOf(device), seenWhen(device.seenAt)].filter(Boolean).join(' · ');
    return (
        `<li data-device="${escapeHtml(device.id)}"><button type="button" class="group-row" data-action="device-open" data-id="${escapeHtml(device.id)}" aria-haspopup="dialog">` +
        `<span class="row-tile">${kindIcon(device)}</span>` +
        `<span class="row-text"><span class="row-name">${escapeHtml(nameOf(device))}</span>` +
        (meta ? `<span class="row-meta">${escapeHtml(meta)}</span>` : '') +
        // No chevron (the mock-up): the row opens a sheet, not a page
        '</span></button></li>'
    );
}

function render() {
    renderEntry();
    const body = $('devices-body');
    if (!body) return;
    if (!list) {
        body.setAttribute('aria-busy', String(loading || !error));
        body.innerHTML = error
            ? `<div class="group-empty" role="alert"><p>${escapeHtml(error)}</p>` +
              '<button type="button" class="btn btn-outline" data-action="devices-retry">Try again</button></div>'
            : SKELETON;
        return;
    }
    body.removeAttribute('aria-busy');
    const current = list.find((d) => d.current);
    const others = list.filter((d) => !d.current);
    const shown = expanded ? others : others.slice(0, SHOWN);
    const more = others.length - shown.length;
    body.innerHTML =
        (current ? currentCard(current) : '') +
        (others.length
            ? `<button type="button" class="devices-end-others" data-action="devices-end-others"${busy ? ' disabled aria-busy="true"' : ''}>` +
              `${icon('log-out')}<span>${busy ? 'Signing out…' : 'Sign out of other sessions'}</span></button>` +
              '<p class="group-help">This device stays signed in. Signed-out devices will need to sign in again.</p>'
            : '') +
        `<h2 class="group-title">Other sessions · ${others.length}</h2>` +
        (others.length
            ? `<ul class="group-list">${shown.map(row).join('')}` +
              (more
                  ? `<li><button type="button" class="group-row devices-more" data-action="devices-more">` +
                    `<span class="row-name">Show ${more} more</span><span class="row-chevron">${icon('chevron-down')}</span></button></li>`
                  : '') +
              '</ul>'
            : '<p class="group-empty">No other active sessions</p>');
}

// --- One session's sheet ---

function sheetHtml(device) {
    const details = [
        ['Location', countryName(device.country)],
        ['Network', device.network],
        ['Last active', seenWhen(device.seenAt)]
    ].filter(([, value]) => value);
    return (
        '<span class="sheet-grabber" aria-hidden="true"></span>' +
        `<button type="button" class="sheet-close" data-close="device-modal" aria-label="Close">${icon('x')}</button>` +
        `<div class="sheet-head"><span class="row-tile row-tile-xl">${kindIcon(device)}</span>` +
        `<h2 id="device-title">${escapeHtml(nameOf(device))}</h2></div>` +
        (details.length
            ? `<dl class="sheet-details">${details
                  .map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`)
                  .join('')}</dl>`
            : '') +
        '<p class="sheet-error" id="device-error" role="alert" hidden></p>' +
        `<button type="button" class="sheet-btn-danger" data-action="device-end">${icon('log-out')}<span>Sign out this device</span></button>` +
        '<button type="button" class="sheet-btn-secondary" data-close="device-modal">Cancel</button>'
    );
}

function openSheet(id) {
    const device = list?.find((d) => d.id === id && !d.current);
    if (!device) return;
    opened = device;
    $('device-body').innerHTML = sheetHtml(device);
    // Another sign-out still on its way (its sheet was closed meanwhile): this one waits for it
    if (busy) setOutBusy(true);
    openModal('device-modal');
}

/** The sheet still shows this device: a late answer for another one must not touch it */
const showing = (device) => opened === device && /** @type {HTMLDialogElement} */ ($('device-modal')).open;

/**
 * After the list is drawn again: focus that was on a button now gone goes to the row at `index`
 * (or the one before it), else to the page's title, so the keyboard isn't sent back to the top.
 */
function keepFocus(index) {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const rows = /** @type {NodeListOf<HTMLElement>} */ (
        document.querySelectorAll('#devices-body .group-list > li > button')
    );
    const next = rows[Math.min(index, rows.length - 1)];
    if (next) next.focus();
    else $('devices-heading')?.focus();
}

function setOutBusy(on) {
    const button = /** @type {HTMLButtonElement | null} */ (document.querySelector('#device-body .sheet-btn-danger'));
    if (!button) return;
    button.disabled = on;
    button.toggleAttribute('aria-busy', on);
    button.querySelector('span').textContent = on ? 'Signing out…' : 'Sign out this device';
}

/** The row slides away (200 ms; none with reduced motion), then the list is drawn without it */
function dropRow(id) {
    // A list asked for before this sign-out would bring the row back
    loadNo += 1;
    const item = /** @type {HTMLElement | null} */ (
        document.querySelector(`#devices-body [data-device="${window.CSS.escape(id)}"]`)
    );
    const index = item ? [...item.parentElement.children].indexOf(item) : 0;
    const gone = () => {
        list = list && list.filter((d) => d.id !== id);
        render();
        keepFocus(index);
    };
    if (!item || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return gone();
    // Leaving: no longer pressed, focused or read out while it slides away
    item.inert = true;
    item.classList.add('row-leaving');
    setTimeout(gone, 200);
}

async function endOne() {
    if (busy || !opened) return;
    const device = opened;
    const who = owner;
    busy = true;
    setOutBusy(true);
    $('device-error').hidden = true;
    try {
        await api(`/account/sessions/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
    } catch (err) {
        // Already gone elsewhere: what the user wanted
        if (err.status !== 404) {
            busy = false;
            setOutBusy(false);
            // The sheet was closed or shows another device meanwhile: the reason still reaches the user
            if (!showing(device)) return toast(err.message, 'error');
            const error = $('device-error');
            error.textContent = err.message;
            error.hidden = false;
            return;
        }
    }
    busy = false;
    setOutBusy(false);
    if (who !== owner) return;
    if (showing(device)) {
        opened = null;
        closeModal('device-modal');
    }
    dropRow(device.id);
    toast('Signed out', 'success');
}

async function endOthers() {
    if (busy) return;
    const who = owner;
    busy = true;
    render();
    try {
        await api('/account/sessions/end-others', { method: 'POST' });
        if (who === owner) {
            // A list asked for before this would bring the ended sessions back
            loadNo += 1;
            list = list && list.filter((d) => d.current);
            toast('Signed out of other sessions', 'success');
        }
    } catch (err) {
        toast(err.message, 'error');
    }
    busy = false;
    render();
    keepFocus(0);
}

/** Click handlers, merged into app.js's delegation like the other modules' */
export const deviceActions = {
    // Runs with the section switch (data-section on the same row): fresh each time the page opens
    'devices-open': () => {
        expanded = false;
        loadDevices();
    },
    'devices-retry': () => {
        error = '';
        loadDevices();
    },
    'devices-more': () => {
        expanded = true;
        render();
        // The first row that was hidden takes the focus the button had
        /** @type {HTMLElement | null} */ (
            document.querySelectorAll('#devices-body .group-list > li')[SHOWN]?.querySelector('button')
        )?.focus();
    },
    'device-open': (el) => openSheet(el.dataset.id),
    'device-end': endOne,
    'devices-end-others': () => {
        if (busy || !list) return;
        const n = list.filter((d) => !d.current).length;
        showConfirm({
            title: `Sign out of ${n} other session${n === 1 ? '' : 's'}?`,
            text: 'They will need to sign in again.',
            confirmLabel: 'Sign out',
            cancelLabel: 'Cancel',
            onConfirm: endOthers
        });
    }
};
