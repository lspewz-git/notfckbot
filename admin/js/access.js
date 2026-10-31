/**
 * Panel access (src/admin/routes/access.js): a person's role from Users → Actions → Panel access,
 * saved when picked; in Settings → Bot the sign-up switch and the system account's password.
 * Everything applies at once, no restart.
 */

import { $, $field, setText } from './dom.js';
import { api } from './api.js';
import { toast, showConfirm, closeModal } from './ui.js';
import { mutate } from './data.js';
import { chatLabel } from './format.js';
import { setSelectValue } from './select.js';
import { chatsById } from './store.js';
import { signedInUser, openPasswordDialog } from './password.js';

export const ROLE_LABELS = { admin: 'Admin', user: 'User', none: 'No access' };

/** The role pill next to a chat's name in Users. Nothing for someone without a role (sign-up closed). */
export const roleBadge = (role) =>
    ROLE_LABELS[role]
        ? ` <span class="badge ${role === 'admin' ? 'warn' : role === 'none' ? 'error' : 'muted'} access-badge">${ROLE_LABELS[role]}</span>`
        : '';

// --- Users → Actions: the person's role and password ---

/** Fills the menu's Panel access row and the password row for this chat (chats.js). */
export function showAccessIn(chat) {
    const person = chat.type === 'private';
    $('action-access').hidden = !person;
    $('action-password-remove').hidden = !person || !chat.hasPassword;
    if (!person) return;
    const me = signedInUser();
    const you = Boolean(me && me.id === String(chat.id));
    $field('action-access-role').dataset.id = String(chat.id);
    // setSelectValue fires "change": saveRole skips a value that is the saved one
    setSelectValue('action-access-role', chat.panelRole || 'none');
    // Your own role: shown, not offered (the dropdown has no disabled state)
    $('action-access').classList.toggle('action-row-you', you);
    setText(
        'action-access-desc',
        you ? `${ROLE_LABELS[chat.panelRole] || 'No access'} · yours, can't be changed here` : 'Saved when picked'
    );
    $('action-password-remove').dataset.id = String(chat.id);
}

async function saveRole(select) {
    const userId = select.dataset.id;
    const chat = chatsById.get(userId);
    const role = select.value;
    if (!chat || role === (chat.panelRole || 'none')) return;
    const name = chatLabel(chat);
    const done = await mutate(
        '/access',
        { method: 'POST', body: { userId, role } },
        role === 'none' ? `${name} has no access now.` : `${name} is ${ROLE_LABELS[role]} now.`
    );
    if (done) {
        chat.panelRole = done.role;
        if (role === 'none') chat.hasPassword = false;
    }
    // Refused, the pick goes back to the saved role
    showAccessIn(chat);
}

function removePassword(id) {
    const chat = chatsById.get(id);
    const name = chat ? chatLabel(chat) : id;
    closeModal('chat-actions-modal');
    showConfirm({
        title: 'Remove the password?',
        text: `${name} is signed out everywhere and will sign in with Telegram only. They can set a new password on their account page.`,
        confirmLabel: 'Remove',
        onConfirm: async () => {
            await mutate(
                `/access/${encodeURIComponent(id)}/password`,
                { method: 'DELETE' },
                `${name} has no password now.`
            );
        }
    });
}

// --- Settings → Bot → Panel access ---

/** @type {{ openSignup: boolean, system: { login: string, passwordSet: boolean } } | null} */
let access = null;

function render() {
    if (!access) return;
    $('access-signup').setAttribute('aria-checked', String(access.openSignup));
    setText('access-system-login', access.system.login);
    setText('access-system-state', access.system.passwordSet ? 'Password set' : "No password: it can't sign in");
    setText('access-system-password', access.system.passwordSet ? 'Change password' : 'Set password');
}

export async function loadAccess() {
    access = await api('/access');
    render();
}

async function toggleSignup() {
    if (!access) return;
    const open = !access.openSignup;
    try {
        access = await api('/access/signup', { method: 'PUT', body: { open } });
        toast(
            open ? 'Anyone who starts the bot can sign in now.' : 'Only people with a role can sign in now.',
            'success'
        );
    } catch (err) {
        toast(err.message, 'error');
    }
    render();
}

function systemPassword() {
    if (!access) return;
    openPasswordDialog({
        title: `Password for "${access.system.login}"`,
        sub: "The system account isn't tied to Telegram: the way in when every other is lost.",
        hint: 'At least 8 characters. Its other sessions end.',
        save: async (password) => {
            access = await api('/access/system-password', { method: 'PUT', body: { password } });
            render();
            toast('System account password saved', 'success');
        }
    });
}

export const accessActions = {
    'access-signup': () => toggleSignup(),
    'access-system-password': () => systemPassword(),
    'access-password-remove': (el) => removePassword(el.dataset.id)
};

export function setupAccess() {
    $field('action-access-role').addEventListener('change', (e) =>
        saveRole(/** @type {HTMLSelectElement} */ (e.target))
    );
}
