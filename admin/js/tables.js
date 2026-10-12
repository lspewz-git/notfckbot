/** The three data tables on screen: tabs, the filter, placeholders and rendering the rows. */

import { $, $field, all, escapeHtml } from './dom.js';
import { chatsById, subsByKey, subKey, refill } from './store.js';
import { isUnchanged, invalidate } from './render.js';
import { TABLES } from './table-defs.js';
import { resetPage, renderPager, currentPage, stepPage, afterPageTurn, setPageSize, pageSizeOf } from './pager.js';
import { sortRows, toggleSort } from './table-sort.js';

// --- Tabs ---
// The first tab of each tabbed table is the default
const selectedTab = Object.fromEntries(
    Object.entries(TABLES)
        .filter(([, t]) => t.tabs)
        .map(([type, t]) => [type, Object.keys(t.tabs)[0]])
);

// Last payload per table, so a tab switch can re-slice it without a request
const lastData = {};

// --- Pages and sorting (state in pager.js and table-sort.js) ---
export function setTablePage(type, step) {
    // Read before the re-render: once disabled, the arrow just pressed is no longer activeElement
    const pressed = /** @type {HTMLButtonElement | null} */ (document.activeElement);
    if (!stepPage(type, step)) return;
    applyTableFilter(type);
    afterPageTurn(type, pressed);
}

export function setTableSort(type, key) {
    if (!toggleSort(type, key)) return;
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

    const visible = new Set(placeholder ? matched : currentPage(type, matched));
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
        const size = pageSizeOf(type);
        if (size) select.value = String(size);
        select.addEventListener('change', () => {
            if (setPageSize(type, Number(select.value))) applyTableFilter(type);
        });
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
