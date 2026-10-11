/** The three data tables: filters, skeletons and row rendering. */

import { $, $field, all, escapeHtml } from './dom.js';
import {
    chatDisplayName,
    chatLabel,
    seriesStatusBadge,
    formatReleaseDate,
    formatNextEpisode,
    MODE_LABELS
} from './format.js';
import { chatsById, subsByKey, subKey, refill } from './store.js';
import { isUnchanged, invalidate } from './render.js';

// The API decides (series ended or canceled on TMDB); the panel keeps no status list of its own
const isArchivedSub = (sub) => Boolean(sub.archived);

// Small line icons for row buttons (Lucide shapes)
const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const ICON = {
    more: svg('<circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" />'),
    mode: svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />'),
    trash: svg(
        '<path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />'
    )
};

/**
 * The phone card: the title (with a badge) on one line, the rest as one muted line.
 * Desktop hides this cell; phones hide every other cell except Actions.
 * @param {{ title: string, action?: string, id?: string, badge?: string, meta: string[] }} card
 */
function compactCell({ title, action, id, badge = '', meta }) {
    const titleHtml = action
        ? `<span class="compact-title link-text" data-action="${action}" data-id="${escapeHtml(id)}" role="button" tabindex="0">${title}</span>`
        : `<span class="compact-title">${title}</span>`;
    return `
        <td class="cell-compact">
            <div class="compact-head">${titleHtml}${badge}</div>
            <div class="compact-meta">${meta.filter(Boolean).map(escapeHtml).join(' · ')}</div>
        </td>`;
}

const btnLabel = (text) => `<span class="btn-label">${text}</span>`;

/**
 * Everything that differs between the three tables, in one place: where the
 * rows go, which input filters them, the column labels (also used as
 * data-label for the mobile card layout) and how one record becomes a row.
 *
 * A table with `tabs` shows one slice of its payload at a time. The split is
 * client-side, so switching tabs needs no request; `hides` lists columns the
 * slice has no use for (the stylesheet hides their <th> via the table's
 * data-tab, the row simply leaves the <td> out).
 *
 * `sorts` lists the keys a table can be ordered by (asc/desc, empty values last).
 * `paged` splits the rows into pages (see the pager below the table).
 *
 * Row handlers are wired by delegation in app.js, so markup carries only
 * data-* attributes — no value is ever interpolated into executable code.
 */
