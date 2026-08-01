/** Toasts, modals and the confirmation dialog. */

import { $, setText } from './dom.js';

// --- Toasts ---
/**
 * @param {string} message
 * @param {'info' | 'success' | 'warning' | 'error'} [type]
 */
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
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Modal id -> the element that had focus when it opened, so it can be given back. */
const focusBeforeOpen = new Map();

/** @param {HTMLElement} modal */
function focusables(modal) {
    return /** @type {HTMLElement[]} */ ([...modal.querySelectorAll(FOCUSABLE)]).filter(
        (el) => !el.hasAttribute('disabled') && el.offsetParent !== null
    );
}

/**
 * Keeps Tab inside the dialog. Without it focus walks off into the page
 * behind the backdrop, which a keyboard or screen-reader user cannot see.
 *
 * @param {KeyboardEvent} e
 */
function trapTab(e) {
    if (e.key !== 'Tab') return;
    const modal = /** @type {HTMLElement} */ (e.currentTarget);
    const items = focusables(modal);
    if (items.length === 0) return;

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
    }
}

/** @param {string} id */
export function openModal(id) {
    const modal = $(id);
    if (!modal) return;

    focusBeforeOpen.set(id, /** @type {HTMLElement} */ (document.activeElement));
    modal.style.display = 'flex';
    modal.addEventListener('keydown', trapTab);

    const first = focusables(modal)[0];
    if (first) first.focus();
}

/** @param {string} id */
export function closeModal(id) {
    const modal = $(id);
    if (!modal) return;

    modal.style.display = 'none';
    modal.removeEventListener('keydown', trapTab);

    const previous = focusBeforeOpen.get(id);
    focusBeforeOpen.delete(id);
    // Only restore if the element is still on the page and nothing else took over
    if (previous && previous.isConnected && !isAnyModalOpen()) previous.focus();
}

/** @returns {HTMLElement | null} The dialog on top, i.e. the last open one in DOM order. */
export function topmostModal() {
    const open = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.modal')]).filter(
        (m) => m.style.display === 'flex'
    );
    return open.length ? open[open.length - 1] : null;
}

const isAnyModalOpen = () => topmostModal() !== null;

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
 *
 * @param {string} id
 */
export function closeModalReturning(id) {
    closeModal(id);
    const back = returnTo;
    returnTo = null;
    if (back) back();
}

/**
 * Confirmation dialog. The safe choice ("No") is the visually dominant one.
 *
 * @param {{ title?: string, text: string, confirmLabel?: string, cancelLabel?: string,
 *           onConfirm: () => void | Promise<void> }} options
 */
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
    // Land on the safe choice, not the destructive one
    cancelBtn.focus();
}
