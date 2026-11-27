import { t as i18nText } from './i18n.js';
/**
 * The Account tab (`#my-profile`, the redesign of 06.11 instead of the old profile menu): who is
 * signed in, the chats to switch between, the settings pages and Sign out. And the Account settings
 * page's own group: who is signed in (the password group under it is password.js, the Devices row
 * devices.js). The chat chip in the tabs' headers links to this Account tab (account.js).
 */
import { api } from './api.js';
import { $, escapeHtml } from './dom.js';
import { toast, openModal, showConfirm } from './ui.js';
import { avatar, initial } from './pick-sheet.js';
import { chatList, chatHint, selectChat, setChatHidden, chatAvatar, setOwnName } from './account.js';
import { setDevicesOwner, loadDevices } from './devices.js';
import { DEFAULT_PERSONAL_SECTION } from './navigation.js';
import { t, languagePreference, detectedLanguage, accountLanguage } from './i18n.js';
import { pickFrom } from './pick-sheet.js';

const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}" /></svg>`;

const CHEVRON = `<span class="row-chevron">${icon('chevron-right')}</span>`;

const ROLES = { admin: i18nText('Admin'), user: i18nText('User') };

/** @type {{ id: string, name: string | null, role: string, system: boolean } | null} */
let me = null;
const visibilitySaving = new Set();
let languageSaving = false;

/** Who is signed in (session.js, from /account/me). */
export function setProfile(user) {
    me = { id: String(user.id), name: user.name || null, role: user.role, system: Boolean(user.system) };
    // The admin sections' headers: the person's avatar, a link to the Account tab
    for (const holder of document.querySelectorAll('[data-admin-profile]')) {
        holder.innerHTML =
            '<a class="mine-chat-chip" href="#my-profile" data-section="my-profile" aria-label="' +
            i18nText('Account') +
            '">' +
            (avatar(nameOf(), true) + '<span class="mine-chat-chip-name">' + i18nText('My account') + '</span></a>');
    }
    for (const el of document.querySelectorAll('[data-profile-avatar]')) el.innerHTML = avatar(nameOf(), true);
    setOwnName(me.system ? '' : nameOf());
    renderAccount();
    renderProfile();
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
    // The chats arrived, failed or changed (another chat picked, one hidden): the page follows
    document.addEventListener('account-chats', renderProfile);
}

// --- The Account tab ---

const pageRow = ({ attrs, tile, title, end = CHEVRON }) =>
    `<li><button type="button" class="group-row"${attrs}><span class="row-tile">${icon(tile)}</span>` +
    `<span class="row-text"><span class="row-name">${escapeHtml(title)}</span></span>${end}</button></li>`;

/** Chat rows still on their way from Telegram: the same size as the rows that replace them */
const SKELETON_CHAT =
    '<li><div class="group-row chat-row" aria-hidden="true"><span class="pick-avatar skeleton"></span>' +
    '<span class="row-skeleton"><span class="skeleton"></span><span class="skeleton"></span></span></div></li>';

function chatsGroup() {
    if (me?.system) return '';
    const { chats, chatId, loading, error, partial, retrying } = chatList();
    let rows;
    if (loading) rows = SKELETON_CHAT.repeat(2);
    else if (error)
        rows =
            `<li><button type="button" class="group-row" data-action="mine-reload"><span class="row-tile">${icon('triangle-alert')}</span>` +
            ('<span class="row-text"><span class="row-name">' +
                i18nText("Couldn't load chats") +
                '</span><span class="row-meta">' +
                escapeHtml(error) +
                '</span></span>') +
            ('<span class="row-value profile-retry">' + i18nText('Retry') + '</span></button></li>');
    else {
        // The open chat stays listed even when hidden (opened from its group's Mini App link)
        rows = chats
            .filter((c) => !c.hidden || c.id === chatId)
            .map((c) => {
                const on = c.id === chatId;
                return (
                    `<li><button type="button" class="group-row chat-row" data-action="profile-chat" data-section="${DEFAULT_PERSONAL_SECTION}" data-id="${escapeHtml(c.id)}" aria-pressed="${on}">` +
                    chatAvatar(c) +
                    `<span class="row-text"><span class="row-name">${escapeHtml(c.title)}</span>` +
                    `<span class="row-meta">${escapeHtml(chatHint(c))}</span></span>` +
                    (on ? `<span class="row-check">${icon('check')}</span>` : '') +
                    '</button></li>'
                );
            })
            .join('');
        // Telegram didn't answer for some groups: they aren't gone, a retry asks again
        if (partial)
            rows +=
                `<li><button type="button" class="group-row" data-action="chats-retry"${retrying ? ' aria-busy="true"' : ''}><span class="row-tile">${icon('triangle-alert')}</span>` +
                ('<span class="row-text"><span class="row-name">' +
                    i18nText("Some groups didn't load") +
                    '</span><span class="row-meta">' +
                    i18nText("Telegram isn't answering") +
                    '</span></span>') +
                `<span class="row-value profile-retry">${retrying ? 'Checking…' : i18nText('Retry')}</span></button></li>`;
        const hidden = chats.filter((c) => c.hidden).length;
        if (chats.some((c) => c.type !== 'private'))
            rows += pageRow({
                attrs: ' data-action="profile-visibility" aria-haspopup="dialog"',
                tile: 'eye-off',
                title: i18nText('Hidden chats'),
                end: (hidden ? `<span class="row-value">${hidden}</span>` : '') + CHEVRON
            });
    }
    return (
        '<h2 class="group-title" id="profile-chats">' +
        i18nText('Chats') +
        '</h2>' +
        `<ul class="group-list" aria-labelledby="profile-chats"${loading ? ' aria-busy="true"' : ''}>${rows}</ul>` +
        ('<p class="group-help">' +
            i18nText('The chosen chat sets what Calendar, Released and Following show.') +
            '</p>')
    );
}

