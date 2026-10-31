/**
 * The profile menu behind the chat chip on the account pages: the chats to switch between, Chat
 * settings, Account settings and Sign out (a sheet on phones, a menu under the chip elsewhere).
 * And the Account settings page's own groups: who is signed in, and signing out on other devices
 * (the password group between them is password.js).
 */
import { api } from './api.js';
import { $, escapeHtml } from './dom.js';
import { toast, openModal, closeModal, showConfirm } from './ui.js';
import { avatar } from './pick-sheet.js';
import { chatList, chatHint, selectChat } from './account.js';

const icon = (path) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" /></svg>`;
const CHECK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>';
const CHEVRON = icon('m9 18 6-6-6-6');
const SLIDERS = icon('M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6');
const PERSON = icon('M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z');
const SIGN_OUT = icon('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9');

/** The pages the menu opens: Back on them returns to the section the menu was opened from */
const PAGES = ['my-settings', 'my-account'];

const ROLES = { admin: 'Admin', user: 'User' };

/** @type {{ id: string, name: string | null, role: string } | null} */
let me = null;

/** Who is signed in (session.js, from /account/me). */
export function setProfile(user) {
    me = { id: String(user.id), name: user.name || null, role: user.role };
    renderAccount();
}

const nameOf = () => (me && (me.name || me.id)) || '';

const row = ({ action, attrs = '', iconHtml, title, hint = '', end = '', cls = '' }) =>
    `<button type="button" class="action-row${cls}" data-action="${action}"${attrs}>` +
    iconHtml +
    `<span class="action-text"><span class="action-title">${escapeHtml(title)}</span>` +
    (hint ? `<span class="action-desc">${escapeHtml(hint)}</span>` : '') +
    `</span>${end}</button>`;

const pageRow = (section, iconHtml, title) =>
    row({
        action: 'profile-page',
        attrs: ` data-section="${section}" data-close="profile-modal"`,
        iconHtml: `<span class="action-icon">${iconHtml}</span>`,
        title,
        end: `<span class="action-chevron">${CHEVRON}</span>`
    });

function menuHtml() {
    const { chats, chatId } = chatList();
    const head = me
        ? `<div class="profile-head">${avatar(nameOf(), true)}<span class="action-text">` +
          `<span class="action-title">${escapeHtml(nameOf())}</span>` +
          `<span class="action-desc">${escapeHtml(ROLES[me.role] || me.role)} · ID ${escapeHtml(me.id)}</span></span></div>`
        : '';
    const chatRows = chats
        .map((c) => {
            const on = c.id === chatId;
            return row({
                action: 'profile-chat',
                attrs: ` data-id="${escapeHtml(c.id)}" aria-pressed="${on}"`,
                cls: ` pick-row${on ? ' selected' : ''}`,
                iconHtml: avatar(c.title, c.type === 'private'),
                title: c.title,
                hint: chatHint(c),
                end: on ? `<span class="pick-check">${CHECK}</span>` : ''
            });
        })
        .join('');
    return (
        head +
        (chats.length
            ? `<h4 class="profile-label" id="profile-chats">Chat</h4><div class="action-list" role="group" aria-labelledby="profile-chats">${chatRows}</div>`
            : '') +
        '<div class="action-list profile-links">' +
        (chats.length ? pageRow('my-settings', SLIDERS, 'Chat settings') : '') +
        pageRow('my-account', PERSON, 'Account settings') +
        row({
            action: 'logout',
            attrs: ' data-close="profile-modal"',
            cls: ' action-row-danger',
            iconHtml: `<span class="action-icon">${SIGN_OUT}</span>`,
            title: 'Sign out'
        }) +
        '</div>'
    );
}

/** The section the menu was opened from: Back on Chat / Account settings leads there */
let backTo = 'my-subs';

function openMenu(chip) {
    const open = document.querySelector('.mine-section.active');
    const from = open ? open.id.replace(/-section$/, '') : '';
    if (from && !PAGES.includes(from)) backTo = from;
    $('profile-body').innerHTML = menuHtml();
    const modal = $('profile-modal');
    openModal('profile-modal');
    // Wider than a phone it drops from the chip, its right edge under the chip's. Measured once
    // open: the dialog's own width, not the page's, is what its padding counts from
    const box = chip.getBoundingClientRect();
    modal.style.setProperty('--menu-top', `${Math.round(box.bottom + 8)}px`);
    modal.style.setProperty('--menu-right', `${Math.max(16, Math.round(modal.clientWidth - box.right))}px`);
}

// --- Account settings ---

function renderAccount() {
    const info = $('my-account-info');
    if (!info || !me) return;
    info.innerHTML =
        '<section class="mine-group"><h3 class="mine-group-title">Account</h3><ul class="glass-card mine-sets">' +
        `<li class="mine-set profile-who">${avatar(nameOf(), true)}<span class="mine-set-text"><span>${escapeHtml(nameOf())}</span>` +
        `<span class="mine-dim">Telegram · ID ${escapeHtml(me.id)}</span></span></li>` +
        `<li class="mine-set"><span class="mine-set-text">Role</span><span class="mine-set-value">${escapeHtml(ROLES[me.role] || me.role)}</span></li>` +
        '</ul></section>';
    $('my-devices').innerHTML =
        '<section class="mine-group"><h3 class="mine-group-title">Devices</h3><ul class="glass-card mine-sets">' +
        '<li><button type="button" class="mine-set mine-set-pick profile-end-others" data-action="profile-end-others">' +
        '<span class="mine-set-text">Sign out on other devices</span></button></li>' +
        '</ul><p class="mine-group-note">This device stays signed in.</p></section>';
}

async function endOthers() {
    try {
        const { ended } = await api('/account/sessions/end-others', { method: 'POST' });
        toast(
            ended ? `Signed out on ${ended} other device${ended === 1 ? '' : 's'}` : 'No other devices were signed in',
            'success'
        );
    } catch (err) {
        toast(err.message, 'error');
    }
}

/** Click handlers, merged into app.js's delegation like the other modules' */
export const profileActions = {
    'profile-open': (el) => openMenu(el),
    'profile-chat': (el) => {
        closeModal('profile-modal');
        selectChat(el.dataset.id);
    },
    // Runs before the section switch (app.js): the page's Back is pointed at where the menu was opened
    'profile-page': () => {
        for (const back of document.querySelectorAll('.mine-back')) back.setAttribute('data-section', backTo);
    },
    'profile-end-others': () =>
        showConfirm({
            title: 'Sign out on other devices?',
            text: 'Every other browser signed in to this account will need to sign in again.',
            confirmLabel: 'Sign out',
            cancelLabel: 'Cancel',
            onConfirm: endOthers
        })
};
