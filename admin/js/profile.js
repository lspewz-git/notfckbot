/**
 * The profile menu behind the chat chip on the account pages: the chats to switch between, Chat
 * settings, Account settings and Sign out (a sheet on phones, a menu under the chip elsewhere).
 * And the Account settings page's own group: who is signed in (the password group under it is
 * password.js, the Devices row devices.js).
 */
import { api } from './api.js';
import { $, escapeHtml } from './dom.js';
import { toast, openModal, closeModal } from './ui.js';
import { avatar } from './pick-sheet.js';
import { chatRows, chatChip } from './chat-picker.js';
import { chatList, chatHint, selectChat, setChatHidden } from './account.js';
import { openActionDropdown, closeDropdown } from './select.js';
import { setDevicesOwner, loadDevices } from './devices.js';

const icon = (name) =>
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#${name}" /></svg>`;

const CHEVRON = icon('chevron-right');
const SLIDERS = icon('sliders-horizontal');
const PERSON = icon('user-round');
const SIGN_OUT = icon('log-out');
const HIDDEN = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#eye" /><path d="m3 3 18 18" /></svg>`;

/** The pages the menu opens: Back on them returns to the section the menu was opened from */
const PAGES = ['my-settings', 'my-account', 'my-devices'];

const ROLES = { admin: 'Admin', user: 'User' };

/** @type {{ id: string, name: string | null, role: string, system: boolean } | null} */
let me = null;
const visibilitySaving = new Set();

/** Who is signed in (session.js, from /account/me). */
export function setProfile(user) {
    me = { id: String(user.id), name: user.name || null, role: user.role, system: Boolean(user.system) };
    backTo = me.system ? 'dashboard' : 'my-subs';
    for (const back of document.querySelectorAll('.mine-back')) back.setAttribute('data-section', backTo);
    for (const holder of document.querySelectorAll('[data-admin-profile]')) {
        holder.innerHTML = chatChip({ title: 'My account', accent: true, action: 'profile-open', label: 'Profile' });
        holder.querySelector('.pick-avatar').outerHTML = avatar(nameOf(), true);
    }
    for (const el of document.querySelectorAll('[data-profile-avatar]')) el.innerHTML = avatar(nameOf(), true);
    renderAccount();
}

const nameOf = () => (me && (me.name || me.id)) || '';

/** Every admin section shares the same profile entry, including the local account. */
export function setupProfile() {
    for (const header of document.querySelectorAll('.section:not(.mine-section) > header')) {
        const holder = document.createElement('div');
        holder.className = 'admin-profile';
        holder.setAttribute('data-admin-profile', '');
        header.append(holder);
    }
    document.addEventListener('account-chats', redrawMenu);
}

/** The chats arrived (or failed) while the menu is open: draw them in, keeping focus on its row */
function redrawMenu() {
    const modal = /** @type {HTMLDialogElement} */ ($('profile-modal'));
    if (!modal.open) return;
    const body = $('profile-body');
    const focused = /** @type {HTMLElement} */ (document.activeElement);
    const key = body.contains(focused) && focused.dataset.action;
    const section = key && focused.dataset.section;
    body.innerHTML = menuHtml();
    if (!key) return;
    const again = [...body.querySelectorAll(`[data-action="${key}"]`)].find(
        (el) => /** @type {HTMLElement} */ (el).dataset.section === section
    );
    /** @type {HTMLElement} */ (again || body).focus();
}

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

/** Chat rows still on their way from Telegram: the same size as the rows that replace them */
const SKELETON_CHAT =
    '<div class="action-row pick-row profile-skeleton" aria-hidden="true"><span class="pick-avatar skeleton"></span>' +
    '<span class="action-text"><span class="action-title"><span class="skeleton"></span></span>' +
    '<span class="action-desc"><span class="skeleton"></span></span></span></div>';
const SKELETON_PAGE =
    '<div class="action-row profile-skeleton" aria-hidden="true"><span class="action-icon"></span>' +
    '<span class="action-text"><span class="action-title"><span class="skeleton"></span></span></span></div>';

function chatsLoading() {
    return (
        '<h4 class="profile-label" id="profile-chats">Chats</h4>' +
        `<div class="action-list" role="group" aria-labelledby="profile-chats" aria-busy="true">${SKELETON_CHAT.repeat(2)}</div>`
    );
}

const chatsFailedRow = (message) =>
    '<h4 class="profile-label" id="profile-chats">Chats</h4><div class="action-list">' +
    row({
        action: 'mine-reload',
        iconHtml: `<span class="action-icon">${icon('triangle-alert')}</span>`,
        title: "Couldn't load chats",
        hint: message,
        end: '<span class="profile-retry">Retry</span>'
    }) +
    '</div>';

