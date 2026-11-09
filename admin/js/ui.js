/** Toasts, modals and the confirmation dialog. */

import { $, setText } from './dom.js';
import { closeDropdown, isDropdownOpen } from './select.js';

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
const closing = new WeakMap();
const swipes = new WeakMap();

/** @param {HTMLElement} modal */
function focusables(modal) {
    // tabIndex -1 rules out e.g. the native <select> hidden behind a custom dropdown:
    // focusing it opens the OS picker on iOS the moment the dialog appears
    return /** @type {HTMLElement[]} */ ([...modal.querySelectorAll(FOCUSABLE)]).filter(
        (el) => !el.matches(':disabled') && el.offsetParent !== null && el.tabIndex !== -1
    );
}

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;
export const isPhoneTitleSheet = () => window.matchMedia('(max-width: 640px)').matches;

/** Preserve a card's outer frame while its details expand in the scrolling content. */
export function preserveModalFrame(control) {
    const content = /** @type {HTMLElement | null} */ (control.closest('.modal-content'));
    if (!content || content.style.height) return;
    content.style.height = getComputedStyle(content).height;
    content.dataset.framePinned = 'true';
}

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
    if (isTouch()) {
        // On a touch screen focus isn't handed back: no keyboard goes on from there, and the title
        // or button that was tapped would get a focus ring. Undoes the browser's own return too
        const top = topmostModal();
        if (top) focusInside(top);
        else /** @type {HTMLElement | null} */ (document.activeElement)?.blur();
        return;
    }
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
    // A direct dialog swap finishes outgoing exits before the new dialog takes focus.
    // No delayed opener may survive an Escape pressed during that transition.
    for (const previous of [...openStack]) closing.get(previous)?.finish();
    // Renderers may replace a sheet's contents while it is open; restore its shared indicator too.
    if (modal.classList.contains('modal-sheet')) {
        const sheet = modal.querySelector('.modal-content');
        if (!sheet.querySelector('.sheet-grabber')) {
            const grabber = document.createElement('span');
            grabber.className = 'sheet-grabber';
            grabber.setAttribute('aria-hidden', 'true');
            sheet.prepend(grabber);
        }
        setupSheetSwipe(sheet, modal);
    }
    // Opened again while open (a dialog redrawn after saving): only focus is put back
    if (modal.open) return focusInside(modal);
    // Static card dialogs reuse their content element for another title; start at its natural height.
    const pinned = /** @type {HTMLElement | null} */ (modal.querySelector('.modal-content[data-frame-pinned]'));
    if (pinned) {
        pinned.style.removeProperty('height');
        delete pinned.dataset.framePinned;
    }
    watch(modal);
    // A list open on the page would stay there, under the dim and out of reach
    closeDropdown();

    focusBeforeOpen.set(id, /** @type {HTMLElement} */ (document.activeElement));
    // showModal() focuses the first field itself, which on a touch screen raises the keyboard. It
    // focuses the dialog itself instead: nothing to scroll into view (a box still sliding in would
    // be), and the field gets focus below where that is wanted
    modal.autofocus = true;
    modal.showModal();
    openStack.push(modal);
    placeToasts();
    focusInside(modal);
}

/** @param {HTMLElement} modal */
function focusInside(modal) {
    const content = /** @type {HTMLElement} */ (modal.querySelector('.modal-content') || modal);
    content.tabIndex = -1;
    // On a touch screen focus stays on the box: a field would raise the keyboard, and a button
    // would show a focus ring nobody asked for
    const first = focusables(modal)[0];
    if (first && !isTouch()) first.focus();
    else content.focus({ preventScroll: true });
}

/** @param {string} id
 * @returns {Promise<void> | void} Resolves after an animated exit; other dialogs close synchronously.
 */
export function closeModal(id) {
    const modal = /** @type {HTMLDialogElement | null} */ ($(id));
    if (!modal || !modal.open) return;
    if (closing.has(modal)) return closing.get(modal).done;
    const sheet = /** @type {HTMLElement | null} */ (
        modal.querySelector('.title-sheet, .visibility-sheet') ||
            (isPhoneTitleSheet() && modal.classList.contains('modal-sheet')
                ? modal.querySelector('.modal-content')
                : null)
    );
    if (sheet && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const phone = isPhoneTitleSheet();
        const slide = sheet.animate(
            [
                { transform: getComputedStyle(sheet).transform },
                { transform: phone ? `translateY(${window.innerHeight}px)` : 'scale(0.97)' }
            ],
            { duration: phone ? 260 : 150, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }
        );
        const fade = modal.animate([{ opacity: getComputedStyle(modal).opacity }, { opacity: 0 }], {
            duration: phone ? 260 : 150,
            easing: 'ease-in',
            fill: 'forwards'
        });
        modal.inert = true;
        const finish = () => {
            if (closing.get(modal)?.finish !== finish) return;
            closing.delete(modal);
            modal.close();
            slide.cancel();
            fade.cancel();
            sheet.style.removeProperty('transform');
            modal.inert = false;
            afterClose(modal);
        };
        const done = slide.finished.then(finish, finish);
        closing.set(modal, { finish, done });
        return done;
    }
    modal.close();
    // The close event comes later; the stack and focus are settled now
    afterClose(modal);
}

