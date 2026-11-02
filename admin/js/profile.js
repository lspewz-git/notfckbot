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
import { chatRows } from './chat-picker.js';
import { chatList, chatHint, selectChat, setChatHidden } from './account.js';
import { openActionDropdown, closeDropdown } from './select.js';

const icon = (name) =>
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#${name}" /></svg>`;

const CHEVRON = icon('chevron-right');
const SLIDERS = icon('sliders-horizontal');
const PERSON = icon('user-round');
const SIGN_OUT = icon('log-out');
const HIDDEN = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#eye" /><path d="m3 3 18 18" /></svg>`;

/** The pages the menu opens: Back on them returns to the section the menu was opened from */
const PAGES = ['my-settings', 'my-account'];

const ROLES = { admin: 'Admin', user: 'User' };

/** @type {{ id: string, name: string | null, role: string } | null} */
let me = null;
const visibilitySaving = new Set();

/** Who is signed in (session.js, from /account/me). */
export function setProfile(user) {
    me = { id: String(user.id), name: user.name || null, role: user.role };
    for (const el of document.querySelectorAll('[data-profile-avatar]')) el.innerHTML = avatar(nameOf(), true);
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
          `<span class="action-desc">${escapeHtml(ROLES[me.role] || me.role)} · ID ${escapeHtml(me.id)}</span></span>` +
          (chats.some((c) => c.type !== 'private')
              ? `<button type="button" class="icon-button" data-action="profile-options" aria-label="Chat display options" aria-expanded="false" aria-controls="profile-options-menu">${icon('ellipsis')}</button>`
              : '') +
          '</div>'
        : '';
    const choices = chatRows(
        chats.filter((c) => !c.hidden).map((c) => ({ ...c, hint: chatHint(c) })),
        chatId,
        'profile-chat'
    );
    return (
        head +
        (chats.length
            ? `<h4 class="profile-label" id="profile-chats">Chat</h4><div class="action-list" role="group" aria-labelledby="profile-chats">${choices}</div>`
            : '') +
        (chats.some((c) => c.hidden)
            ? `<button type="button" class="profile-hidden" data-action="profile-visibility">${HIDDEN}<span>Hidden chats</span><span class="mine-count">${chats.filter((c) => c.hidden).length}</span><span class="action-chevron">${CHEVRON}</span></button>`
            : '') +
        '<div class="action-list profile-links">' +
        (me && me.role === 'admin'
            ? row({
                  action: 'view-admin',
                  attrs: ' data-close="profile-modal"',
                  iconHtml: `<span class="action-icon">${icon('shield')}</span>`,
                  title: 'Admin panel',
                  end: `<span class="action-chevron">${CHEVRON}</span>`
              })
            : '') +
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

function visibilityRows() {
    return chatList()
        .chats.map((c) => {
            const own = c.type === 'private';
            const title = escapeHtml(c.title);
            return (
                `<div class="action-row profile-visibility-row">${avatar(c.title, own)}` +
                `<span class="action-text"><span class="action-title">${title}</span>` +
                `<span class="action-desc">${own ? 'Always visible' : c.hidden ? 'Hidden' : 'Visible'}</span></span>` +
                (own
                    ? `<span class="pick-check">${icon('check')}</span>`
                    : `<button type="button" class="switch" role="switch" aria-label="Show ${title}" aria-checked="${!c.hidden}" ${visibilitySaving.has(c.id) ? 'disabled aria-busy="true"' : ''} data-action="profile-visibility-toggle" data-id="${escapeHtml(c.id)}"><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span></button>`) +
                '</div>'
            );
        })
        .join('');
}

function openVisibility() {
    closeDropdown();
    $('visibility-list').innerHTML = visibilityRows();
    openModal('visibility-modal');
}

async function toggleVisibility(button) {
    if (button.disabled || visibilitySaving.has(button.dataset.id)) return;
    const user = me;
    const id = button.dataset.id;
    const hidden = button.getAttribute('aria-checked') === 'true';
    visibilitySaving.add(id);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
        await api(`/account/chats/${encodeURIComponent(id)}/visibility`, { method: 'PATCH', body: { hidden } });
        if (me !== user) return;
        await setChatHidden(id, hidden);
        if (me !== user) return;
        // Keep the management list mounted so its scroll position and focus survive saving.
        $('profile-body').innerHTML = menuHtml();
    } catch (err) {
        if (me === user) toast(err.message, 'error');
    } finally {
        visibilitySaving.delete(id);
        if (me === user) {
            for (const current of $('visibility-list').querySelectorAll('button[data-id]')) {
                const el = /** @type {HTMLButtonElement} */ (current);
                if (el.dataset.id !== id) continue;
                const chat = chatList().chats.find((c) => c.id === id);
                el.setAttribute('aria-checked', String(!chat?.hidden));
                el.disabled = false;
                el.removeAttribute('aria-busy');
                el.closest('.profile-visibility-row').querySelector('.action-desc').textContent = chat?.hidden
                    ? 'Hidden'
                    : 'Visible';
            }
        }
    }
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
    'profile-options': (el) => {
        openActionDropdown(
            el,
            `<button type="button" class="action-row" data-action="profile-visibility">${HIDDEN}<span class="action-text">Hidden chats</span><span class="action-chevron">${CHEVRON}</span></button>`
        );
    },
    'profile-visibility': openVisibility,
    'profile-visibility-toggle': toggleVisibility,
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
