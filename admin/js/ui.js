/** Toasts, modals and the confirmation dialog. */

import { $, setText } from './dom.js';
import { closeDropdown } from './select.js';

// --- Toasts ---
/**
 * @param {string} message
 * @param {'info' | 'success' | 'warning' | 'error'} [type]
 */
/** @param {number} [ms] how long it stays: longer for a message with several parts to read */
export function toast(message, type = 'info', ms = 3500) {
    const container = $('toast-container');
    if (!container) return;

    placeToasts();
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerText = message;
    // Once in, it stays put: moving the container into or out of a dialog would replay it
    el.addEventListener('animationend', () => (el.style.animation = 'none'), { once: true });
    container.appendChild(el);

    setTimeout(() => {
        el.classList.add('toast-out');
        setTimeout(() => el.remove(), 300);
    }, ms);
}

// --- Modals ---
// Native <dialog>s opened with showModal(): the browser puts the dialog above everything, keeps the
// page behind out of reach of the mouse, Tab and screen readers, and asks to close it on Escape.
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Open dialogs, in the order they were opened: the last one is on top. */
const openStack = [];

/** Modal id -> the element that had focus when it opened, so it can be given back. */
const focusBeforeOpen = new Map();

/** @param {HTMLElement} modal */
function focusables(modal) {
    // tabIndex -1 rules out e.g. the native <select> hidden behind a custom dropdown:
    // focusing it opens the OS picker on iOS the moment the dialog appears
    return /** @type {HTMLElement[]} */ ([...modal.querySelectorAll(FOCUSABLE)]).filter(
        (el) => !el.hasAttribute('disabled') && el.offsetParent !== null && el.tabIndex !== -1
    );
}

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

/**
 * Focus a field for typing, except on touch screens: there focus opens the
 * on-screen keyboard (or the OS picker) and scrolls the page under it, which a
 * user who just opened a dialog did not ask for.
 *
 * @param {HTMLElement | null} el
 */
export function focusField(el) {
    if (el && !isTouch()) el.focus();
}

/**
 * Toasts live in the dialog on top while one is open: everything outside it sits under the dim
 * and can't be seen. Back on the page once the last dialog closes.
 */
function placeToasts() {
    const container = $('toast-container');
    const host = topmostModal() || document.body;
    if (container && container.parentElement !== host) host.appendChild(container);
}

/** What closing a dialog takes care of, however it was closed (by the panel or the browser). */
function afterClose(modal) {
    const at = openStack.indexOf(modal);
    if (at === -1) return;
    openStack.splice(at, 1);
    // A list left open in it would stay behind, hidden, and take the next Escape
    closeDropdown();
    placeToasts();
    const previous = focusBeforeOpen.get(modal.id);
    focusBeforeOpen.delete(modal.id);
    // Only restore if the element is still on the page and nothing else took over
    if (previous && previous.isConnected && !isAnyModalOpen()) previous.focus();
}

/** Once per dialog: the browser's own close (Escape) goes through the same steps as the panel's. */
function watch(modal) {
    if (modal.dataset.watched) return;
    modal.dataset.watched = 'true';
    // Escape: like Cancel, back to the menu this was opened from. The key itself is handled in
    // app.js, whose preventDefault() keeps this event from firing; it still comes from the
    // Android back gesture and other close requests that aren't a key
    modal.addEventListener('cancel', (e) => {
        e.preventDefault();
        closeModalReturning(modal.id);
    });
    // Late, after the panel's own close: a dialog opened again meanwhile stays on the stack
    modal.addEventListener('close', () => !modal.open && afterClose(modal));
}

/** @param {string} id */
export function openModal(id) {
    const modal = /** @type {HTMLDialogElement | null} */ ($(id));
    if (!modal) return;
    // Opened again while open (a dialog redrawn after saving): only focus is put back
    if (modal.open) return focusInside(modal);
    watch(modal);
    // A list open on the page would stay there, under the dim and out of reach
    closeDropdown();

    focusBeforeOpen.set(id, /** @type {HTMLElement} */ (document.activeElement));
    // showModal() focuses the first field itself, which on a touch screen raises the keyboard:
    // it lands on the dialog's box instead, and the field gets focus below where that is wanted
    const content = /** @type {HTMLElement} */ (modal.querySelector('.modal-content') || modal);
    content.tabIndex = -1;
    content.autofocus = true;
    modal.showModal();
    openStack.push(modal);
    placeToasts();
    focusInside(modal);
}

/** @param {HTMLElement} modal */
function focusInside(modal) {
    const content = /** @type {HTMLElement} */ (modal.querySelector('.modal-content') || modal);
    // On a touch screen focus stays on the box: a field would raise the keyboard, and a button
    // would show a focus ring nobody asked for
    const first = focusables(modal)[0];
    if (first && !isTouch()) first.focus();
    else content.focus({ preventScroll: true });
}

/** @param {string} id */
export function closeModal(id) {
    const modal = /** @type {HTMLDialogElement | null} */ ($(id));
    if (!modal || !modal.open) return;
    modal.close();
    // The close event comes later; the stack and focus are settled now
    afterClose(modal);
}

/** @returns {HTMLElement | null} The dialog on top: the last one opened. */
export function topmostModal() {
    return openStack.length ? openStack[openStack.length - 1] : null;
}

const isAnyModalOpen = () => openStack.length > 0;

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
        // Done: a pending return to the menu that opened this would fire on some later dialog
        clearReturnTo();
        closeModal('confirm-modal');
        await onConfirm();
    };
    // Like Escape and the backdrop: back to the menu this was opened from, if any
    cancelBtn.onclick = () => closeModalReturning('confirm-modal');

    openModal('confirm-modal');
    // Land on the safe choice, not the destructive one (for the keyboard: no ring on a touch screen)
    if (!isTouch()) cancelBtn.focus();
}
