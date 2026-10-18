/**
 * Settings: the server's .env as fields. Changes stay on the page, marked, until Save sends them
 * all at once; the server checks every one before it writes anything (src/admin/routes/settings.js).
 */

import { $, $field, all } from './dom.js';
import { api } from './api.js';
import { toast, showConfirm } from './ui.js';
import { setSelectValue } from './select.js';
import { composeProxyUrl, parseProxyUrl } from './proxy-url.js';

const SERVICES = ['telegram', 'tmdb', 'kinopoisk'];
const PENDING_NAMES = { interval: 'the update interval', telegram: 'the new Telegram token' };

/** What the server last said; the fields are compared against it. Null until the first load. */
let saved = null;
let saving = false;
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

/**
 * The changes on the page, as the server takes them.
 * @returns {{ body: Record<string, any>, count: number, dirty: Set<string>, proxyIncomplete: boolean }}
 */
function collectChanges() {
    const body = {};
    const dirty = new Set();
    if (!saved) return { body, count: 0, dirty, proxyIncomplete: false };

    const tokens = {};
    for (const name of SERVICES) {
        const input = tokenInput(name);
        if (!input.hidden && input.value.trim()) {
            tokens[name] = input.value.trim();
            dirty.add(`token-${name}`);
        }
    }
    if (Object.keys(tokens).length) body.tokens = tokens;

    const parts = proxyParts();
    const pass = proxyField('pass').value;
    const typed = composeProxyUrl(parts);
    const savedParts = parseProxyUrl(saved.proxy.url) || { scheme: '', host: '', port: '', user: '' };
    const proxyIncomplete = Boolean(parts.scheme) && !typed;
    if (typed !== composeProxyUrl(savedParts) || pass || proxyIncomplete) {
        body.proxyUrl = composeProxyUrl({ ...parts, pass });
        for (const part of ['scheme', 'host', 'port', 'user']) {
            if (String(parts[part]).trim() !== String(savedParts[part])) dirty.add(`proxy-${part}`);
        }
        if (pass) dirty.add('proxy-pass');
    }

    const hours = Number($field('settings-interval').value);
    if (hours !== saved.interval.hours) {
        body.intervalHours = hours;
        dirty.add('interval');
    }

    const count = Object.keys(tokens).length + ('proxyUrl' in body ? 1 : 0) + ('intervalHours' in body ? 1 : 0);
    return { body, count, dirty, proxyIncomplete };
}

/** Marks the changed fields and says how many there are. */
function refreshChanges() {
    const { count, dirty } = collectChanges();
    for (const name of SERVICES) tokenInput(name).dataset.dirty = String(dirty.has(`token-${name}`));
    for (const part of ['scheme', 'host', 'port', 'user', 'pass']) {
        proxyField(part).dataset.dirty = String(dirty.has(`proxy-${part}`));
    }
    $field('settings-interval').dataset.dirty = String(dirty.has('interval'));
    $('settings-proxy-fields').hidden = !proxyField('scheme').value;

    $('settings-bar').dataset.dirty = String(count > 0);
    $('settings-bar-text').textContent = count
        ? `${count} unsaved ${count === 1 ? 'change' : 'changes'}`
        : 'No changes';
}

export const hasUnsavedSettings = () => collectChanges().count > 0;

