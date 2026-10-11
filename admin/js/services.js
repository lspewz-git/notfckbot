/**
 * The dialog behind the TG / TMDB / KP health badges: status, quota, the masked
 * current token (with a pencil to replace it) and a link to the status page.
 *
 * The server never sends a token in full — only its first and last characters.
 * A saved token goes to .env on the server, after the service has accepted it.
 */

import { $, $field, setText, escapeHtml } from './dom.js';
import { api } from './api.js';
import { toast, openModal, closeModal } from './ui.js';
import { fetchData } from './data.js';

let current = null;

const saveBtn = () => /** @type {HTMLButtonElement} */ ($('service-save'));

function renderDetails(rows) {
    const list = $('service-details');
    list.innerHTML = (rows || []).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
    // Kept visible while loading (empty, at its reserved height) so the dialog
    // doesn't grow when the details arrive; hidden only for a service with none
    list.hidden = rows === null ? false : rows.length === 0;
}

/** Save is only possible while a new token is being typed in. */
function syncSave() {
    const editing = !$field('service-token').hidden;
    saveBtn().disabled = !(editing && $field('service-token').value.trim());
}

/** @param {boolean} on true: show an empty field instead of the masked token */
function setEditing(on) {
    const input = $field('service-token');
    input.value = '';
    input.hidden = !on;
    $('service-current').hidden = on;
    $('service-edit').hidden = on;
    $('service-cancel-edit').hidden = !on;
    syncSave();
    (on ? input : $('service-edit')).focus();
}

function render(info) {
    setText('service-title', info.label);

    const state = $('service-state');
    if (!info.configured) {
        state.textContent = 'Not configured';
        state.className = 'modal-sub';
    } else if (info.ok) {
        state.textContent = '● Working';
        state.className = 'modal-sub state-ok';
    } else {
        state.textContent = `● Error: ${info.error || 'unreachable'}`;
        state.className = 'modal-sub state-error';
    }

    renderDetails(info.details || []);
    setText('service-current', info.masked || 'not set');

    const link = /** @type {HTMLAnchorElement} */ ($('service-status-link'));
    link.href = info.statusUrl;
    link.firstChild.textContent = `${info.statusLabel} `;
    link.style.visibility = '';

    setHint(info.restartOnChange);
}

/** @param {boolean} restarts whether saving restarts the bot (Telegram) */
const setHint = (restarts) =>
    setText(
        'service-hint',
        restarts
            ? 'The token is checked with Telegram, then saved to .env. Saving restarts the bot: it is offline for a few seconds.'
            : 'The token is checked with the service, then saved to .env and used straight away.'
    );

/**
 * @param {string} name telegram | tmdb | kinopoisk
 * @param {string} [label] shown until the server's own label arrives
 * @param {boolean} [restarts] whether saving restarts the bot, for the hint
 */
export async function openServiceModal(name, label = '', restarts = false) {
    current = name;
    // Final wording from the start, so the dialog doesn't grow by a line on load
    setHint(restarts);
    // Clear everything from the previously opened service before the slow request,
    // so nothing stale (e.g. another service's status link) shows while loading
    setText('service-title', label);
    setText('service-state', 'Checking…');
    $('service-state').className = 'modal-sub';
    renderDetails(null);
    setText('service-current', '…');
    // Invisible but still taking its place: removing it would make the dialog grow on load
    $('service-status-link').style.visibility = 'hidden';
    openModal('service-modal');
    setEditing(false);

    try {
        const info = await api(`/services/${name}`);
        if (current === name) render(info);
    } catch (e) {
        if (current === name) setText('service-state', `Could not load: ${e.message}`);
    }
}

export async function saveServiceToken() {
    const input = $field('service-token');
    const token = input.value.trim();
    if (input.hidden || !token || !current) return;

    const btn = saveBtn();
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
        const res = await api(`/services/${current}`, { method: 'POST', body: { token } });
        if (res.restarting) {
            toast('Token saved. The bot is restarting — back in a few seconds.', 'success');
            closeModal('service-modal');
            return;
        }
        toast('Token saved', 'success');
        await openServiceModal(current, $('service-title').textContent, res.restarting);
        fetchData();
    } catch (e) {
        toast(e.message, 'error');
    } finally {
        btn.textContent = 'Save token';
        syncSave();
    }
}

export function setupServiceDialog() {
    $('service-edit').onclick = () => setEditing(true);
    $('service-cancel-edit').onclick = () => setEditing(false);
    $('service-save').onclick = saveServiceToken;
    $field('service-token').oninput = syncSave;
    $field('service-token').onkeydown = (e) => {
        if (e.key === 'Enter') saveServiceToken();
    };
}
