/** One Released view for the whole database and a person's selected chat. */
import { $, escapeHtml } from './dom.js';
import { api } from './api.js';
import { toast } from './ui.js';
import { PAGE_SIZES, fillPagers } from './pager.js';
import { enhanceIn } from './select.js';
import { posterSrc } from './title-card.js';
import { openReleasedDetails } from './records.js';

const views = {};
const CHEVRON =
    '<span class="row-chevron"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#chevron-right" /></svg></span>';
const SKELETON =
    '<li class="history-skeleton" aria-hidden="true"><div class="group-row title-row"><span class="title-thumb skeleton"></span><span class="row-skeleton"><span class="skeleton"></span><span class="skeleton"></span></span></div></li>'.repeat(
        4
    );
// Keeps a short last page as tall as the others, so the pager under it doesn't jump
const FILLER = `<li class="history-item history-filler" aria-hidden="true"><div class="group-row title-row"><span class="title-thumb"></span><span class="row-text"><span class="row-name">&nbsp;</span><span class="row-meta">&nbsp;</span></span></div></li>`;

/** The redesign's Released (06.11): years as chips, then Series and Films, each one rounded list */
function markup(prefix) {
    return `<div id="${prefix}-years" class="cat-chips history-years" role="tablist" aria-label="Year"></div><div class="history-grid">${[
        ['series', 'Series'],
        ['films', 'Films']
    ]
        .map(
            ([kind, label]) =>
                `<div class="history-group"><h2 class="group-title history-title">${label}<span id="${prefix}-${kind}-count"></span></h2><ul id="${prefix}-${kind}" class="group-list title-list history-list" aria-busy="true"></ul><div class="pager" id="${prefix}-${kind}-pager" data-pager="history-${kind}" data-pager-label="${label} per page" hidden></div></div>`
        )
        .join('')}</div>`;
}

const thumb = (path) => {
    const src = posterSrc(path);
    return src
        ? `<img class="title-thumb" src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" />`
        : '<span class="title-thumb title-thumb-empty" aria-hidden="true"></span>';
};