function profileHtml() {
    if (!me) return '';
    const { chats } = chatList();
    const card =
        '<button type="button" class="group-card profile-card" data-section="my-account" aria-label="' +
        i18nText('Account settings: {{v0}}', { v0: escapeHtml(nameOf()) }) +
        '">' +
        `<span class="profile-avatar" aria-hidden="true">${escapeHtml(initial(nameOf()))}</span>` +
        `<span class="row-text"><span class="profile-name"><span class="card-name">${escapeHtml(nameOf())}</span>` +
        `<span class="role-chip">${escapeHtml(ROLES[me.role] || me.role)}</span></span>` +
        `<span class="row-meta">${me.system ? i18nText('Local account') : `Telegram · ID ${escapeHtml(me.id)}`}</span></span>${CHEVRON}</button>`;
    const settings =
        (me.role === 'admin'
            ? pageRow({ attrs: ' data-action="view-admin"', tile: 'shield', title: i18nText('Admin panel') })
            : '') +
        (!me.system && chats.length
            ? pageRow({ attrs: ' data-section="my-settings"', tile: 'panel-bottom', title: i18nText('Chat settings') })
            : '') +
        pageRow({
            attrs: ' data-section="my-account"',
            tile: 'circle-user-round',
            title: i18nText('Account settings')
        });
    return (
        card +
        chatsGroup() +
        ('<h2 class="group-title" id="profile-settings">' +
            i18nText('Settings') +
            '</h2><ul class="group-list" aria-labelledby="profile-settings">' +
            settings +
            '</ul>') +
        ('<button type="button" class="sheet-btn-danger-soft profile-signout" data-action="profile-signout">' +
            icon('log-out') +
            '<span>' +
            i18nText('Sign out') +
            '</span></button>')
    );
}

/** Redraws the page, keeping focus on the row it was on */
function renderProfile() {
    const body = $('my-profile-body');
    if (!body) return;
    const focused = /** @type {HTMLElement} */ (document.activeElement);
    const key =
        body.contains(focused) && (focused.dataset.action || focused.dataset.section)
            ? [focused.dataset.action, focused.dataset.section, focused.dataset.id]
            : null;
    body.innerHTML = profileHtml();
    if (!key) return;
    const again = [...body.querySelectorAll('button')].find((el) => {
        const d = /** @type {HTMLElement} */ (el).dataset;
        return d.action === key[0] && d.section === key[1] && d.id === key[2];
    });
    /** @type {HTMLElement | undefined} */ (again)?.focus({ preventScroll: true });
}

// --- Hidden chats ---

function visibilityRows() {
    return chatList()
        .chats.map((c) => {
            const own = c.type === 'private';
            const title = escapeHtml(c.title);
            return (
                `<li><div class="group-row group-row-static chat-row profile-visibility-row">${chatAvatar(c)}` +
                `<span class="row-text"><span class="row-name">${title}</span>` +
                `<span class="row-meta">${own ? i18nText('Always visible') : c.hidden ? i18nText('Hidden') : i18nText('Visible')}</span></span>` +
                (own
                    ? `<span class="row-check visibility-check">${icon('check')}</span>`
                    : '<button type="button" class="switch" role="switch" aria-label="' +
                      i18nText('Show {{v0}}', { v0: title }) +
                      '" aria-checked="' +
                      !c.hidden +
                      '" ' +
                      (visibilitySaving.has(c.id) ? 'disabled aria-busy="true"' : '') +
                      ' data-action="profile-visibility-toggle" data-id="' +
                      escapeHtml(c.id) +
                      '"><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span></button>') +
                '</div></li>'
            );
        })
        .join('');
}

