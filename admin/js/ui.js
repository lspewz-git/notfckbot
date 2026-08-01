/** Toasts, modals and the confirmation dialog. */

import { $, setText } from './dom.js';

// --- Toasts ---
export function toast(message, type = 'info') {
    const container = $('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerText = message;
    container.appendChild(el);

    setTimeout(() => {
        el.classList.add('toast-out');
        setTimeout(() => el.remove(), 300);
    }, 3500);
}

// --- Modals ---
export const openModal = (id) => {
    $(id).style.display = 'flex';
};
export const closeModal = (id) => {
    $(id).style.display = 'none';
};

// How to reopen the parent menu when a child modal is dismissed, or null.
// A callback rather than an id, so any menu can be returned to.
let returnTo = null;

export const setReturnTo = (fn) => {
    returnTo = fn;
};
export const clearReturnTo = () => {
    returnTo = null;
};

/**
 * Dismissing a modal opened from a menu goes back to that menu instead of
 * dropping the user all the way out.
 */
export function closeModalReturning(id) {
    closeModal(id);
    const back = returnTo;
    returnTo = null;
    if (back) back();
}

/** Confirmation dialog. The safe choice ("No") is the visually dominant one. */
export function showConfirm({
    title = 'Are you sure?',
    text,
    confirmLabel = 'Yes',
    cancelLabel = 'No, cancel',
    onConfirm
}) {
    setText('confirm-title', title);
    setText('confirm-text', text);

    const confirmBtn = $('modal-confirm-btn');
    const cancelBtn = $('modal-cancel-btn');
    confirmBtn.innerText = confirmLabel;
    cancelBtn.innerText = cancelLabel;

    confirmBtn.onclick = async () => {
        closeModal('confirm-modal');
        await onConfirm();
    };
    cancelBtn.onclick = () => closeModal('confirm-modal');

    openModal('confirm-modal');
    cancelBtn.focus();
}