/** @returns {HTMLElement | null} The dialog on top: the last one opened. */
export function topmostModal() {
    return openStack.length ? openStack[openStack.length - 1] : null;
}

const isAnyModalOpen = () => openStack.length > 0;

/**
 * Escape, or Telegram's Back in the Mini App: closes the innermost layer, an open list before the
 * dialog under it, and a child dialog as its Cancel would (back to its menu).
 * @returns {boolean} whether there was a layer to close
 */
export function dismissTopLayer() {
    if (isDropdownOpen()) {
        closeDropdown();
        return true;
    }
    const modal = topmostModal();
    if (!modal) return false;
    closeModalReturning(modal.id);
    return true;
}

// How to reopen the parent menu when a child modal is dismissed, or null.
// A callback rather than an id, so any menu can be returned to.
let returnTo = null;

export const setReturnTo = (fn) => {
    returnTo = fn;
};
export const clearReturnTo = () => {
    returnTo = null;
};

/** Close the entire chat action flow from its backdrop or close button. */
export function dismissChatModals() {
    if (!openStack.some((modal) => modal.hasAttribute('data-dismiss-stack'))) return false;
    clearReturnTo();
    // Title-sheet exits are asynchronous; traverse a snapshot instead of waiting for stack removal.
    const origin = focusBeforeOpen.get(openStack[0].id);
    for (const modal of [...openStack].reverse()) {
        // The last exit must restore the page control, not a field in an already closed parent.
        focusBeforeOpen.set(modal.id, origin);
        closeModal(modal.id);
    }
    return true;
}

/**
 * Dismissing a modal opened from a menu goes back to that menu instead of
 * dropping the user all the way out.
 *
 * @param {string} id
 */
export function closeModalReturning(id) {
    // A preview on top of an open search returns to that search. Keep its own
    // return callback intact for when the search itself is dismissed.
    const hasParent = openStack.length > 1 && topmostModal()?.id === id;
    closeModal(id);
    if (hasParent) return;
    const back = returnTo;
    returnTo = null;
    if (back) back();
}

/**
 * Confirmation dialog. The safe choice ("No") is the visually dominant one.
 *
 * @param {{ title?: string, text: string, confirmLabel?: string, cancelLabel?: string,
 *           dismissStack?: boolean, onConfirm: () => void | Promise<void> }} options
 */
export function showConfirm({
    title = 'Are you sure?',
    text,
    confirmLabel = 'Yes',
    cancelLabel = 'No, cancel',
    dismissStack = false,
    onConfirm
}) {
    setText('confirm-title', title);
    setText('confirm-text', text);

    const confirmBtn = $('modal-confirm-btn');
    const cancelBtn = $('modal-cancel-btn');
    $('confirm-modal').toggleAttribute('data-dismiss-stack', dismissStack);
    $('modal-confirm-close').hidden = !dismissStack;
    confirmBtn.innerText = confirmLabel;
    cancelBtn.innerText = cancelLabel;

    confirmBtn.onclick = async () => {
        // Done: a pending return to the menu that opened this would fire on some later dialog
        clearReturnTo();
        closeModal('confirm-modal');
        await onConfirm();
    };
    // Like Escape: back to the menu this was opened from, if any
    cancelBtn.onclick = () => closeModalReturning('confirm-modal');

    openModal('confirm-modal');
    // Land on the safe choice, not the destructive one (for the keyboard: no ring on a touch screen)
    if (!isTouch()) cancelBtn.focus();
}

// --- On-screen keyboard ---
// How much shorter the visible area must get with a text field focused to count as a keyboard
const KEYBOARD_MIN = 120;
const TEXT_FIELD = 'input:not([type="checkbox"], [type="radio"], [type="range"], [type="button"]), textarea';

/**
 * Marks `html.keyboard-open` while an on-screen keyboard covers the page: a text field has focus and
 * the visible height dropped well below the tallest seen at this width. The fixed tab bar hides then
 * (responsive.css), instead of riding on top of the keyboard. Focus alone is not enough: a tablet
 * with a hardware keyboard keeps its full height and its tab bar.
 */
export function setupKeyboardWatch() {
    const viewport = window.visualViewport;
    let width = 0;
    let tallest = 0;
    const update = () => {
        const height = viewport ? viewport.height : window.innerHeight;
        if (window.innerWidth !== width) {
            width = window.innerWidth;
            tallest = height;
        }
        tallest = Math.max(tallest, height);
        const typing = document.activeElement?.matches(TEXT_FIELD) ?? false;
        document.documentElement.classList.toggle('keyboard-open', typing && height < tallest - KEYBOARD_MIN);
    };
    (viewport || window).addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', () => window.requestAnimationFrame(update));
    update();
}

