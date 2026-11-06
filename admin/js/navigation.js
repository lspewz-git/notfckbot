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
        aria: 'Activity Logs',
        moreLabel: 'Activity Logs',
        icon: 'file-text',
        hint: 'What the bot has been doing'
    },
    { id: 'settings', label: 'Settings', icon: 'settings', hint: 'Tokens, proxy, update check, restart' },
    { id: 'my-aired', label: 'Released', icon: 'clapperboard', mine: true, divider: true },
    {
        id: 'my-subs',
        label: 'Following',
        icon: 'bookmark',
        mine: true,
        moreLabel: 'My account',
        hint: 'Subscriptions, calendar and settings of your chats'
    },
    { id: 'my-calendar', label: 'Calendar', icon: 'calendar-days', mine: true }
];

const icon = (name) =>
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#${name}" /></svg>`;

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

function moreItem(section) {
    return (
        `<button class="action-row" data-section="${section.id}" data-close="more-modal">` +
        `<span class="action-icon">${icon(section.icon)}</span><span class="action-text">` +
        `<span class="action-title">${escapeHtml(section.moreLabel || section.label)}</span>` +
        `<span class="action-desc">${escapeHtml(section.hint)}</span></span>` +
        `<span class="action-chevron">${icon('chevron-right')}</span></button>`
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
            SECTIONS.filter((s) => s.mine)
                .map((s) => item(s, true))
                .join('')
    );
    $('more-modal')
        .querySelector('.action-list')
        .insertAdjacentHTML(
            'afterbegin',
            [SECTIONS.find((s) => s.id === 'my-subs'), ...overflow].map(moreItem).join('')
        );
}
