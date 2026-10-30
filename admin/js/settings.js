/**
 * Settings: the server's .env as fields, in three tabs. Services and Proxy keep their changes on the
 * page, marked, until the card's own Save sends them; the update interval is saved when picked. The
 * server checks every field before it writes anything (src/admin/routes/settings.js).
 */

import { $, $field, all } from './dom.js';
import { api } from './api.js';
import { toast, showConfirm } from './ui.js';
import { setSelectValue } from './select.js';
import { composeProxyUrl, parseProxyUrl } from './proxy-url.js';

const SERVICES = ['telegram', 'tmdb', 'kinopoisk'];
const TABS = ['connections', 'bot', 'alerts'];
const TAB_KEY = 'settings-tab';
// Which fields' errors each card shows
const CARD_ERRORS = { services: SERVICES, proxy: ['proxy'], interval: ['interval'], none: [] };

const PENDING_NAMES = { interval: 'the update interval', telegram: 'the new Telegram token' };

/** What the server last said; the fields are compared against it. Null until the first load. */
let saved = null;
// Cards whose save is on its way
const saving = new Set();
// An interval picked while the last pick was still being saved: sent once that answer is in
let intervalAgain = false;
// Counts saves: a refresh asked for before one finished brings the values from before it
let saves = 0;
let tab = readTab();
// Set while fill() puts values into the fields: its change events are not the user's edits
let filling = false;