const TABLES = {
    chats: {
        body: 'chats-body',
        filter: 'chats-filter',
        columns: ['Chat ID', 'User / Group', 'Type', 'Status', 'Actions'],
        row: (item) => {
            const isBlocked = item.blockedUntil && new Date(item.blockedUntil) > new Date();
            const status = isBlocked
                ? '<span class="badge error">Blocked</span>'
                : '<span class="badge ok">Active</span>';
            return `
                <tr class="row-compact">
                    <td data-label="Chat ID"><code>${item.id}</code></td>
                    <td data-label="User / Group">${chatDisplayName(item)}</td>
                    <td data-label="Type"><span class="chat-type">${item.type}</span></td>
                    <td data-label="Status">${status}</td>
                    ${compactCell({ title: chatDisplayName(item), badge: status, meta: [item.type, String(item.id)] })}
                    <td data-label="Actions">
                        <button class="btn btn-row" data-action="chat-actions" data-id="${item.id}" aria-label="Actions for ${escapeHtml(chatLabel(item))}">${ICON.more}${btnLabel('Actions')}</button>
                    </td>
                </tr>
            `;
        }
    },

    subs: {
        body: 'subs-body',
        filter: 'subs-filter',
        paged: true,
        columns: ['User', 'Series', 'Status', 'Next Episode', 'Mode', 'Actions'],
        tabs: {
            active: {
                label: 'Active',
                matches: (item) => !isArchivedSub(item),
                empty: 'No active subscriptions.'
            },
            // Ended or canceled on TMDB — the notification mode no longer matters
            archive: {
                label: 'Archive',
                matches: isArchivedSub,
                empty: 'No archived subscriptions.',
                hint: 'subs-archive-hint',
                hides: ['Next Episode', 'Mode']
            }
        },
        row: (item) => {
            const archived = isArchivedSub(item);
            const next = archived
                ? ''
                : `<td data-label="Next Episode">${escapeHtml(formatNextEpisode(item.Series))}</td>`;
            const mode = archived
                ? ''
                : `<td data-label="Mode"><span class="badge ok">${MODE_LABELS[item.notify_type] || item.notify_type}</span></td>`;
            const key = subKey(item.chatId, item.seriesId);
            const title = item.Series ? item.Series.title : 'Unknown';
            const user = item.Chat ? chatLabel(item.Chat) : String(item.chatId);
            const status = seriesStatusBadge(item.Series && item.Series.status);
            // Phones: one menu instead of two buttons; an archived row has only Delete, kept as an icon
            const modeBtn = archived
                ? ''
                : `<button class="btn btn-row btn-wide-only" data-action="mode" data-key="${key}">${ICON.mode}Mode</button>
                   <button class="btn btn-row btn-narrow-only" data-action="sub-actions" data-key="${key}" aria-label="Actions for ${escapeHtml(title)}">${ICON.more}</button>`;
            const deleteBtn = `<button class="btn btn-row btn-row-danger${archived ? '' : ' btn-wide-only'}" data-action="delete-sub" data-chat="${item.chatId}" data-series="${item.seriesId}" aria-label="Delete ${escapeHtml(title)} for ${escapeHtml(user)}">${ICON.trash}${btnLabel('Delete')}</button>`;
            return `
                <tr class="row-compact">
                    <td data-label="User">${escapeHtml(user)}</td>
                    <td data-label="Series" class="link-cell" data-action="series" data-id="${item.seriesId}"><span class="link-text">${escapeHtml(title)}</span></td>
                    <td data-label="Status">${status}</td>
                    ${next}
                    ${mode}
                    ${compactCell({
                        title: escapeHtml(title),
                        action: 'series',
                        id: item.seriesId,
                        badge: status,
                        meta: archived
                            ? [user]
                            : [user, formatNextEpisode(item.Series), MODE_LABELS[item.notify_type] || item.notify_type]
                    })}
                    <td data-label="Actions">
                        <div class="row-actions">
                            ${modeBtn}
                            ${deleteBtn}
                        </div>
                    </td>
                </tr>
            `;
        }
    },

    films: {
        body: 'watchlist-body',
        filter: 'watchlist-filter',
        columns: ['User', 'Film Title', 'Year', 'Release', 'Actions'],
        table: 'watchlist-table',
        paged: true,
        sorts: {
            // Within a year, by release date
            year: (item) => (item.year ? `${item.year}|${item.premiere_digital || '~'}` : null),
            release: (item) => item.premiere_digital || null
        },
        tabs: {
            active: {
                label: 'Waiting',
                matches: (item) => !item.notified,
                empty: 'No films waiting for release.'
            },
            // Released and announced to the chat; kept as a record
            archive: {
                label: 'Released',
                matches: (item) => Boolean(item.notified),
                empty: 'No released films yet.',
                hint: 'films-archive-hint'
            }
        },
        row: (item) => {
            const user = item.Chat ? chatLabel(item.Chat) : String(item.chatId);
            return `
            <tr class="row-compact">
                <td data-label="User">${escapeHtml(user)}</td>
                <td data-label="Film Title" class="link-cell" data-action="film" data-id="${escapeHtml(item.tmdb_id)}"><span class="link-text">${escapeHtml(item.title)}</span></td>
                <td data-label="Year">${item.year || '—'}</td>
                <td data-label="Release">${escapeHtml(formatReleaseDate(item.premiere_digital))}</td>
                ${compactCell({
                    title: escapeHtml(item.title),
                    action: 'film',
                    id: item.tmdb_id,
                    badge: item.year ? `<span class="compact-year">${item.year}</span>` : '',
                    meta: [user, `Release ${formatReleaseDate(item.premiere_digital)}`]
                })}
                <td data-label="Actions"><button class="btn btn-row btn-row-danger" data-action="delete-film" data-id="${item.id}" aria-label="Delete ${escapeHtml(item.title)} for ${escapeHtml(user)}">${ICON.trash}${btnLabel('Delete')}</button></td>
            </tr>
        `;
        }
    }
};

