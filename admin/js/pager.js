/** Pages for the long tables: the page size (remembered per table), the current page, the pager. */

import { $, escapeHtml } from './dom.js';
import { TABLES } from './table-defs.js';

export const PAGE_SIZES = [10, 25, 50, 100];
const PAGE_SIZE_KEY = 'admin.pageSize.';

function storedPageSize(type) {
    try {
        const n = Number(localStorage.getItem(PAGE_SIZE_KEY + type));
        return PAGE_SIZES.includes(n) ? n : PAGE_SIZES[0];
    } catch {
        return PAGE_SIZES[0];
    }
}

const ARROWS = [
    [-1, 'Previous page', 'm15 18-6-6 6-6'],
    [1, 'Next page', 'm9 18 6-6-6-6']
];

/**
 * Every pager's markup, from one template: the size select, "11–20 of 34", the arrows. The
 * container names what it pages: data-pager="films" (a table) or "history-series" (a History
 * list), and data-pager-label the select for screen readers. Runs before anything reads the
 * selects (setupFilters, setupHistory, enhanceSelects).
 */
export function fillPagers() {
    document.querySelectorAll('.pager[data-pager]').forEach((el) => {
        const { pager = '', pagerLabel = '' } = /** @type {HTMLElement} */ (el).dataset;
        const history = pager.startsWith('history-');
        const name = escapeHtml(history ? pager.slice('history-'.length) : pager);
        const sizeAttr = history ? 'data-history-size' : 'data-page-size';
        const target = history
            ? `data-action="history-page" data-list="${name}"`
            : `data-action="page" data-table="${name}"`;
        el.innerHTML = `
            <div class="pager-size">
                <span class="pager-label">Rows per page</span>
                <select class="select-field" ${sizeAttr}="${name}" aria-label="${escapeHtml(pagerLabel)}">
                    ${PAGE_SIZES.map((n) => `<option value="${n}">${n}</option>`).join('')}
                </select>
            </div>
            <span class="pager-info" aria-live="polite"></span>
            <div class="pager-nav">
                ${ARROWS.map(
                    ([step, label, path]) => `
                    <button class="btn btn-ghost btn-icon" ${target} data-step="${step}" aria-label="${label}">
                        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" /></svg>
                    </button>`
                ).join('')}
            </div>`;
    });
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