const proxyField = (part) => $field(`settings-proxy-${part}`);
const tokenInput = (name) => $field(`settings-token-${name}`);
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The proxy as typed, without the password (the server keeps the saved one when it's empty). */
function proxyParts() {
    return {
        scheme: proxyField('scheme').value,
        host: proxyField('host').value,
        port: proxyField('port').value,
        user: proxyField('user').value
    };
}

/** The tab last open, kept in this browser; storage may be off (a private window). */
function readTab() {
    try {
        const kept = localStorage.getItem(TAB_KEY);
        return TABS.includes(kept) ? kept : 'connections';
    } catch {
        return 'connections';
    }
}

/**
 * The changes on the page, as the server takes them, per card.
 * @returns {{ cards: Record<'services' | 'proxy' | 'interval', { body: Record<string, any>, count: number }>,
 *   count: number, dirty: Set<string>, proxyIncomplete: boolean }}
 */
function collectChanges() {
    const cards = {
        services: { body: {}, count: 0 },
        proxy: { body: {}, count: 0 },
        interval: { body: {}, count: 0 }
    };
    const dirty = new Set();
    if (!saved) return { cards, count: 0, dirty, proxyIncomplete: false };

    const tokens = {};
    for (const name of SERVICES) {
        const input = tokenInput(name);
        if (!input.hidden && input.value.trim()) {
            tokens[name] = input.value.trim();
            dirty.add(`token-${name}`);
        }
    }
    if (Object.keys(tokens).length) cards.services = { body: { tokens }, count: Object.keys(tokens).length };

    const parts = proxyParts();
    const pass = proxyField('pass').value;
    const typed = composeProxyUrl(parts);
    const savedParts = parseProxyUrl(saved.proxy.url) || { scheme: '', host: '', port: '', user: '' };
    const proxyIncomplete = Boolean(parts.scheme) && !typed;
    if (typed !== composeProxyUrl(savedParts) || pass || proxyIncomplete) {
        cards.proxy.body = { proxyUrl: composeProxyUrl({ ...parts, pass }) };
        for (const part of ['scheme', 'host', 'port', 'user']) {
            if (String(parts[part]).trim() !== String(savedParts[part])) dirty.add(`proxy-${part}`);
        }
        if (pass) dirty.add('proxy-pass');
        cards.proxy.count = Math.max(1, [...dirty].filter((d) => d.startsWith('proxy-')).length);
    }

    const hours = Number($field('settings-interval').value);
    if (hours !== saved.interval.hours) {
        cards.interval = { body: { intervalHours: hours }, count: 1 };
        dirty.add('interval');
    }

    const count = cards.services.count + cards.proxy.count + cards.interval.count;
    return { cards, count, dirty, proxyIncomplete };
}

/** Marks the changed fields and says how many there are. */
function refreshChanges() {
    const { cards, dirty } = collectChanges();
    for (const name of SERVICES) tokenInput(name).dataset.dirty = String(dirty.has(`token-${name}`));
    for (const part of ['scheme', 'host', 'port', 'user', 'pass']) {
        proxyField(part).dataset.dirty = String(dirty.has(`proxy-${part}`));
    }
    $field('settings-interval').dataset.dirty = String(dirty.has('interval'));
    $('settings-proxy-fields').hidden = !proxyField('scheme').value;

    for (const card of ['services', 'proxy']) {
        const { count } = cards[card];
        const foot = $(`settings-foot-${card}`);
        foot.hidden = count === 0;
        /** @type {HTMLElement} */ (foot.querySelector('.settings-foot-text')).textContent =
            `${count} unsaved ${count === 1 ? 'change' : 'changes'}`;
    }
    // A tab with changes left in it says so: they'd be easy to forget behind another tab
    const connections = /** @type {HTMLElement} */ (
        document.querySelector('[data-action="settings-tab"][data-tab="connections"]')
    );
    const tabDirty = cards.services.count + cards.proxy.count > 0;
    connections.dataset.dirty = String(tabDirty);
    // The dot says it to the eye; the hidden note, to a screen reader
    if (tabDirty) connections.setAttribute('aria-describedby', 'settings-unsaved-note');
    else connections.removeAttribute('aria-describedby');
}

/** Changes the cards would lose. The interval saves itself, so it is never one of them. */
export const hasUnsavedSettings = () => {
    const { cards } = collectChanges();
    return cards.services.count + cards.proxy.count > 0;
};

/** The fields' errors; only those of the given fields are touched (all by default). */
function showErrors(fields = {}, names = [...SERVICES, 'proxy', 'interval']) {
    for (const name of names) {
        const el = $(`settings-error-${name}`);
        el.textContent = fields[name] || '';
        el.hidden = !fields[name];
    }
}

/** Why a restart can't happen now, in words. */
function blockText(blocked) {
    if (blocked.reason === 'running') return 'An update check is running. Restart once it finishes.';
    const when =
        blocked.reason === 'due' ? `runs at ${clock(blocked.checkAt)}` : `started at ${clock(blocked.checkAt)}`;
    // Before a check its length is unknown: the latest it can be is all we can say
    if (blocked.reason === 'due')
        return `An update check ${when}. Restart once it finishes, by ${clock(blocked.until)} at the latest.`;
    // Seconds left: a clock without seconds would read as "now"
    const left = Math.ceil((new Date(blocked.until).getTime() - Date.now()) / 1000);
    if (left > 0 && left < 60) return `An update check ${when}. Restart in ${left} s.`;
    return `An update check ${when}. Restart after ${clock(blocked.until)}.`;
}

function renderRestart(settings) {
    const pending = settings.restart.pending.map((p) => PENDING_NAMES[p] || p);
    const text = $('settings-restart-text');
    text.dataset.pending = String(pending.length > 0);
    const since = new Date(settings.startedAt);
    const day =
        since.toDateString() === new Date().toDateString()
            ? 'today'
            : since.toLocaleDateString([], { day: 'numeric', month: 'short' });
    text.textContent = pending.length
        ? `Waiting for a restart: ${pending.join(' and ')}.`
        : // Short enough for one line on a phone, as tall as the placeholder before it
          `Running since ${day}, ${clock(settings.startedAt)}.`;
}

/** The connection check's lines: blank (not checked, or the proxy changed since), or the result. */
function renderChecks(res = null, at = null) {
    const names = ['telegram', 'tmdb', 'internet'];
    $('settings-checks-when').textContent = at
        ? `${res.direct ? 'Direct' : 'Through the proxy'}, ${clock(at)}`
        : 'Press Test to check';
    for (const name of names) {
        const cell = /** @type {HTMLElement} */ (document.querySelector(`[data-check="${name}"]`));
        const check = res && res.checks[name];
        cell.dataset.state = !check ? '' : check.ok ? 'ok' : 'error';
        if (!check) cell.textContent = '—';
        else if (!check.ok) cell.textContent = `✗ ${res.proxyDown ? `proxy: ${res.proxyDown}` : check.error}`;
        else cell.textContent = `✓ ${check.ms} ms${check.ip ? ` · IP ${check.ip}` : ''}`;
    }
}

/**
 * Puts the saved values into the fields: on load, after a save, and on Discard. With a card, only
 * its fields: the other card's unsaved edits stay.
 * @param {any} settings
 * @param {'services' | 'proxy' | 'interval' | 'none' | null} [card] none: only what isn't a field
 */
function fill(settings, card = null) {
    filling = true;
    try {
        fillFields(settings, card);
    } finally {
        filling = false;
    }
}

/** The proxy on screen, password included: what a connection check was made with. */
const proxyOnScreen = () => composeProxyUrl({ ...proxyParts(), pass: proxyField('pass').value });

function fillFields(settings, card) {
    const proxyBefore = proxyOnScreen();
    if (!card || card === 'services') fillServices(settings);
    if (!card || card === 'proxy') fillProxy(settings);
    if (!card || card === 'interval') fillInterval(settings);
    if (!card) fillChangesKeep(settings);

    $('settings-db-host').textContent = settings.database.host || '—';
    $('settings-db-name').textContent = settings.database.name || '—';
    $('settings-db-user').textContent = settings.database.user || '—';

    renderRecapSchedule(settings);
    renderRestart(settings);
    showErrors({}, card ? CARD_ERRORS[card] : undefined);
    refreshChanges();
    // A check stays while it still describes the proxy on screen (a refresh, a save); after
    // Discard put other values back, it would mislead
    if (proxyOnScreen() !== proxyBefore) renderChecks();
}

/** The pencil (open the field) or the cross (close it, the value unchanged). */
function setReplaceButton(name, open) {
    const button = /** @type {HTMLElement} */ (
        document.querySelector(`[data-action="settings-replace"][data-service="${name}"]`)
    );
    const label = open ? 'Cancel' : saved && !saved.tokens[name].configured ? 'Set' : 'Replace';
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', label);
    button.title = label;
}

function fillServices(settings) {
    for (const name of SERVICES) {
        const token = settings.tokens[name];
        $(`settings-masked-${name}`).textContent = token.configured ? token.masked : 'Not set';
        const input = tokenInput(name);
        input.value = '';
        input.hidden = true;
        $(`settings-masked-${name}`).hidden = false;
        setReplaceButton(name, false);
    }
}

function fillProxy(settings) {
    const parts = parseProxyUrl(settings.proxy.url);
    if (!parts) toast("The saved proxy URL can't be read: set it again", 'warning');
    const { scheme, host, port, user } = parts || { scheme: '', host: '', port: '', user: '' };
    setSelectValue('settings-proxy-scheme', scheme);
    proxyField('host').value = host;
    proxyField('port').value = port;
    proxyField('user').value = user;
    proxyField('pass').value = '';
    /** @type {HTMLInputElement} */ (proxyField('pass')).placeholder = settings.proxy.hasPassword
        ? 'Saved — leave empty to keep'
        : 'Password';
}

function fillInterval(settings) {
    const interval = $field('settings-interval');
    const choices = settings.interval.choices.map(String).join(',');
    if (interval.dataset.choices !== choices) {
        interval.innerHTML = settings.interval.choices
            .map((h) => `<option value="${h}">${h === 1 ? '1 hour' : `${h} hours`}</option>`)
            .join('');
        interval.dataset.choices = choices;
    }
    setSelectValue('settings-interval', String(settings.interval.hours));
}

/** How long the chats' change log is kept: a select of its own, saved when picked. */
function fillChangesKeep(settings) {
    if (!settings.changes) return;
    const select = $field('settings-changes');
    const choices = settings.changes.choices.map(String).join(',');
    if (select.dataset.choices !== choices) {
        select.innerHTML = settings.changes.choices.map((d) => `<option value="${d}">${d} days</option>`).join('');
        select.dataset.choices = choices;
    }
    setSelectValue('settings-changes', String(settings.changes.days));
}

async function saveChangesKeep() {
    const select = $field('settings-changes');
    select.setAttribute('aria-busy', 'true');
    try {
        const res = await api('/settings', { method: 'POST', body: { changesKeepDays: Number(select.value) } });
        saves += 1;
        saved = { ...saved, changes: res.settings.changes };
        toast('Change log period saved.', 'success');
    } catch (err) {
        // A refused pick goes back to the saved value
        if (saved) {
            filling = true;
            try {
                fillChangesKeep(saved);
            } finally {
                filling = false;
            }
        }
        toast(err.message, 'error');
    } finally {
        select.removeAttribute('aria-busy');
    }
}

/** The year recap by date: only what is set; it is set in Year recap → Schedule. */
function renderRecapSchedule(settings) {
    const r = settings.recap || {};
    const when = r.day
        ? `${new Date(`${r.day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}, ${String(r.hour).padStart(2, '0')}:00 chat's time`
        : '';
    $('settings-recap').textContent = r.on
        ? `On · ${when}`
        : r.done
          ? `Sent · ${when}`
          : when
            ? `Off · ${when} picked`
            : 'Off';
}

/** Changes made, a token field open for pasting, or the cursor in a field: the page is in use. */
function isEditing() {
    if (hasUnsavedSettings()) return true;
    if (SERVICES.some((name) => !tokenInput(name).hidden)) return true;
    const focused = document.activeElement;
    return Boolean(focused && focused.closest('#settings-section') && focused.matches('input, select'));
}

export async function loadSettings() {
    const before = saves;
    const settings = await api('/settings');
    // A save answered meanwhile has newer values than this answer
    if (before !== saves || saving.size) return;
    if (saved && isEditing()) {
        // Only what can't conflict with them: the restart state and the recap schedule
        saved = { ...saved, restart: settings.restart, recap: settings.recap };
        renderRestart(saved);
        renderRecapSchedule(saved);
        return;
    }
    saved = settings;
    fill(saved);
}

function toggleReplace(name) {
    const input = tokenInput(name);
    const editing = input.hidden;
    input.hidden = !editing;
    $(`settings-masked-${name}`).hidden = editing;
    input.value = '';
    setReplaceButton(name, editing);
    if (editing) input.focus();
    refreshChanges();
}

const SAVED_TEXT = { services: 'Token saved.', proxy: 'Proxy saved.', interval: 'Update interval saved.' };

/**
 * Sends one card's changes. The answer has all the settings, but only this card's fields are
 * refilled: the other card's edits stay on the page.
 * @param {'services' | 'proxy' | 'interval'} card
 */
async function save(card) {
    // Only the cards there are: a stray data-card mustn't throw on cards[card]
    if (!(card in CARD_ERRORS) || CARD_ERRORS[card].length === 0) return;
    if (saving.has(card)) {
        if (card === 'interval') intervalAgain = true;
        return;
    }
    const { cards, proxyIncomplete } = collectChanges();
    if (card === 'proxy' && proxyIncomplete) {
        showErrors({ proxy: 'Fill in the host and the port, or set the mode to Off' }, ['proxy']);
        return;
    }
    const { body, count } = cards[card];
    if (!count) return;
    // The interval has no button: its field shows the wait
    const button =
        card === 'interval'
            ? $field('settings-interval')
            : document.querySelector(`[data-action="settings-save"][data-card="${card}"]`);
    saving.add(card);
    button.setAttribute('aria-busy', 'true');
    try {
        const res = await api('/settings', { method: 'POST', body });
        saves += 1;
        saved = res.settings;
        // A newer pick on screen stays there: it is sent next
        fill(saved, card === 'interval' && intervalAgain ? 'none' : card);
        const what = card === 'services' && count > 1 ? 'Tokens saved.' : SAVED_TEXT[card];
        // Only what this save left waiting: an older pending one is in the Bot card already
        const waits =
            (card === 'interval' || (card === 'services' && body.tokens.telegram)) && saved.restart.pending.length;
        toast(waits ? `${what} Restart the bot to apply it.` : what, 'success', waits ? 6000 : 3500);
    } catch (err) {
        // The interval has no Discard: a refused one goes back to the saved value (before the
        // reason is shown: the refill clears the card's errors)
        if (card === 'interval' && saved && !intervalAgain) fill(saved, 'interval');
        if (err.data && err.data.fields) showErrors(err.data.fields, CARD_ERRORS[card]);
        toast(err.message, 'error');
    } finally {
        saving.delete(card);
        button.removeAttribute('aria-busy');
        if (card === 'interval' && intervalAgain) {
            intervalAgain = false;
            save('interval');
        }
    }
}

/** Puts the saved values back: one card's, or all of them (leaving the section). */
export function discardSettings(card = null) {
    // A pick still waiting to be sent would undo what Discard puts back
    if (!card || card === 'interval') intervalAgain = false;
    if (saved) fill(saved, card);
}

/** Shows one tab's cards and keeps the choice for the next visit. */
function pickTab(name) {
    if (!TABS.includes(name)) return;
    tab = name;
    try {
        localStorage.setItem(TAB_KEY, name);
    } catch {
        // storage off: the tab just isn't kept
    }
    renderTabs();
}

function renderTabs() {
    for (const btn of /** @type {NodeListOf<HTMLElement>} */ (
        document.querySelectorAll('[data-action="settings-tab"]')
    )) {
        const on = btn.dataset.tab === tab;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
    }
    for (const name of TABS) $(`settings-pane-${name}`).hidden = name !== tab;
}

async function testProxy(button) {
    const parts = proxyParts();
    const url = composeProxyUrl({ ...parts, pass: proxyField('pass').value });
    if (parts.scheme && !url) {
        showErrors({ proxy: 'Fill in the host and the port first' });
        return;
    }
    showErrors();
    button.setAttribute('aria-busy', 'true');
    try {
        const res = await api('/config/test-proxy', { method: 'POST', body: { url } });
        renderChecks(res, new Date().toISOString());
    } catch (err) {
        showErrors({ proxy: err.message });
    } finally {
        button.removeAttribute('aria-busy');
    }
}

/** Waits for the restarted bot to answer again, then shows what it runs with now. */
async function waitForComeback() {
    const started = Date.now();
    // The old process answers for under a second after the request; give it time to go
    await new Promise((resolve) => setTimeout(resolve, 3000));
    while (Date.now() - started < 90000) {
        try {
            saved = await api('/settings');
            fill(saved);
            toast('The bot is back', 'success');
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }
    toast("The bot hasn't come back in 90 s. Check the server.", 'error', 8000);
}

function restart() {
    if (hasUnsavedSettings()) {
        toast('Save or discard the changes first', 'warning');
        return;
    }
    if (saved && saved.restart.blocked) {
        toast(blockText(saved.restart.blocked), 'warning', 6000);
        return;
    }
    showConfirm({
        title: 'Restart the bot?',
        text:
            'The bot stops and starts again with the saved .env. It is back in about 5 seconds; ' +
            'messages and button presses sent meanwhile are answered once it is up.',
        confirmLabel: 'Restart',
        cancelLabel: 'Cancel',
        onConfirm: async () => {
            try {
                await api('/restart', { method: 'POST' });
            } catch (err) {
                toast(err.data && err.data.blocked ? blockText(err.data.blocked) : err.message, 'warning', 6000);
                return;
            }
            toast('Restarting…', 'info');
            await waitForComeback();
        }
    });
}

export const settingsActions = {
    'settings-replace': (el) => toggleReplace(el.dataset.service),
    'settings-tab': (el) => pickTab(el.dataset.tab),
    'settings-save': (el) => save(/** @type {any} */ (el.dataset.card)),
    'settings-discard': (el) => discardSettings(/** @type {any} */ (el.dataset.card)),
    'settings-proxy-test': (el) => testProxy(el),
    'settings-restart': () => restart()
};

/** Typing anywhere in the section updates the marks; a closed tab asks first if there's something unsaved. */
export function setupSettings() {
    const section = $('settings-section');
    section.addEventListener('input', refreshChanges);
    section.addEventListener('change', refreshChanges);
    // A check of other proxy settings than those on screen would mislead: clear it
    const clearChecks = (e) => {
        if (!filling && /** @type {HTMLElement} */ (e.target).id?.startsWith('settings-proxy-')) renderChecks();
    };
    section.addEventListener('input', clearChecks);
    section.addEventListener('change', clearChecks);
    // The update interval has no Save: picked is saved
    $field('settings-interval').addEventListener('change', () => {
        if (!filling) save('interval');
    });
    $field('settings-changes').addEventListener('change', () => {
        if (!filling) saveChangesKeep();
    });
    // Enter in a field saves its card, as in a form
    section.addEventListener('keydown', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        const card = /** @type {HTMLElement | null} */ (target.closest('[data-card]'));
        if (e.key === 'Enter' && target.matches('input') && card) {
            e.preventDefault();
            save(/** @type {any} */ (card.dataset.card));
        }
    });
    window.addEventListener('beforeunload', (e) => {
        if (!hasUnsavedSettings()) return;
        e.preventDefault();
        // Older browsers ask only when this is set
        e.returnValue = '';
    });
    all('[data-setting]').forEach((el) => el.setAttribute('data-dirty', 'false'));
    renderTabs();
}