// --- Tabs ---
// The first tab of each tabbed table is the default
const selectedTab = Object.fromEntries(
    Object.entries(TABLES)
        .filter(([, t]) => t.tabs)
        .map(([type, t]) => [type, Object.keys(t.tabs)[0]])
);

// Last payload per table, so a tab switch can re-slice it without a request
const lastData = {};

// --- Pages ---
const PAGE_SIZES = [10, 25, 50, 100];
const PAGE_SIZE_KEY = 'admin.pageSize.';

function storedPageSize(type) {
    try {
        const n = Number(localStorage.getItem(PAGE_SIZE_KEY + type));
        return PAGE_SIZES.includes(n) ? n : PAGE_SIZES[0];
    } catch {
        return PAGE_SIZES[0];
    }
}

// Per paged table: { page (1-based), size }
const pageState = Object.fromEntries(
    Object.entries(TABLES)
        .filter(([, t]) => t.paged)
        .map(([type]) => [type, { page: 1, size: storedPageSize(type) }])
);

const resetPage = (type) => {
    if (pageState[type]) pageState[type].page = 1;
};

/** "11–20 of 34" and the arrows; hidden while there is nothing to page through. */
function renderPager(type, total) {
    const el = $(`${type}-pager`);
    const state = pageState[type];
    if (!el || !state) return;
    el.hidden = total === 0;
    const pages = Math.max(1, Math.ceil(total / state.size));
    const start = (state.page - 1) * state.size;
    el.querySelector('.pager-info').textContent = `${start + 1}–${Math.min(start + state.size, total)} of ${total}`;
    el.querySelectorAll('[data-step]').forEach((btn) => {
        const step = Number(/** @type {HTMLElement} */ (btn).dataset.step);
        /** @type {HTMLButtonElement} */ (btn).disabled = step < 0 ? state.page <= 1 : state.page >= pages;
    });
}

export function setTablePage(type, step) {
    const state = pageState[type];
    if (!state) return;
    // Read before the re-render: once disabled, the arrow just pressed is no longer activeElement
    const pressed = /** @type {HTMLButtonElement | null} */ (document.activeElement);
    state.page = Math.max(1, state.page + step);
    applyTableFilter(type);

    // On a phone the pager sits several screens below the first card of the new page
    const card = $(TABLES[type].body).closest('.glass-card');
    // An instant jump, like turning a page; a smooth scroll over several screens only delays it
    if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: 'start' });

    // The arrow just pressed may now be disabled, which drops focus to <body>; hand it to the other one
    if (pressed && pressed.disabled && pressed.dataset.step) {
        const other = /** @type {HTMLButtonElement | null} */ (
            $(`${type}-pager`).querySelector(`[data-step="${-Number(pressed.dataset.step)}"]`)
        );
        if (other && !other.disabled) other.focus({ preventScroll: true });
    }
}

function setPageSize(type, size) {
    const state = pageState[type];
    if (!state || !PAGE_SIZES.includes(size)) return;
    state.size = size;
    state.page = 1;
    try {
        localStorage.setItem(PAGE_SIZE_KEY + type, String(size));
    } catch {
        // Private mode: the choice just isn't remembered
    }
    applyTableFilter(type);
}

// --- Sorting ---
// Per table: { key, dir }, or absent for the API's order
const sortState = {};

