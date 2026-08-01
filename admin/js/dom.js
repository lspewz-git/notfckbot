/** Thin DOM helpers shared by every module. Depends on nothing. */

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
export const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * Same lookup, typed as a form control. Using it instead of `$` documents at
 * the call site that the element is expected to carry a value.
 *
 * @param {string} id
 * @returns {HTMLInputElement}
 */
export const $field = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

/**
 * @param {string} id
 * @returns {HTMLImageElement}
 */
export const $img = (id) => /** @type {HTMLImageElement} */ (document.getElementById(id));

/**
 * The element an event handler is attached to, typed as a button — every
 * current caller uses it to toggle `disabled` or a class.
 *
 * @param {Event} event
 * @returns {HTMLButtonElement}
 */
export const target = (event) => /** @type {HTMLButtonElement} */ (event.currentTarget);

/**
 * The element a delegated handler should act on.
 *
 * @param {Event} event
 * @param {string} selector
 * @returns {HTMLElement | null}
 */
export const closest = (event, selector) =>
    /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest(selector));

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {HTMLElement[]}
 */
export const all = (selector, root = document) =>
    /** @type {HTMLElement[]} */ ([...root.querySelectorAll(selector)]);

/**
 * @param {string} id
 * @param {string | number} text
 */
export function setText(id, text) {
    const el = $(id);
    if (el) el.innerText = String(text);
}

/**
 * @param {string} id
 * @param {string} text
 * @param {string} type
 */
export function updateBadge(id, text, type) {
    const el = $(id);
    if (!el) return;
    el.innerText = text;
    el.className = `badge ${type}`;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * @param {unknown} str
 * @returns {string}
 */
export function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * @template {(...args: any[]) => void} F
 * @param {F} fn
 * @param {number} wait
 * @returns {(...args: Parameters<F>) => void}
 */
export function debounce(fn, wait) {
    /** @type {ReturnType<typeof setTimeout>} */
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), wait);
    };
}