function showErrors(fields = {}) {
    for (const name of [...SERVICES, 'proxy', 'interval']) {
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

/** Puts the saved values into the fields: on load, after a save, and on Discard. */
function fill(settings) {
    filling = true;
    try {
        fillFields(settings);
    } finally {
        filling = false;
    }
}

/** The proxy on screen, password included: what a connection check was made with. */
const proxyOnScreen = () => composeProxyUrl({ ...proxyParts(), pass: proxyField('pass').value });

function fillFields(settings) {
    const proxyBefore = proxyOnScreen();
    for (const name of SERVICES) {
        const token = settings.tokens[name];
        $(`settings-masked-${name}`).textContent = token.configured ? token.masked : 'Not set';
        const input = tokenInput(name);
        input.value = '';
        input.hidden = true;
        $(`settings-masked-${name}`).hidden = false;
        const button = /** @type {HTMLElement} */ (
            document.querySelector(`[data-action="settings-replace"][data-service="${name}"]`)
        );
        button.textContent = token.configured ? 'Replace' : 'Set';
    }

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

    const interval = $field('settings-interval');
    const choices = settings.interval.choices.map(String).join(',');
    if (interval.dataset.choices !== choices) {
        interval.innerHTML = settings.interval.choices
            .map((h) => `<option value="${h}">${h === 1 ? '1 hour' : `${h} hours`}</option>`)
            .join('');
        interval.dataset.choices = choices;
    }
    setSelectValue('settings-interval', String(settings.interval.hours));

    $('settings-db-host').textContent = settings.database.host || '—';
    $('settings-db-name').textContent = settings.database.name || '—';
    $('settings-db-user').textContent = settings.database.user || '—';

    renderRestart(settings);
    showErrors();
    refreshChanges();
    // A check stays while it still describes the proxy on screen (a refresh, a save); after
    // Discard put other values back, it would mislead
    if (proxyOnScreen() !== proxyBefore) renderChecks();
}

/** Opening the section and the auto-refresh: never over edits in progress. */
/** Changes made, a token field open for pasting, or the cursor in a field: the page is in use. */
function isEditing() {
    if (hasUnsavedSettings()) return true;
    if (SERVICES.some((name) => !tokenInput(name).hidden)) return true;
    const focused = document.activeElement;
    return Boolean(focused && focused.closest('#settings-section') && focused.matches('input, select'));
}

export async function loadSettings() {
    const settings = await api('/settings');
    if (saved && isEditing()) {
        // Only what can't conflict with them: the restart state
        saved = { ...saved, restart: settings.restart };
        renderRestart(saved);
        return;
    }
    saved = settings;
    fill(saved);
}

function toggleReplace(name) {
    const input = tokenInput(name);
    const button = /** @type {HTMLElement} */ (
        document.querySelector(`[data-action="settings-replace"][data-service="${name}"]`)
    );
    const editing = input.hidden;
    input.hidden = !editing;
    $(`settings-masked-${name}`).hidden = editing;
    input.value = '';
    button.textContent = editing ? 'Cancel' : saved && saved.tokens[name].configured ? 'Replace' : 'Set';
    if (editing) input.focus();
    refreshChanges();
}

async function save() {
    if (saving) return;
    const { body, count, proxyIncomplete } = collectChanges();
    if (proxyIncomplete) {
        showErrors({ proxy: 'Fill in the host and the port, or set the mode to Off' });
        return;
    }
    if (!count) {
        toast('No changes to save', 'info');
        return;
    }
    const button = $('settings-save');
    saving = true;
    button.setAttribute('aria-busy', 'true');
    try {
        const res = await api('/settings', { method: 'POST', body });
        saved = res.settings;
        fill(saved);
        const names = res.saved.length
            ? `Saved ${res.saved.length === 1 ? 'one setting' : `${res.saved.length} settings`}`
            : 'Nothing changed';
        const restart = saved.restart.pending.length ? '. Restart the bot to apply the rest.' : '';
        toast(names + restart, 'success', restart ? 6000 : 3500);
    } catch (err) {
        if (err.data && err.data.fields) showErrors(err.data.fields);
        toast(err.message, 'error');
    } finally {
        saving = false;
        button.removeAttribute('aria-busy');
    }
}

export function discardSettings() {
    if (saved) fill(saved);
}

const discard = discardSettings;

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
    'settings-save': () => save(),
    'settings-discard': () => discard(),
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
    // Enter in a field saves, as in a form
    section.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && /** @type {HTMLElement} */ (e.target).matches('input')) {
            e.preventDefault();
            save();
        }
    });
    window.addEventListener('beforeunload', (e) => {
        if (!hasUnsavedSettings()) return;
        e.preventDefault();
        // Older browsers ask only when this is set
        e.returnValue = '';
    });
    all('[data-setting]').forEach((el) => el.setAttribute('data-dirty', 'false'));
}
