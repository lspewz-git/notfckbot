/** Shared chat chips and rows; callers supply only the chats their role can access. */
import { $, escapeHtml } from './dom.js';
import { avatar } from './pick-sheet.js';
import { openModal, closeModal } from './ui.js';

const CHECK = '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" /></svg>';
const DOWN = '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9" /></svg>';

export function chatChip({ title, accent = false, action, label = title }) {
    return `<button type="button" class="mine-chat-chip" data-action="${action}" aria-haspopup="dialog" aria-label="${escapeHtml(label)}">${avatar(title, accent)}<span class="mine-chat-chip-name">${escapeHtml(title)}</span>${DOWN}</button>`;
}

export function chatRows(chats, selected, action) {
    return chats
        .map((c) => {
            const on = String(c.id) === String(selected);
            const state =
                action === 'chat-picker-select' ? `role="option" aria-selected="${on}"` : `aria-pressed="${on}"`;
            return `<button type="button" class="action-row pick-row${on ? ' selected' : ''}" data-action="${action}" data-id="${escapeHtml(c.id)}" ${state}>${avatar(c.title, c.type === 'private')}<span class="action-text"><span class="action-title">${escapeHtml(c.title)}</span>${c.hint ? `<span class="action-desc">${escapeHtml(c.hint)}</span>` : ''}</span>${on ? `<span class="pick-check">${CHECK}</span>` : ''}</button>`;
        })
        .join('');
}

let choose = null;

export function openChatPicker(chats, selected, onPick) {
    $('pick-title').textContent = 'Choose a chat';
    $('pick-list').innerHTML =
        chatRows(chats, selected, 'chat-picker-select') || '<p class="empty-note">No chats yet.</p>';
    choose = (id) => {
        if (chats.some((c) => String(c.id) === id)) onPick(id);
    };
    openModal('pick-modal');
}

export const chatPickerActions = {
    'chat-picker-select': (el) => {
        const done = choose;
        choose = null;
        closeModal('pick-modal');
        if (done) done(el.dataset.id);
    }
};