function menuHtml() {
    const { chats, chatId, loading, error } = me?.system
        ? { chats: [], chatId: null, loading: false, error: null }
        : chatList();
    const head = me
        ? `<div class="profile-head">${avatar(nameOf(), true)}<span class="action-text">` +
          `<span class="action-title">${escapeHtml(nameOf())}</span>` +
          `<span class="action-desc">${escapeHtml(ROLES[me.role] || me.role)} · ${me.system ? 'Local account' : `ID ${escapeHtml(me.id)}`}</span></span>` +
          (chats.some((c) => c.type !== 'private')
              ? `<button type="button" class="icon-button" data-action="profile-options" aria-label="Chat display options" aria-expanded="false" aria-controls="profile-options-menu">${icon('ellipsis')}</button>`
              : '') +
          '</div>'
        : '';
    const choices = chatRows(
        // The open chat stays listed even when hidden (opened from its group's Mini App link)
        chats.filter((c) => !c.hidden || c.id === chatId).map((c) => ({ ...c, hint: chatHint(c) })),
        chatId,
        'profile-chat'
    );
    return (
        head +
        (loading ? chatsLoading() : '') +
        (error ? chatsFailedRow(error) : '') +
        (chats.length
            ? `<h4 class="profile-label" id="profile-chats">Chats</h4><div class="action-list" role="group" aria-labelledby="profile-chats">${choices}</div>`
            : '') +
        (chats.some((c) => c.hidden)
            ? `<button type="button" class="action-row profile-hidden" data-action="profile-visibility"><span class="action-icon">${HIDDEN}</span><span>Hidden chats <span class="mine-count">${chats.filter((c) => c.hidden).length}</span></span><span class="action-chevron">${CHEVRON}</span></button>`
            : '') +
        '<div class="action-list profile-links">' +
        (me && me.role === 'admin' && document.body.classList.contains('view-mine')
            ? row({
                  action: 'view-admin',
                  attrs: ' data-close="profile-modal"',
                  iconHtml: `<span class="action-icon">${icon('shield')}</span>`,
                  title: 'Admin panel',
                  end: `<span class="action-chevron">${CHEVRON}</span>`
              })
            : '') +
        (me?.role === 'admin' && !me.system && !document.body.classList.contains('view-mine')
            ? row({
                  action: 'view-mine',
                  attrs: ' data-close="profile-modal"',
                  iconHtml: `<span class="action-icon">${icon('bookmark')}</span>`,
                  title: 'My subscriptions',
                  end: `<span class="action-chevron">${CHEVRON}</span>`
              })
            : '') +
        (chats.length ? pageRow('my-settings', SLIDERS, 'Chat settings') : loading ? SKELETON_PAGE : '') +
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
    const open = document.querySelector('.section.active');
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
    // Who it is, with the role as a chip beside the name: information, not a control
    const letter = nameOf().replace(/^@/, '').charAt(0).toUpperCase();
    info.innerHTML =
        `<div class="group-card"><span class="profile-avatar" aria-hidden="true">${escapeHtml(letter)}</span>` +
        `<span class="row-text"><span class="profile-name"><span class="card-name">${escapeHtml(nameOf())}</span>` +
        `<span class="role-chip">${escapeHtml(ROLES[me.role] || me.role)}</span></span>` +
        `<span class="row-meta">${me.system ? 'Local account' : `Telegram · ID ${escapeHtml(me.id)}`}</span></span></div>`;
    setDevicesOwner(me.id);
    loadDevices();
}

/** Click handlers, merged into app.js's delegation like the other modules' */
export const profileActions = {
    'profile-open': (el) => openMenu(el),
    'profile-options': (el) => {
        openActionDropdown(
            el,
            `<button type="button" class="action-row" data-action="profile-visibility">${icon('eye')}<span class="action-text">Chat visibility</span><span class="action-chevron">${CHEVRON}</span></button>`
        );
    },
    'profile-visibility': openVisibility,
    'profile-visibility-toggle': toggleVisibility,
    'profile-chat': (el) => {
        closeModal('profile-modal');
        selectChat(el.dataset.id);
        if (!document.body.classList.contains('view-mine'))
            document.dispatchEvent(new window.CustomEvent('profile-chat-selected'));
    },
    // Runs before the section switch (app.js): the page's Back is pointed at where the menu was opened
    'profile-page': () => {
        for (const back of document.querySelectorAll('.mine-back')) back.setAttribute('data-section', backTo);
    }
};
