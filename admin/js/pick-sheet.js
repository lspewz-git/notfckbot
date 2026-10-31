/**
 * Choosing one of a few: a sheet from the bottom edge on phones, a small dialog elsewhere
 * (`#pick-modal`, `.modal-sheet`). Rows can carry a letter avatar and a line under the title;
 * the current one is marked. Used by the account pages for the chat and the chat's settings.
 */

import { $, escapeHtml } from './dom.js';
import { openModal, closeModal } from './ui.js';

const CHECK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>';

/**
 * The first letter of a name, for its round avatar (an emoji counts as one). A Telegram username's
 * leading at sign is skipped: every avatar would show it otherwise
 */
export function initial(name) {
    const letters = Array.from(
        String(name || '')
            .trim()
            .replace(/^@+/, '')
    );
    return (letters[0] || '?').toUpperCase();
}

/** A letter avatar; `accent` marks the user's own chat */
export const avatar = (name, accent = false) =>
    `<span class="pick-avatar${accent ? ' pick-avatar-accent' : ''}" aria-hidden="true">${escapeHtml(initial(name))}</span>`;

/** @type {((value: string) => void) | null} */
let onPicked = null;
/** @type {string[]} */
let values = [];

/**
 * @param {{
 *   title: string,
 *   options: { value: string, label: string, hint?: string, avatar?: string }[],
 *   value: string,
 *   onPick: (value: string) => void
 * }} spec  `avatar` is ready markup from `avatar()`; `onPick` runs only for another value
 */
export function pickFrom({ title, options, value, onPick }) {
    $('pick-title').textContent = title;
    values = options.map((o) => String(o.value));
    $('pick-list').innerHTML = options
        .map((o, i) => {
            const on = String(o.value) === String(value);
            return (
                `<button type="button" class="action-row pick-row${on ? ' selected' : ''}" role="option" aria-selected="${on}" data-action="pick" data-index="${i}">` +
                (o.avatar || '') +
                `<span class="action-text"><span class="action-title">${escapeHtml(o.label)}</span>` +
                (o.hint ? `<span class="action-desc">${escapeHtml(o.hint)}</span>` : '') +
                '</span>' +
                (on ? `<span class="pick-check">${CHECK}</span>` : '') +
                '</button>'
            );
        })
        .join('');
    onPicked = (picked) => {
        if (picked !== String(value)) onPick(picked);
    };
    openModal('pick-modal');
}

/** Click handlers, merged into app.js's delegation like the other modules' */
export const pickActions = {
    pick: (el) => {
        const picked = values[Number(el.dataset.index)];
        const done = onPicked;
        onPicked = null;
        closeModal('pick-modal');
        if (done && picked !== undefined) done(picked);
    }
};
