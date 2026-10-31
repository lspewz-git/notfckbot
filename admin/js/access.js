/**
 * Panel access (Settings → Bot): who may sign in and as what. Saved when picked; the server
 * writes ADMIN_USERS / ACCOUNT_USERS and the change applies at once (src/admin/routes/access.js).
 */

import { $, $field, all, escapeHtml } from './dom.js';
import { api } from './api.js';
import { toast, showConfirm } from './ui.js';
import { chatDisplayName, chatLabel } from './format.js';
import { enhanceIn, setSelectValue } from './select.js';
import { pickTab } from './settings.js';

export const ROLE_LABELS = { admin: 'Admin', user: 'User' };

const trash =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>';

// A key with a slash: the person's password removed
const keyOff =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3 21 2" /><path d="m16 7 3 3" /><path d="M3 3l18 18" /></svg>';

/** @type {{ people: any[], candidates: any[] } | null} */
let access = null;
// A chat's menu asked for this person: shown once the list is in
let wanted = null;
// Saves still waiting for their answer: a list read meanwhile would be older
let saving = 0;

/** The person as a private chat, for the panel's name and avatar. */
const asChat = (p) => ({ id: p.id, type: 'private', username: p.name });

/** The role pill next to a chat's name in Users / Chats. */
export const roleBadge = (role) =>
    ROLE_LABELS[role]
        ? ` <span class="badge ${role === 'admin' ? 'warn' : 'muted'} access-badge">${ROLE_LABELS[role]}</span>`
        : '';

function roleSelect(p) {
    const options = Object.entries(ROLE_LABELS)
        .map(([value, label]) => `<option value="${value}"${value === p.role ? ' selected' : ''}>${label}</option>`)
        .join('');
    return `<select class="select-field access-role" data-id="${escapeHtml(p.id)}" aria-label="Role for ${escapeHtml(chatLabel(asChat(p)))}">${options}</select>`;
}

function personRow(p) {
    const label = escapeHtml(chatLabel(asChat(p)));
    const controls = p.you
        ? `<span class="access-you">${ROLE_LABELS[p.role]}</span>`
        : roleSelect(p) +
          (p.password
              ? `<button type="button" class="btn btn-row" data-action="access-password-remove" data-id="${escapeHtml(p.id)}" aria-label="Remove the password of ${label}" title="Remove password">${keyOff}</button>`
              : '') +
          `<button type="button" class="btn btn-row btn-row-danger" data-action="access-remove" data-id="${escapeHtml(p.id)}" aria-label="Remove access for ${label}">${trash}</button>`;
    return `
        <li class="access-row" data-id="${escapeHtml(p.id)}">
            <span class="access-who">${chatDisplayName(asChat(p))}<span class="access-id">${escapeHtml(p.id)}${p.you ? ' · you' : ''}${p.password ? ' · password' : ''}</span></span>
            <span class="access-controls">${controls}</span>
        </li>`;
}

function render() {
    if (!access) return;
    const list = $('access-list');
    list.innerHTML = access.people.map(personRow).join('');
    enhanceIn(list);

    const pick = $field('access-add-user');
    // A refresh keeps the person picked, while they can still be added
    const picked = access.candidates.some((c) => c.id === pick.value) ? pick.value : access.candidates[0]?.id || '';
    pick.innerHTML = access.candidates.length
        ? access.candidates
              .map(
                  (c) =>
                      `<option value="${escapeHtml(c.id)}">${escapeHtml(chatLabel(asChat(c)))} · ${escapeHtml(c.id)}</option>`
              )
              .join('')
        : '<option value="">Everyone who wrote to the bot has access</option>';
    setSelectValue('access-add-user', picked);
    $('access-add').toggleAttribute('disabled', !access.candidates.length);
    showWanted();
}

/** After "Panel access" in a chat's menu: that person picked to add, or their row marked. */
function showWanted() {
    if (!wanted || !access) return;
    const id = wanted;
    wanted = null;
    const row = all('.access-row').find((r) => r.dataset.id === id);
    if (row) {
        row.classList.add('access-row-wanted');
        row.scrollIntoView({ block: 'center' });
        return;
    }
    if (access.candidates.some((c) => c.id === id)) {
        setSelectValue('access-add-user', id);
        $('access-card').scrollIntoView({ block: 'center' });
    }
}

export async function loadAccess() {
    if (saving) return;
    const next = await api('/access');
    // A save answered meanwhile is newer than this answer
    if (saving) return;
    access = next;
    render();
}

/** Opened from a chat's menu: Settings → Bot shows this person's place in the list. */
function openFor(chatId) {
    wanted = String(chatId);
    pickTab('bot');
}

async function save(userId, role, done) {
    saving += 1;
    try {
        const next = await api('/access', { method: 'POST', body: { userId, role } });
        // Another save still on its way: its answer comes later and is newer
        if (saving === 1) access = next;
        toast(done, 'success');
    } catch (err) {
        toast(err.message, 'error');
    } finally {
        saving -= 1;
        // On a refusal too: a picked role goes back to the saved one. Not while another save is
        // on its way, or its pick would jump back until it answers
        if (!saving) render();
    }
}

const nameOf = (id) => {
    const p = access && [...access.people, ...access.candidates].find((x) => x.id === id);
    return p ? chatLabel(asChat(p)) : id;
};

function add() {
    const id = $field('access-add-user').value;
    const role = $field('access-add-role').value;
    if (!id) return;
    save(id, role, `${nameOf(id)} can sign in as ${ROLE_LABELS[role]}.`);
}

function remove(id) {
    const name = nameOf(id);
    showConfirm({
        title: 'Remove access?',
        text: `${name} won't be able to sign in to the panel, and is signed out now.`,
        confirmLabel: 'Remove',
        onConfirm: () => save(id, 'none', `${name} has no access now.`)
    });
}

function removePassword(id) {
    const name = nameOf(id);
    showConfirm({
        title: 'Remove the password?',
        text: `${name} will sign in with Telegram only, and can set a new password on their account page.`,
        confirmLabel: 'Remove',
        onConfirm: async () => {
            try {
                access = await api(`/access/${encodeURIComponent(id)}/password`, { method: 'DELETE' });
                toast(`${name} has no password now.`, 'success');
            } catch (err) {
                toast(err.message, 'error');
            }
            render();
        }
    });
}

export const accessActions = {
    'access-add': () => add(),
    'access-open': (el) => openFor(el.dataset.id),
    'access-remove': (el) => remove(el.dataset.id),
    'access-password-remove': (el) => removePassword(el.dataset.id)
};

export function setupAccess() {
    $('access-list').addEventListener('change', (e) => {
        const select = /** @type {HTMLSelectElement} */ (e.target);
        if (!select.matches('.access-role')) return;
        const id = select.dataset.id;
        save(id, select.value, `${nameOf(id)} is ${ROLE_LABELS[select.value]} now.`);
    });
}
