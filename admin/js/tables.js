/** The three data tables: filters, skeletons and row rendering. */

import { $, $field, all, escapeHtml } from './dom.js';
import { chatDisplayName, chatLabel, seriesStatusBadge, MODE_LABELS } from './format.js';
import { chatsById, subsByKey, subKey, refill } from './store.js';
import { isUnchanged, invalidate } from './render.js';

// The API decides (series ended or canceled on TMDB); the panel keeps no status list of its own
const isArchivedSub = (sub) => Boolean(sub.archived);

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
                <tr>
                    <td data-label="Chat ID"><code>${item.id}</code></td>
                    <td data-label="User / Group">${chatDisplayName(item)}</td>
                    <td data-label="Type"><span class="chat-type">${item.type}</span></td>
                    <td data-label="Status">${status}</td>
                    <td data-label="Actions">
                        <button class="btn btn-ghost" data-action="chat-actions" data-id="${item.id}">Actions</button>
                    </td>
                </tr>
            `;
        }
    },

    subs: {
        body: 'subs-body',
        filter: 'subs-filter',
        columns: ['User', 'Series', 'Status', 'Mode', 'Actions'],
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
                hides: ['Mode']
            }
        },
        row: (item) => {
            const archived = isArchivedSub(item);
            const mode = archived
                ? ''
                : `<td data-label="Mode"><span class="badge ok">${MODE_LABELS[item.notify_type] || item.notify_type}</span></td>`;
            const modeBtn = archived
                ? ''
                : `<button class="btn btn-ghost" data-action="mode" data-key="${subKey(item.chatId, item.seriesId)}">Mode</button>`;
            return `
                <tr>
                    <td data-label="User">${item.Chat ? escapeHtml(chatLabel(item.Chat)) : item.chatId}</td>
                    <td data-label="Series" class="link-cell" data-action="series" data-id="${item.seriesId}">${item.Series ? escapeHtml(item.Series.title) : 'Unknown'}</td>
                    <td data-label="Status">${seriesStatusBadge(item.Series && item.Series.status)}</td>
                    ${mode}
                    <td data-label="Actions">
                        <div class="row-actions">
                            ${modeBtn}
                            <button class="btn btn-danger" data-action="delete-sub" data-chat="${item.chatId}" data-series="${item.seriesId}">Delete</button>
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
        row: (item) => `
            <tr>
                <td data-label="User">${item.Chat ? escapeHtml(chatLabel(item.Chat)) : item.chatId}</td>
                <td data-label="Film Title">${escapeHtml(item.title)}</td>
                <td data-label="Year">${item.year || 'N/A'}</td>
                <td data-label="Release">${item.premiere_digital || 'Unknown'}</td>
                <td data-label="Actions"><button class="btn btn-danger" data-action="delete-film" data-id="${item.id}">Delete</button></td>
            </tr>
        `
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

    tabButtons(type).forEach((btn) => {
        const on = btn.dataset[`${type}Tab`] === name;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
    });
    Object.entries(table.tabs).forEach(([tabName, tab]) => {
        if (tab.hint && $(tab.hint)) $(tab.hint).hidden = tabName !== name;
    });
    const el = $(`${type}-table`);
    if (el) el.dataset.tab = name;

    // Re-slice what is on screen; before the first response, keep the skeleton in step with the columns
    const body = $(table.body);
    if (lastData[type]) renderTable(type, lastData[type]);
    else if (body && body.querySelector('.skeleton-row')) renderSkeleton(type);
}

// --- Filtering ---
export function applyTableFilter(type) {
    const table = TABLES[type];
    const input = $field(table.filter);
    const body = $(table.body);
    if (!input || !body) return;

    const q = input.value.trim().toLowerCase();
    body.querySelectorAll('tr').forEach((row) => {
        row.style.display = !q || row.innerText.toLowerCase().includes(q) ? '' : 'none';
    });
}

export function setupFilters() {
    Object.entries(TABLES).forEach(([type, { filter }]) => {
        const el = $(filter);
        if (el) el.oninput = () => applyTableFilter(type);
    });
}

// --- Placeholder states ---
function fillBody(type, html) {
    const body = $(TABLES[type].body);
    if (!body) return null;
    invalidate(`table:${type}`);
    body.innerHTML = html;
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

    fillBody(
        type,
        Array.from({ length: rows }, () => `<tr class="skeleton-row" aria-hidden="true">${cells}</tr>`).join('')
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
    const rows = tab ? data.filter(tab.matches) : data;

    if (rows.length === 0) {
        body.innerHTML = fullWidthRow(type, tab ? tab.empty : 'No records found.');
        return;
    }

    body.innerHTML = rows.map(table.row).join('');

    // The rows were just replaced — re-apply whatever filter is active
    applyTableFilter(type);
}
