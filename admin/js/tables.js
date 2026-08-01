/** The three data tables: filters, skeletons and row rendering. */

import { $, $field, escapeHtml } from './dom.js';
import { chatDisplayName, chatLabel, seriesStatusBadge, MODE_LABELS } from './format.js';
import { chatsById, subsByKey, subKey, refill } from './store.js';
import { isUnchanged, invalidate } from './render.js';

/**
 * Everything that differs between the three tables, in one place: where the
 * rows go, which input filters them, the column labels (also used as
 * data-label for the mobile card layout) and how one record becomes a row.
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
        row: (item) => `
            <tr>
                <td data-label="User">${item.Chat ? escapeHtml(chatLabel(item.Chat)) : item.chatId}</td>
                <td data-label="Series" class="link-cell" data-action="series" data-id="${item.seriesId}">${item.Series ? escapeHtml(item.Series.title) : 'Unknown'}</td>
                <td data-label="Status">${seriesStatusBadge(item.Series && item.Series.status)}</td>
                <td data-label="Mode"><span class="badge ok">${MODE_LABELS[item.notify_type] || item.notify_type}</span></td>
                <td data-label="Actions">
                    <div class="row-actions">
                        <button class="btn btn-ghost" data-action="mode" data-key="${subKey(item.chatId, item.seriesId)}">Mode</button>
                        <button class="btn btn-danger" data-action="delete-sub" data-chat="${item.chatId}" data-series="${item.seriesId}">Delete</button>
                    </div>
                </td>
            </tr>
        `
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
    `<tr><td colspan="${TABLES[type].columns.length}" class="empty-cell">${content}</td></tr>`;

export function renderTableMessage(type, message) {
    if (!TABLES[type]) return;
    fillBody(type, fullWidthRow(type, escapeHtml(message)));
}

// Uneven widths read as content rather than as a progress bar
const SKELETON_WIDTHS = ['55%', '80%', '45%', '60%'];

export function renderSkeleton(type, rows = 4) {
    if (!TABLES[type]) return;
    const { columns } = TABLES[type];

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

    if (isUnchanged(`table:${type}`, data)) return;

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

    if (data.length === 0) {
        body.innerHTML = fullWidthRow(type, 'No records found.');
        return;
    }

    body.innerHTML = data.map(table.row).join('');

    // The rows were just replaced — re-apply whatever filter is active
    applyTableFilter(type);
}