function openVisibility() {
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
        renderProfile();
    } catch (err) {
        if (me === user) toast(err.message, 'error');
    } finally {
        visibilitySaving.delete(id);
        if (me === user) {
            // The list stays mounted so its scroll position and focus survive saving
            for (const current of $('visibility-list').querySelectorAll('button[data-id]')) {
                const el = /** @type {HTMLButtonElement} */ (current);
                if (el.dataset.id !== id) continue;
                const chat = chatList().chats.find((c) => c.id === id);
                el.setAttribute('aria-checked', String(!chat?.hidden));
                el.disabled = false;
                el.removeAttribute('aria-busy');
                el.closest('.profile-visibility-row').querySelector('.row-meta').textContent = chat?.hidden
                    ? i18nText('Hidden')
                    : i18nText('Visible');
            }
        }
    }
}

// --- Account settings ---

function renderAccount() {
    const info = $('my-account-info');
    if (!info || !me) return;
    // Who it is, with the role as a chip beside the name: information, not a control
    info.innerHTML =
        `<div class="group-card"><span class="profile-avatar" aria-hidden="true">${escapeHtml(initial(nameOf()))}</span>` +
        `<span class="row-text"><span class="profile-name"><span class="card-name">${escapeHtml(nameOf())}</span>` +
        `<span class="role-chip">${escapeHtml(ROLES[me.role] || me.role)}</span></span>` +
        `<span class="row-meta">${me.system ? i18nText('Local account') : `Telegram · ID ${escapeHtml(me.id)}`}</span></span></div>`;
    setDevicesOwner(me.id);
    loadDevices();
    const preferences = $('my-preferences');
    const languageHelp =
        languagePreference() === 'auto'
            ? t('Uses your Telegram or browser language.')
            : languagePreference() === 'ru'
              ? t('Russian is selected. Saved in your account.')
              : t('English is selected. Saved in your account.');
    if (preferences)
        preferences.innerHTML =
            `<h2 class="group-title">${t('Preferences')}</h2><ul class="group-list"><li>` +
            `<button type="button" class="group-row" data-action="account-language" aria-haspopup="dialog"${languageSaving ? ' disabled aria-busy="true"' : ''}>` +
            `<span class="row-tile">${icon('globe')}</span><span class="row-text"><span class="row-name">${t('Language')}</span></span>` +
            `<span class="row-value">${languagePreference() === 'auto' ? t('Automatic') : languagePreference() === 'ru' ? 'Русский' : 'English'}</span>${CHEVRON}</button></li></ul>` +
            `<p class="group-help">${languageHelp}</p>`;
}

function chooseLanguage() {
    if (languageSaving) return;
    pickFrom({
        title: t('Language'),
        value: languagePreference(),
        options: [
            {
                value: 'auto',
                label: t('Automatic'),
                hint: `${detectedLanguage.language === 'ru' ? 'Русский' : 'English'} · ${t(detectedLanguage.source)}`
            },
            { value: 'en', label: 'English' },
            { value: 'ru', label: 'Русский' }
        ],
        onPick: async (language) => {
            languageSaving = true;
            renderAccount();
            try {
                await api('/account/preferences', { method: 'PATCH', body: { language } });
                accountLanguage(language);
            } catch {
                toast(t('Could not save the language. Try again.'), 'error');
            } finally {
                languageSaving = false;
                renderAccount();
            }
        }
    });
}

/** Click handlers, merged into app.js's delegation like the other modules' */
export const profileActions = {
    'account-language': chooseLanguage,
    'profile-visibility': openVisibility,
    'profile-visibility-toggle': toggleVisibility,
    'profile-chat': (el) => selectChat(el.dataset.id),
    'profile-signout': () =>
        showConfirm({
            title: i18nText('Sign out?'),
            text: i18nText('This browser signs out of the panel. Other devices stay signed in.'),
            confirmLabel: i18nText('Sign out'),
            cancelLabel: i18nText('Cancel'),
            onConfirm: async () => {
                try {
                    await api('/logout', { method: 'POST' });
                } catch {
                    // Signed out on this page all the same
                }
                toast(i18nText('Signed out'), 'success');
                location.href = '/';
            }
        })
};