/** Separate state per scope; markup, filtering, year changes and paging are shared. */
export function createHistory({ prefix, fetchYear, openTitle }) {
    const root = $(`${prefix}-body`);
    const el = (suffix) => $(`${prefix}-${suffix}`);
    const key = (kind) =>
        prefix === 'history' ? `admin.pageSize.history-${kind}` : `account.pageSize.released-${kind}`;
    const stored = (kind) => {
        try {
            const n = Number(localStorage.getItem(key(kind)));
            return PAGE_SIZES.includes(n) ? n : PAGE_SIZES[0];
        } catch {
            return PAGE_SIZES[0];
        }
    };
    const lists = Object.fromEntries(
        ['series', 'films'].map((kind) => [kind, { items: [], page: 0, size: stored(kind) }])
    );
    let selectedYear = null,
        wantedYear = null,
        lastRequest = 0,
        data = null,
        signature = '',
        query = '';
    const mount = () => {
        if (root.querySelector('.history-grid')) return;
        root.dataset.historyScope = prefix;
        root.innerHTML = markup(prefix);
        signature = '';
        fillPagers(root);
        root.querySelectorAll('select').forEach((select) => {
            const kind = select.dataset.historySize;
            select.value = String(lists[kind].size);
            select.addEventListener('change', () => {
                const size = Number(select.value);
                if (!PAGE_SIZES.includes(size)) return;
                lists[kind].size = size;
                lists[kind].page = 0;
                try {
                    localStorage.setItem(key(kind), String(size));
                } catch {
                    /* Private browsing. */
                }
                draw(kind);
            });
        });
        enhanceIn(root);
        if (data) render(data);
    };
    function row(item) {
        const seasons = item.seasons?.length
            ? `${item.seasons.length > 1 ? 'Seasons' : 'Season'} ${item.seasons.join(', ')}`
            : '';
        const note = [seasons, (item.genres || []).join(', ')].filter(Boolean).join(' · ');
        // The whole row opens the title card; Kinopoisk is inside it, not on the row (the redesign)
        return (
            `<li class="history-item" data-release-year="${selectedYear}" data-release-seasons="${escapeHtml((item.seasons || []).join(','))}">` +
            `<button type="button" class="group-row title-row history-open" data-action="history-open" data-id="${escapeHtml(item.tmdbId)}">${thumb(item.poster)}` +
            `<span class="row-text"><span class="row-name">${escapeHtml(item.title)}</span><span class="row-meta history-genres">${note ? escapeHtml(note) : '&nbsp;'}</span></span>${CHEVRON}</button></li>`
        );
    }
    function draw(kind) {
        const list = lists[kind];
        const items = list.items.filter((item) => String(item.title).toLocaleLowerCase().includes(query));
        const total = items.length;
        list.page = Math.min(list.page, Math.max(0, Math.ceil(total / list.size) - 1));
        const start = list.page * list.size;
        const shown = items.slice(start, start + list.size);
        el(`${kind}-count`).textContent = data?.year == null ? '' : ` · ${total}`;
        el(kind).removeAttribute('aria-busy');
        const empty = query
            ? 'No matching titles'
            : data?.year == null
              ? 'Nothing yet: the years fill in after the bot starts.'
              : kind === 'series'
                ? `No serial had an episode out in ${data.year}.`
                : `No movie came out in ${data.year}.`;
        el(kind).innerHTML = total
            ? shown.map(row).join('') + FILLER.repeat(Math.min(list.size, total) - shown.length)
            : `<li class="history-empty">${escapeHtml(empty)}</li>`;
        const pager = el(`${kind}-pager`);
        pager.hidden = total <= PAGE_SIZES[0];
        pager.querySelector('.pager-info').textContent =
            `${start + 1}–${Math.min(start + list.size, total)} of ${total}`;
        pager.querySelectorAll('button').forEach((btn) => {
            if (!btn.dataset.step) return;
            btn.disabled = Number(btn.dataset.step) < 0 ? list.page === 0 : start + list.size >= total;
        });
    }
    function render(next) {
        const nextSignature = JSON.stringify(next);
        if (signature === nextSignature) return;
        signature = nextSignature;
        if (next.year !== selectedYear)
            Object.values(lists).forEach((list) => {
                list.page = 0;
            });
        selectedYear = next.year;
        data = next;
        el('years').innerHTML = next.years
            .map(
                (year) =>
                    `<button type="button" class="cat-chip${year === next.year ? ' active' : ''}" role="tab" data-action="history-year" data-year="${year}" aria-selected="${year === next.year}"><span>${year}</span></button>`
            )
            .join('');
        el('years').hidden = !next.years.length;
        for (const kind of ['series', 'films']) {
            lists[kind].items = next[kind];
            draw(kind);
        }
    }
    async function load() {
        mount();
        if (!data)
            for (const kind of ['series', 'films']) if (!el(kind).childElementCount) el(kind).innerHTML = SKELETON;
        const request = ++lastRequest;
        try {
            const next = await fetchYear(wantedYear ?? selectedYear);
            if (request !== lastRequest) return;
            wantedYear = null;
            render(next);
        } catch (err) {
            if (request !== lastRequest) return;
            wantedYear = null;
            for (const kind of ['series', 'films'])
                if (el(kind).querySelector('.history-skeleton'))
                    el(kind).innerHTML = '<li class="history-empty">Failed to load.</li>';
            throw err;
        }
    }
    const view = {
        load,
        reset() {
            lastRequest++;
            selectedYear = wantedYear = data = null;
            signature = query = '';
            Object.values(lists).forEach((list) => {
                list.page = 0;
                list.items = [];
            });
            root.replaceChildren();
        },
        filter(value) {
            query = value.trim().toLocaleLowerCase();
            Object.values(lists).forEach((list) => {
                list.page = 0;
            });
            if (data) {
                mount();
                draw('series');
                draw('films');
            }
        },
        async year(year) {
            if (!Number.isInteger(year) || (year === selectedYear && wantedYear === null)) return;
            wantedYear = year;
            try {
                await load();
            } catch {
                toast(`Couldn't load ${year}. Try again.`, 'error');
            }
        },
        page(kind, step) {
            if (!lists[kind]) return;
            const pressed = /** @type {HTMLButtonElement | null} */ (document.activeElement);
            lists[kind].page = Math.max(0, lists[kind].page + step);
            draw(kind);
            if (pressed?.disabled && pressed.dataset.step)
                /** @type {HTMLButtonElement | null} */ (
                    el(`${kind}-pager`).querySelector(`[data-step="${-Number(pressed.dataset.step)}"]`)
                )?.focus({ preventScroll: true });
        },
        open(id, source) {
            for (const kind of ['series', 'films']) {
                const item = lists[kind].items.find((item) => item.tmdbId === id);
                if (item) {
                    openTitle({ ...item, kind: kind === 'series' ? 'tv' : 'movie' }, source);
                    return;
                }
            }
        }
    };
    views[prefix] = view;
    mount();
    return view;
}

const scope = (el) => el.closest('[data-history-scope]')?.dataset.historyScope;
export const openHistoryTitle = (el) => views[scope(el)]?.open(el.dataset.id, el);
export const setHistoryYear = (year, source = null) => views[source ? scope(source) : 'history']?.year(year);
export const setHistoryPage = (kind, step, source = null) =>
    views[source ? scope(source) : 'history']?.page(kind, step);
export const loadHistory = () => views.history.load();
export function setupHistory() {
    createHistory({
        prefix: 'history',
        fetchYear: (year) => api(`/history${year ? `?year=${year}` : ''}`),
        openTitle: (item, source) => openReleasedDetails(item, source, true)
    });
}
