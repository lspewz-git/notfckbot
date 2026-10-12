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

// While loading: two placeholder rows in the space the details will take
const LOADING_ROWS =
    '<dt><span class="skeleton" style="width:4rem"></span></dt><dd><span class="skeleton" style="width:9rem"></span></dd>'.repeat(
        2
    );

function renderDetails(rows) {
    const list = $('service-details');
    list.innerHTML =
        rows === null
            ? LOADING_ROWS
            : rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
    // Hidden only for a service that has no details to show (or couldn't get them)
    list.hidden = rows !== null && rows.length === 0;
}

/** @param {string | undefined} url @param {string | undefined} label */
function setStatusLink(url, label) {
    const link = /** @type {HTMLAnchorElement} */ ($('service-status-link'));
    // Invisible but still taking its place when unknown, so the dialog doesn't grow
    link.style.visibility = url ? '' : 'hidden';
    if (!url) return;
    link.href = url;
    link.firstChild.textContent = `${label || 'Status page'} `;
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

/** The instant part: name, masked token, status page. */
function renderInfo(info) {
    setText('service-title', info.label);
    $('service-current').classList.remove('is-loading');
    setText('service-current', info.masked || 'not set');
    setStatusLink(info.statusUrl, info.statusLabel);
    setHint(info.restartOnChange);
    if (!info.configured) {
        // Nothing to check without a token
        setText('service-state', 'Not configured');
        $('service-state').className = 'modal-sub';
        renderDetails([]);
    }
}

/** The slow part: whether the service accepts the token, and what it reports. */
function renderCheck(check) {
    if (!check.configured) return;
    const state = $('service-state');
    if (check.ok) {
        state.textContent = '● Working';
        state.className = 'modal-sub state-ok';
        renderDetails(check.details || []);
        return;
    }
    // 401/403: the service is up and refuses this token; another status: up, but failing;
    // no status: it didn't answer (down or unreachable)
    const { status } = check;
    state.textContent =
        status === 401 || status === 403 ? '● Token rejected' : status ? '● Service error' : '● Not responding';
    state.className = 'modal-sub state-error';
    // The reason goes where the details would be, two rows like the loading placeholder,
    // so the dialog keeps its height
    renderDetails([
        ['Error', check.checkError || 'unreachable'],
        ['Checked', new Date().toLocaleTimeString('en-GB')]
    ]);
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
 * @param {{ label?: string, restarts?: boolean, statusUrl?: string, statusLabel?: string }} [known]
 *        what the badge already knows, shown before the server answers: the title, whether
 *        saving restarts the bot, and the status page (useful exactly when the service is down)
 */
export async function openServiceModal(name, known = {}) {
    current = name;
    // Final wording from the start, so the dialog doesn't grow by a line on load
    setHint(Boolean(known.restarts));
    // Everything from the previously opened service is replaced before the slow request
    setText('service-title', known.label || '');
    setText('service-state', 'Checking…');
    $('service-state').className = 'modal-sub';
    renderDetails(null);
    $('service-current').classList.add('is-loading');
    $('service-current').innerHTML = '<span class="skeleton" style="width:8rem"></span>';
    setStatusLink(known.statusUrl, known.statusLabel);
    openModal('service-modal');
    setEditing(false);

    // Two requests at once: the token from .env comes back at once, the service check
    // takes as long as the service does
    const info = api(`/services/${name}`)
        .then((data) => {
            if (current === name) renderInfo(data);
            return data;
        })
        .catch((e) => {
            if (current !== name) return null;
            // The panel's own request failed: keep what the badge knew
            $('service-current').classList.remove('is-loading');
            setText('service-current', 'unknown');
            setText('service-state', `Could not load: ${e.message}`);
            $('service-state').className = 'modal-sub state-error';
            renderDetails([]);
            return null;
        });

    try {
        const check = await api(`/services/${name}/check`);
        // A missing token is reported by renderInfo; wait for it so the order can't flip
        if ((await info) && current === name) renderCheck(check);
    } catch (e) {
        if (current === name && (await info)) {
            renderCheck({ configured: true, ok: false, checkError: e.message });
        }
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
        const link = /** @type {HTMLAnchorElement} */ ($('service-status-link'));
        await openServiceModal(current, {
            label: $('service-title').textContent,
            statusUrl: link.style.visibility === 'hidden' ? undefined : link.href,
            statusLabel: link.firstChild.textContent.trim()
        });
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