function sortRows(type, rows) {
    const state = sortState[type];
    const value = state && TABLES[type].sorts[state.key];
    if (!value) return rows;
    const sign = state.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        // Unknown values (TBA, no year) stay at the bottom either way
        if (va === null || vb === null) return Number(va === null) - Number(vb === null);
        return va < vb ? -sign : va > vb ? sign : 0;
    });
}

function updateSortButtons(type) {
    const state = sortState[type];
    all(`[data-action="sort"][data-table="${type}"]`).forEach((btn) => {
        const on = Boolean(state) && state.key === btn.dataset.sort;
        btn.classList.toggle('active', on);
        btn.dataset.dir = on ? state.dir : '';
        const label = btn.innerText.trim();
        btn.setAttribute(
            'aria-label',
            on ? `${label}, sorted ${state.dir === 'asc' ? 'ascending' : 'descending'}` : `Sort by ${label}`
        );
        const th = btn.closest('th');
        if (th) th.setAttribute('aria-sort', on ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
}

/** First click sorts ascending, the next descending, the third restores the API's order. */
export function setTableSort(type, key) {
    const table = TABLES[type];
    if (!table || !table.sorts || !table.sorts[key]) return;
    const state = sortState[type];
    if (!state || state.key !== key) sortState[type] = { key, dir: 'asc' };
    else if (state.dir === 'asc') state.dir = 'desc';
    else delete sortState[type];

    updateSortButtons(type);
    resetPage(type);
    if (lastData[type]) {
        invalidate(`table:${type}`);
        renderTable(type, lastData[type]);
    }
}

/** @returns {any} the selected tab's config, or undefined for an untabbed table */
const currentTab = (type) => TABLES[type].tabs && TABLES[type].tabs[selectedTab[type]];

function visibleColumns(type) {
    const tab = currentTab(type);
    const hides = (tab && tab.hides) || [];
    return TABLES[type].columns.filter((label) => !hides.includes(label));
}

// Scoped to the tab strip: the dashboard card carries the same attribute
const tabButtons = (type) => all(`.tab-filters [data-${type}-tab]`);

function updateTabCounts(type, data) {
    const { tabs } = TABLES[type];
    tabButtons(type).forEach((btn) => {
        const tab = tabs[btn.dataset[`${type}Tab`]];
        if (tab) btn.innerText = `${tab.label} (${data.filter(tab.matches).length})`;
    });
}

export function setTableTab(type, name) {
    const table = TABLES[type];
    if (!table || !table.tabs || !table.tabs[name]) return;
    selectedTab[type] = name;
    resetPage(type);

    tabButtons(type).forEach((btn) => {
        const on = btn.dataset[`${type}Tab`] === name;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
    });
    Object.entries(table.tabs).forEach(([tabName, tab]) => {
        if (tab.hint && $(tab.hint)) $(tab.hint).hidden = tabName !== name;
    });
    const el = $(table.table || `${type}-table`);
    if (el) el.dataset.tab = name;

    // Re-slice what is on screen; before the first response, keep the skeleton in step with the columns
    const body = $(table.body);
    if (lastData[type]) renderTable(type, lastData[type]);
    else if (body && body.querySelector('.skeleton-row')) renderSkeleton(type);
}

// --- Filtering ---
// textContent, not innerText: rows on other pages are display:none, and innerText of an
// unrendered row reads differently from a rendered one
const rowText = (row) => row.textContent.replace(/\s+/g, ' ').toLowerCase();

/** Shows the rows that match the filter and fall on the current page; hides the rest. */
export function applyTableFilter(type) {
    const table = TABLES[type];
    const input = $field(table.filter);
    const body = $(table.body);
    if (!input || !body) return;

    const q = input.value.trim().toLowerCase();
    const rows = /** @type {HTMLElement[]} */ ([...body.querySelectorAll('tr')]);
    // Skeletons and the "no records" line are placeholders, not rows to page through
    const placeholder = Boolean(body.querySelector('.skeleton-row, .empty-cell'));
    const matched = placeholder ? rows : rows.filter((row) => !q || rowText(row).includes(q));

    let shown = matched;
    const state = pageState[type];
    if (state && !placeholder) {
        // Clamp: an auto-refresh or a delete can leave fewer pages than before
        state.page = Math.min(state.page, Math.max(1, Math.ceil(matched.length / state.size)));
        const start = (state.page - 1) * state.size;
        shown = matched.slice(start, start + state.size);
    }
    const visible = new Set(shown);
    rows.forEach((row) => {
        row.style.display = visible.has(row) ? '' : 'none';
    });
    renderPager(type, placeholder ? 0 : matched.length);
}

export function setupFilters() {
    Object.entries(TABLES).forEach(([type, { filter }]) => {
        const el = $(filter);
        if (el)
            el.oninput = () => {
                resetPage(type);
                applyTableFilter(type);
            };
    });
    // Before enhanceSelects(), so the styled dropdown starts on the remembered size
    all('[data-page-size]').forEach((el) => {
        const select = /** @type {HTMLSelectElement} */ (el);
        const type = select.dataset.pageSize;
        if (pageState[type]) select.value = String(pageState[type].size);
        select.addEventListener('change', () => setPageSize(type, Number(select.value)));
    });
}

// --- Placeholder states ---
function fillBody(type, html) {
    const body = $(TABLES[type].body);
    if (!body) return null;
    invalidate(`table:${type}`);
    body.innerHTML = html;
    renderPager(type, 0);
    return body;
}

const fullWidthRow = (type, content) =>
    `<tr><td colspan="${visibleColumns(type).length}" class="empty-cell">${content}</td></tr>`;

export function renderTableMessage(type, message) {
    if (!TABLES[type]) return;
    fillBody(type, fullWidthRow(type, escapeHtml(message)));
}

// Uneven widths read as content rather than as a progress bar
const SKELETON_WIDTHS = ['55%', '80%', '45%', '60%'];

export function renderSkeleton(type, rows = 4) {
    if (!TABLES[type]) return;
    const columns = visibleColumns(type);

    const cells = columns
        .map((label, i) => {
            const isActions = i === columns.length - 1;
            const cls = isActions ? 'skeleton skeleton-btn' : 'skeleton';
            const width = isActions ? '100%' : SKELETON_WIDTHS[i % SKELETON_WIDTHS.length];
            return `<td data-label="${label}"><span class="${cls}" style="width:${width}"></span></td>`;
        })
        .join('');

    // Phones show only this cell and Actions, so the placeholder has the compact card's shape
    const compact =
        '<td class="cell-compact"><span class="skeleton" style="width:55%"></span><span class="skeleton skeleton-sub" style="width:80%"></span></td>';
    fillBody(
        type,
        Array.from(
            { length: rows },
            () => `<tr class="skeleton-row row-compact" aria-hidden="true">${cells}${compact}</tr>`
        ).join('')
    );
}

// --- Rows ---
export function renderTable(type, data) {
    const table = TABLES[type];
    const body = table && $(table.body);
    if (!body) return;

    // The tab is part of the signature — switching it must re-render
    const tab = currentTab(type);
    if (isUnchanged(`table:${type}`, [selectedTab[type] ?? null, data])) return;
    lastData[type] = data;

    if (type === 'chats')
        refill(
            chatsById,
            data.map((c) => [String(c.id), c])
        );
    if (type === 'subs')
        refill(
            subsByKey,
            data.map((s) => [subKey(s.chatId, s.seriesId), s])
        );

    if (tab) updateTabCounts(type, data);
    const rows = sortRows(type, tab ? data.filter(tab.matches) : data);

    if (rows.length === 0) {
        body.innerHTML = fullWidthRow(type, tab ? tab.empty : 'No records found.');
        renderPager(type, 0);
        return;
    }

    body.innerHTML = rows.map(table.row).join('');

    // The rows were just replaced — re-apply whatever filter is active
    applyTableFilter(type);
}
