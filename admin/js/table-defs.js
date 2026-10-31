/** The three data tables as data: columns, tabs, sort keys, and how one record becomes a row. */

import { escapeHtml } from './dom.js';
import {
    chatDisplayName,
    chatLabel,
    seriesStatusBadge,
    formatReleaseDate,
    releaseExtras,
    formatNextEpisode,
    MODE_LABELS,
    activeLine,
    botLeft,
    chatStatus,
    lastSeenText
} from './format.js';
import { subKey } from './store.js';
import { roleBadge } from './access.js';

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
 * The phone card: the title (with a badge) on one line, the rest as one muted line, and any
 * `more` lines under it. Desktop hides this cell; phones hide every other cell except Actions.
 * @param {{ title: string, action?: string, id?: string, badge?: string, meta: string[], more?: string[] }} card
 */
function compactCell({ title, action, id, badge = '', meta, more = [] }) {
    const titleHtml = action
        ? `<span class="compact-title link-text" data-action="${action}" data-id="${escapeHtml(id)}" role="button" tabindex="0">${title}</span>`
        : `<span class="compact-title">${title}</span>`;
    return `
        <td class="cell-compact">
            <div class="compact-head">${titleHtml}${badge}</div>
            <div class="compact-meta">${meta.filter(Boolean).map(escapeHtml).join(' · ')}</div>
            ${more.map((line) => `<div class="compact-meta">${escapeHtml(line)}</div>`).join('')}
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
export const TABLES = {
    chats: {
        body: 'chats-body',
        filter: 'chats-filter',
        columns: ['Chat ID', 'User / Group', 'Type', 'Status', 'Last active', 'Actions'],
        tabs: {
            all: { label: 'All', matches: () => true, empty: 'No chats yet.' },
            active: { label: 'Active', matches: (item) => !botLeft(item), empty: 'No active chats.' },
            // Blocked the bot, took it out of the group, or gone (src/bot-status.js)
            left: {
                label: 'Left the bot',
                matches: botLeft,
                empty: 'No chat has left the bot.',
                hint: 'chats-left-hint'
            }
        },
        row: (item) => {
            const { badge, note } = chatStatus(item);
            const seen = lastSeenText(item.last_seen_at);
            const noteLine = note ? `<span class="status-note">${escapeHtml(note)}</span>` : '';
            return `
                <tr class="row-compact">
                    <td data-label="Chat ID"><code>${item.id}</code></td>
                    <td data-label="User / Group">${chatDisplayName(item)}${roleBadge(item.panelRole)}</td>
                    <td data-label="Type"><span class="chat-type">${item.type}</span></td>
                    <td data-label="Status"><div class="status-cell">${badge}${noteLine}</div></td>
                    <td data-label="Last active"><span class="last-active">${seen}</span></td>
                    ${compactCell({
                        title: `${chatDisplayName(item)}${roleBadge(item.panelRole)}`,
                        badge,
                        meta: [item.type, String(item.id), activeLine(item.last_seen_at)],
                        more: note ? [note] : []
                    })}
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
            const extras = releaseExtras(item);
            return `
            <tr class="row-compact">
                <td data-label="User">${escapeHtml(user)}</td>
                <td data-label="Film Title" class="link-cell" data-action="film" data-id="${escapeHtml(item.tmdb_id)}"><span class="link-text">${escapeHtml(item.title)}</span></td>
                <td data-label="Year">${item.year || '—'}</td>
                <td data-label="Release">${escapeHtml(formatReleaseDate(item.premiere_digital))}${extras
                    .map((line) => `<span class="release-sub">${escapeHtml(line)}</span>`)
                    .join('')}</td>
                ${compactCell({
                    title: escapeHtml(item.title),
                    action: 'film',
                    id: item.tmdb_id,
                    badge: item.year ? `<span class="compact-year">${item.year}</span>` : '',
                    meta: [user, `Release ${formatReleaseDate(item.premiere_digital)}`],
                    more: extras
                })}
                <td data-label="Actions"><button class="btn btn-row btn-row-danger" data-action="delete-film" data-id="${item.id}" aria-label="Delete ${escapeHtml(item.title)} for ${escapeHtml(user)}">${ICON.trash}${btnLabel('Delete')}</button></td>
            </tr>
        `;
        }
    }
};
