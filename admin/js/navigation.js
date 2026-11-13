/** Section metadata shared by the desktop rail, phone tabs and More sheet. */
import { $, escapeHtml } from './dom.js';

const SECTIONS = [
    { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', tab: true },
    { id: 'chats', label: 'Chats', aria: 'Users / Chats', icon: 'users', tab: true, divider: true },
    { id: 'subs', label: 'Serials', icon: 'tv', tab: true },
    { id: 'watchlist', label: 'Movies', icon: 'film', tab: true },
    { id: 'history', label: 'Released', icon: 'calendar', hint: 'What came out, year by year' },
    {
        id: 'tools',
        label: 'Tools',
        icon: 'sliders-horizontal',
        children: ['recap'],
        divider: true,
        hint: 'Year recap and occasional tasks'
    },
    {
        id: 'logs',
        label: 'Logs',
        aria: 'Activity logs',
        moreLabel: 'Activity logs',
        icon: 'file-text',
        hint: 'What the bot has been doing'
    },
    { id: 'settings', label: 'Settings', icon: 'settings', hint: 'Tokens, proxy, update check, restart' },
    // The personal tabs in the redesign's order (06.11): Calendar, Released, Following, Account
    { id: 'my-calendar', label: 'Calendar', icon: 'calendar-days', mine: true, divider: true },
    { id: 'my-aired', label: 'Released', icon: 'clapperboard', mine: true },
    {
        id: 'my-subs',
        label: 'Following',
        icon: 'bookmark',
        mine: true,
        children: ['my-search']
    },
    // The tab bar has its own Account item with the chat's avatar (index.html); the rail lists it here
    {
        id: 'my-profile',
        label: 'Account',
        icon: 'user-round',
        mine: true,
        railOnly: true,
        children: ['my-settings', 'my-account', 'my-devices']
    }
];

/** All entry points to personal mode start on the first personal tab. */
export const DEFAULT_PERSONAL_SECTION = SECTIONS.find((s) => s.mine).id;

const PERSONAL_ENTRY = {
    id: DEFAULT_PERSONAL_SECTION,
    label: 'My account',
    icon: 'bookmark',
    hint: 'Subscriptions, calendar and chat settings'
};

// The More sheet's two rows that open a dialog rather than a section
const ACTIONS_ENTRY = {
    open: 'actions-modal',
    label: 'Actions',
    icon: 'zap',
    hint: 'Run an update check, send a broadcast'
};
const ABOUT_ENTRY = {
    open: 'about-modal',
    action: 'about',
    label: 'About',
    icon: 'info',
    hint: 'The version running on the server'
};

const icon = (name) =>
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}" /></svg>`;

function item(section, tab = false) {
    const { id, label, aria = label, children = [], mine = false } = section;
    const cls = tab ? `tab-item${mine ? ' tab-mine' : ''}` : `nav-item${mine ? ' nav-mine' : ''}`;
    const active = id === 'dashboard';
    // Tab bar items are links to their section (the click switches it in place, app.js)
    const tag = tab ? 'a' : 'button';
    return (
        `<${tag} class="${cls}${active ? ' active' : ''}"${tab ? ` href="#${id}"` : ''} data-section="${id}"` +
        (active ? ' aria-current="page"' : '') +
        (!tab ? ` aria-label="${escapeHtml(aria)}"` : '') +
        (children.length ? ` data-tab-sections="${children.join(' ')}"` : '') +
        `>${icon(section.icon)}<span${tab ? '' : ' class="nav-label" aria-hidden="true"'}>${escapeHtml(label)}</span></${tag}>`
    );
}

/** A row of the More sheet: the reference design's group row (tile, name, hint, chevron) */
function moreItem(entry) {
    const target = entry.open
        ? `data-open="${entry.open}"${entry.action ? ` data-action="${entry.action}"` : ''}`
        : `data-section="${entry.id}"`;
    return (
        `<li><button type="button" class="group-row more-row" ${target} data-close="more-modal">` +
        `<span class="row-tile">${icon(entry.icon)}</span><span class="row-text">` +
        `<span class="row-name">${escapeHtml(entry.moreLabel || entry.label)}</span>` +
        `<span class="row-meta">${escapeHtml(entry.hint)}</span></span>` +
        `<span class="row-chevron">${icon('chevron-right')}</span></button></li>`
    );
}

export function setupNavigation() {
    document.querySelector('.rail-nav').innerHTML = SECTIONS.map(
        (s) =>
            (s.divider ? `<span class="rail-divider${s.mine ? ' nav-mine' : ''}" aria-hidden="true"></span>` : '') +
            item(s)
    ).join('');
    const overflow = SECTIONS.filter((s) => !s.tab && !s.mine);
    const moreSections = overflow.flatMap((s) => [s.id, ...(s.children || [])]);
    // Preserve the profile tab and the two non-section actions in the More sheet.
    document.querySelector('.tabbar').insertAdjacentHTML(
        'afterbegin',
        SECTIONS.filter((s) => s.tab)
            .map((s) => item(s, true))
            .join('') +
            `<button class="tab-item" data-open="more-modal" data-tab-sections="${moreSections.join(' ')}" aria-haspopup="dialog">${icon('ellipsis')}<span>More</span></button>` +
            SECTIONS.filter((s) => s.mine && !s.railOnly)
                .map((s) => item(s, true))
                .join('')
    );
    // Three groups (the 13.11 mockup): your account; the admin sections, Actions after Tools; About
    const admin = overflow.flatMap((s) => (s.id === 'tools' ? [s, ACTIONS_ENTRY] : [s]));
    $('more-personal').innerHTML = moreItem(PERSONAL_ENTRY);
    $('more-admin').innerHTML = admin.map(moreItem).join('');
    $('more-about').innerHTML = moreItem(ABOUT_ENTRY);
}