/** Native content scrolling owns its whole gesture; only a downward pull from the top moves the sheet. */
function setupSheetSwipe(sheet, modal) {
    if (swipes.get(modal)?.sheet === sheet) return;
    swipes.get(modal)?.reset();
    let drag = null;
    let returning = null;
    let blockClickUntil = 0;
    const reset = () => {
        returning?.cancel();
        returning = null;
        sheet.style.removeProperty('transform');
        sheet.classList.remove('tc-dragging');
        drag = null;
    };
    const settle = () => {
        drag = null;
        sheet.classList.remove('tc-dragging');
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return reset();
        const from = getComputedStyle(sheet).transform;
        returning?.cancel();
        const animation = sheet.animate([{ transform: from }, { transform: 'translateY(0)' }], {
            duration: 280,
            easing: 'cubic-bezier(.2,.7,.3,1)',
            fill: 'forwards'
        });
        returning = animation;
        animation.finished.then(
            () => returning === animation && reset(),
            () => {}
        );
    };
    const interrupt = () => {
        if (drag?.mode === 'drag') settle();
        else drag = null;
    };
    swipes.set(modal, { sheet, reset, interrupt });
    if (!modal.dataset.sheetSwipeWatched) {
        modal.dataset.sheetSwipeWatched = 'true';
        // A second finger can land on the exposed backdrop, outside the moving sheet.
        modal.addEventListener(
            'touchstart',
            (event) => {
                if (event.touches.length > 1) swipes.get(modal)?.interrupt();
            },
            { capture: true, passive: true }
        );
        // These modal listeners refer only to its current sheet, not every replaced card.
        modal.addEventListener('close', () => !modal.open && swipes.get(modal)?.reset());
    }
    sheet.addEventListener(
        'touchstart',
        (event) => {
            if (!isPhoneTitleSheet()) return;
            if (event.touches.length !== 1) {
                return interrupt();
            }
            if (topmostModal() !== modal || modal.inert) return;
            const offset = returning ? new window.DOMMatrixReadOnly(getComputedStyle(sheet).transform).m42 : 0;
            reset();
            blockClickUntil = 0;
            if (offset) {
                sheet.style.transform = `translateY(${offset}px)`;
                sheet.classList.add('tc-dragging');
            }
            let scrolled = false;
            for (let node = event.target; node; node = node.parentElement) {
                if (node.scrollTop > 1) scrolled = true;
                if (node === sheet) break;
            }
            const touch = event.touches[0];
            drag = {
                id: touch.identifier,
                x: touch.clientX,
                y: touch.clientY,
                offset,
                distance: offset,
                height: sheet.clientHeight,
                mode: offset > 0 ? 'drag' : scrolled ? 'native' : null
            };
        },
        { passive: true }
    );
    sheet.addEventListener(
        'touchmove',
        (event) => {
            if (!drag) return;
            if (event.touches.length !== 1) return interrupt();
            if (drag.mode === 'native') return;
            const touch = event.touches[0];
            if (touch.identifier !== drag.id) return;
            if (topmostModal() !== modal) return settle();
            const dx = touch.clientX - drag.x;
            const dy = touch.clientY - drag.y;
            if (drag.mode !== 'drag') {
                // Ignore small direction jitter before committing to either scrolling or dismissal.
                if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
                if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || !event.cancelable) {
                    drag.mode = 'native';
                    return;
                }
                drag.mode = 'drag';
                sheet.classList.add('tc-dragging');
            }
            if (!event.cancelable) return settle();
            event.preventDefault();
            blockClickUntil = performance.now() + 500;
            drag.distance = Math.max(0, drag.offset + dy);
            // No layout reads or scrollTop writes on movement: content keeps the browser's scrolling/inertia.
            sheet.style.transform = `translate3d(0, ${drag.distance}px, 0)`;
        },
        { passive: false }
    );
    sheet.addEventListener('touchend', (event) => {
        if (!drag || ![...event.changedTouches].some((touch) => touch.identifier === drag.id)) return;
        if (event.touches.length) return interrupt();
        if (drag.mode !== 'drag') {
            drag = null;
            return;
        }
        const dismiss = drag.distance >= drag.height * 0.3;
        drag = null;
        sheet.classList.remove('tc-dragging');
        if (dismiss && topmostModal() === modal) {
            if (!dismissChatModals()) closeModalReturning(modal.id);
        } else settle();
    });
    sheet.addEventListener('touchcancel', interrupt);
    sheet.addEventListener(
        'click',
        (event) => {
            if (performance.now() < blockClickUntil) {
                event.preventDefault();
                event.stopPropagation();
            }
        },
        true
    );
}
