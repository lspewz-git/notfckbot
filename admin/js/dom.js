/** Thin DOM helpers shared by every module. Depends on nothing. */

export const $ = (id) => document.getElementById(id);

export function setText(id, text) {
    const el = $(id);
    if (el) el.innerText = text;
}

export function updateBadge(id, text, type) {
    const el = $(id);
    if (!el) return;
    el.innerText = text;
    el.className = `badge ${type}`;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

export function debounce(fn, wait) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), wait);
    };
}
