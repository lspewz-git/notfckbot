/** Pages for the long tables: the page size (remembered per table), the current page, the pager. */

import { $ } from './dom.js';
import { TABLES } from './table-defs.js';

const PAGE_SIZES = [10, 25, 50, 100];
const PAGE_SIZE_KEY = 'admin.pageSize.';

function storedPageSize(type) {
    try {
        const n = Number(localStorage.getItem(PAGE_SIZE_KEY + type));
        return PAGE_SIZES.includes(n) ? n : PAGE_SIZES[0];
    } catch {
        return PAGE_SIZES[0];
    }
}

// Per paged table: { page (1-based), size }
const pageState = Object.fromEntries(
    Object.entries(TABLES)
        .filter(([, t]) => t.paged)
        .map(([type]) => [type, { page: 1, size: storedPageSize(type) }])
);

export const resetPage = (type) => {
    if (pageState[type]) pageState[type].page = 1;
};

/** "11–20 of 34" and the arrows; hidden while there is nothing to page through. */
export function renderPager(type, total) {
    const el = $(`${type}-pager`);
    const state = pageState[type];
    if (!el || !state) return;
    el.hidden = total === 0;
    const pages = Math.max(1, Math.ceil(total / state.size));
    const start = (state.page - 1) * state.size;
    el.querySelector('.pager-info').textContent = `${start + 1}–${Math.min(start + state.size, total)} of ${total}`;
    el.querySelectorAll('[data-step]').forEach((btn) => {
        const step = Number(/** @type {HTMLElement} */ (btn).dataset.step);
        /** @type {HTMLButtonElement} */ (btn).disabled = step < 0 ? state.page <= 1 : state.page >= pages;
    });
}

export const pageSizeOf = (type) => pageState[type] && pageState[type].size;

/** The slice of `matched` on the current page; all of it for an unpaged table. */
export function currentPage(type, matched) {
    const state = pageState[type];
    if (!state) return matched;
    // Clamp: an auto-refresh or a delete can leave fewer pages than before
    state.page = Math.min(state.page, Math.max(1, Math.ceil(matched.length / state.size)));
    const start = (state.page - 1) * state.size;
    return matched.slice(start, start + state.size);
}

/** Moves `step` pages (not below the first); false for an unpaged table. */
export function stepPage(type, step) {
    const state = pageState[type];
    if (!state) return false;
    state.page = Math.max(1, state.page + step);
    return true;
}

/**
 * After the new page is on screen: brings the table's top into view, and moves focus to the
 * other arrow if `pressed` (the arrow that turned the page) is now disabled.
 * @param {string} type
 * @param {HTMLButtonElement | null} pressed
 */
export function afterPageTurn(type, pressed) {
    // On a phone the pager sits several screens below the first card of the new page
    const card = $(TABLES[type].body).closest('.glass-card');
    // An instant jump, like turning a page; a smooth scroll over several screens only delays it
    if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: 'start' });

    // The arrow just pressed may now be disabled, which drops focus to <body>; hand it to the other one
    if (pressed && pressed.disabled && pressed.dataset.step) {
        const other = /** @type {HTMLButtonElement | null} */ (
            $(`${type}-pager`).querySelector(`[data-step="${-Number(pressed.dataset.step)}"]`)
        );
        if (other && !other.disabled) other.focus({ preventScroll: true });
    }
}

/** Remembers the new size and starts from page 1; false for an unknown table or size. */
export function setPageSize(type, size) {
    const state = pageState[type];
    if (!state || !PAGE_SIZES.includes(size)) return false;
    state.size = size;
    state.page = 1;
    try {
        localStorage.setItem(PAGE_SIZE_KEY + type, String(size));
    } catch {
        // Private mode: the choice just isn't remembered
    }
    return true;
}
