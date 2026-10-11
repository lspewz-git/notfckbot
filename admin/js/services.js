/**
 * The dialog behind the TG / TMDB / KP health badges: status, quota, the masked
 * current token, a field to replace it and a link to the service's status page.
 *
 * The server never sends a token in full — only its first and last characters.
 */

import { $, $field, setText, escapeHtml } from './dom.js';
import { api } from './api.js';
import { toast, openModal, closeModal } from './ui.js';
import { fetchData } from './data.js';

let current = null;

function renderDetails(rows) {
    const list = $('service-details');
    list.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
    list.hidden = rows.length === 0;
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

    setText(
        'service-hint',
        info.restartOnChange
            ? 'The token is checked with Telegram first. Saving restarts the bot: it is offline for a few seconds.'
            : 'The token is checked with the service before it is saved, and applies immediately.'
    );
}

/** @param {string} name telegram | tmdb | kinopoisk */
export async function openServiceModal(name) {
    current = name;
    $field('service-token').value = '';
    setText('service-state', 'Checking…');
    $('service-state').className = 'modal-sub';
    renderDetails([]);
    setText('service-current', '…');
    openModal('service-modal');

    try {
        const info = await api(`/services/${name}`);
        if (current === name) render(info);
    } catch (e) {
        setText('service-state', `Could not load: ${e.message}`);
    }
}

export async function saveServiceToken() {
    const input = $field('service-token');
    const token = input.value.trim();
    if (!token || !current) {
        input.focus();
        return;
    }

    const btn = /** @type {HTMLButtonElement} */ ($('service-save'));
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
        const res = await api(`/services/${current}`, { method: 'POST', body: { token } });
        input.value = '';
        if (res.restarting) {
            toast('Token saved. The bot is restarting — back in a few seconds.', 'success');
            closeModal('service-modal');
            return;
        }
        toast('Token saved', 'success');
        await openServiceModal(current);
        fetchData();
    } catch (e) {
        toast(e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save token';
    }
}
