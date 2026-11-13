/** Shared chat chips and rows; callers supply only the chats their role can access. */
import { $, $field, escapeHtml } from './dom.js';
import { avatar } from './pick-sheet.js';
import { openModal, closeModal } from './ui.js';

const CHECK = '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#i-check" /></svg>';
const DOWN =
    '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><use href="#i-chevron-down" /></svg>';

/** `letterOf`: whose first letter the avatar shows (the person's own name for their private chat) */
export function chatChip({ title, accent = false, action, label = title, letterOf = title }) {
    return `<button type="button" class="mine-chat-chip" data-action="${action}" aria-haspopup="dialog" aria-label="${escapeHtml(label)}">${avatar(letterOf, accent)}<span class="mine-chat-chip-name">${escapeHtml(title)}</span>${DOWN}</button>`;
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
    $('pick-admin').hidden = true;
    $('pick-title').textContent = 'Choose a chat';
    $('pick-modal').classList.add('chat-picker');
    $('pick-modal').classList.remove('app-sheet');
    $('pick-search').hidden = false;
    $field('pick-query').value = '';
    const render = () => {
        const query = $field('pick-query').value.trim().replace(/^@+/, '').toLocaleLowerCase();
        const matches = chats.filter((c) => c.title.toLocaleLowerCase().includes(query));
        $('pick-list').innerHTML =
            chatRows(matches, selected, 'chat-picker-select') ||
            `<p class="empty-note" role="status">${chats.length ? 'No chats found.' : 'No chats yet.'}</p>`;
        $('pick-clear').hidden = !$field('pick-query').value;
        $('pick-list').scrollTop = 0;
    };
    $('pick-search').oninput = render;
    render();
    choose = (id) => {
        if (chats.some((c) => String(c.id) === id)) onPick(id);
    };
    openModal('pick-modal');
}

export const chatPickerActions = {
    'chat-picker-clear': () => {
        $field('pick-query').value = '';
        $field('pick-query').dispatchEvent(new Event('input', { bubbles: true }));
        $field('pick-query').focus({ preventScroll: true });
    },
    'chat-picker-select': async (el) => {
        const done = choose;
        choose = null;
        await closeModal('pick-modal');
        if (done) done(el.dataset.id);
    }
};
