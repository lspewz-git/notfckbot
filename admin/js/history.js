/** History: what came out in a year among the serials and movies in the database. */

import { $, escapeHtml } from './dom.js';
import { api } from './api.js';
import { isUnchanged } from './render.js';
import { toast } from './ui.js';
import { PAGE_SIZES } from './pager.js';

// The year on screen; null until the first answer, which picks the latest year with releases
let selectedYear = null;
// The year asked for last, and that request's number: only the latest answer is drawn, so a slow
// answer (an auto-refresh, a year pressed before) can't replace a newer one
let wantedYear = null;
let lastRequest = 0;

const OUT_ARROW =
    '<svg class="icon kp-out" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9" /></svg>';
const SKELETON =
    '<li class="history-skeleton" aria-hidden="true"><span class="skeleton" style="width:45%"></span></li>'.repeat(4);

// A row's shape without its content: as tall as a real one, but not seen or read out
const FILLER_ROW = `
    <li class="history-item history-filler" aria-hidden="true">
        <div class="history-main"><span>&nbsp;</span><span class="history-genres">&nbsp;</span></div>
        <span class="kp-link"><svg class="kp-logo"></svg><span>Kinopoisk</span>${OUT_ARROW}</span>
    </li>`;

// --- Pages: the same choices as the tables; a list of up to the smallest size has no pager ---
const PAGE_SIZE_KEY = 'admin.pageSize.history-';

function storedPageSize(kind) {
    try {
        const n = Number(localStorage.getItem(PAGE_SIZE_KEY + kind));
        return PAGE_SIZES.includes(n) ? n : PAGE_SIZES[0];
    } catch {
        return PAGE_SIZES[0];
    }
}

/** Per list: what it holds, which page is on screen, how many rows a page has. */
const LISTS = {
    series: { action: 'series', items: [], empty: '', page: 0, size: storedPageSize('series') },
    films: { action: 'film', items: [], empty: '', page: 0, size: storedPageSize('films') }
};

/** One title: its name (opens the card), seasons and genres, and the Kinopoisk button. */
function row(item, action) {
    // A serial's seasons out that year, then the genres. The line is kept when there is neither,
    // so every row is as tall and the two cards' pagers line up
    const seasons = item.seasons?.length
        ? `${item.seasons.length > 1 ? 'Seasons' : 'Season'} ${item.seasons.join(', ')}`
        : '';
    const details = [seasons, item.genres.join(', ')].filter(Boolean).join(' · ');
    const genres = `<span class="history-genres">${details ? escapeHtml(details) : '&nbsp;'}</span>`;
    return `
        <li class="history-item">
            <div class="history-main">
                <span class="link-text" data-action="${action}" data-id="${escapeHtml(item.tmdbId)}" role="button" tabindex="0">${escapeHtml(item.title)}</span>
                ${genres}
            </div>
            <a class="kp-link" href="${escapeHtml(item.kinopoiskUrl)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(item.title)} on Kinopoisk">
                <svg class="kp-logo" aria-hidden="true"><use href="#kp-logo-symbol" /></svg><span>Kinopoisk</span>${OUT_ARROW}
            </a>
        </li>`;
}

/** The list's current page, and its pager: "11–20 of 34" and the arrows. */
function drawList(kind) {
    const list = LISTS[kind];
    const total = list.items.length;
    const pages = Math.max(1, Math.ceil(total / list.size));
    // Clamp: a refresh or a bigger page size can leave fewer pages than before
    list.page = Math.min(list.page, pages - 1);
    const start = list.page * list.size;

    const el = $(`history-${kind}`);
    el.removeAttribute('aria-busy');
    const shown = list.items.slice(start, start + list.size);
    // The last page is topped up with invisible rows to the height of a full one, so the card
    // keeps its size from page to page
    const filler = Math.min(list.size, total) - shown.length;
    el.innerHTML = total
        ? shown.map((item) => row(item, list.action)).join('') + FILLER_ROW.repeat(filler)
        : `<li class="history-empty">${escapeHtml(list.empty)}</li>`;

    const pager = $(`history-${kind}-pager`);
    pager.hidden = total <= PAGE_SIZES[0];
    pager.querySelector('.pager-info').textContent = `${start + 1}–${Math.min(start + list.size, total)} of ${total}`;
    pager.querySelectorAll('[data-step]').forEach((btn) => {
        const step = Number(/** @type {HTMLElement} */ (btn).dataset.step);
        /** @type {HTMLButtonElement} */ (btn).disabled = step < 0 ? list.page === 0 : list.page >= pages - 1;
    });
}

function render(data) {
    if (isUnchanged('history', data)) return;
    // Another year starts both lists from their first page
    if (data.year !== selectedYear) Object.values(LISTS).forEach((list) => (list.page = 0));
    selectedYear = data.year;

    // Newest first: the year usually wanted is at the start of the row
    $('history-years').innerHTML = data.years
        .map((year) => {
            const on = year === data.year;
            return `<button class="btn btn-ghost${on ? ' active' : ''}" data-action="history-year" data-year="${year}" aria-pressed="${on}">${year}</button>`;
        })
        .join('');
    $('history-years').hidden = data.years.length === 0;

    const none = data.year === null;
    $('history-series-count').textContent = none ? '' : String(data.series.length);
    $('history-films-count').textContent = none ? '' : String(data.films.length);
    LISTS.series.items = data.series;
    LISTS.series.empty = none
        ? 'Nothing yet: the years fill in after the bot starts.'
        : `No serial had an episode out in ${data.year}.`;
    LISTS.films.items = data.films;
    LISTS.films.empty = none ? 'Nothing yet.' : `No movie came out in ${data.year}.`;
    drawList('series');
    drawList('films');
}

/** Loads the year on screen (or the latest one). Placeholders only before the first answer. */
export async function loadHistory() {
    const lists = ['history-series', 'history-films'];
    if (selectedYear === null) {
        for (const id of lists) if (!$(id).childElementCount) $(id).innerHTML = SKELETON;
    }
    const request = ++lastRequest;
    const year = wantedYear ?? selectedYear;
    try {
        const data = await api(`/history${year ? `?year=${year}` : ''}`);
        if (request !== lastRequest) return;
        wantedYear = null;
        render(data);
    } catch (err) {
        if (request !== lastRequest) return;
        wantedYear = null;
        lists.forEach((id) => {
            if ($(id).querySelector('.history-skeleton'))
                $(id).innerHTML = '<li class="history-empty">Failed to load.</li>';
        });
        throw err;
    }
}

/** A year button. A failed load keeps the year on screen and says so; pressing again retries. */
export async function setHistoryYear(year) {
    if (!Number.isInteger(year) || (year === selectedYear && wantedYear === null)) return;
    wantedYear = year;
    try {
        await loadHistory();
    } catch {
        toast(`Couldn't load ${year}. Try again.`, 'error');
    }
}

/** The arrows under a list. */
export function setHistoryPage(kind, step) {
    const list = LISTS[kind];
    if (!list) return;
    // Read before redrawing: an arrow that ends up disabled drops focus to <body>
    const pressed = /** @type {HTMLButtonElement | null} */ (document.activeElement);
    list.page = Math.max(0, list.page + step);
    drawList(kind);
    if (pressed && pressed.disabled && pressed.dataset.step) {
        const other = /** @type {HTMLButtonElement | null} */ (
            $(`history-${kind}-pager`).querySelector(`[data-step="${-Number(pressed.dataset.step)}"]`)
        );
        if (other && !other.disabled) other.focus({ preventScroll: true });
    }
}

/** The page size selects: the remembered size first, then each change redraws its list. */
export function setupHistory() {
    document.querySelectorAll('[data-history-size]').forEach((el) => {
        const select = /** @type {HTMLSelectElement} */ (el);
        const kind = select.dataset.historySize;
        if (!LISTS[kind]) return;
        select.value = String(LISTS[kind].size);
        select.addEventListener('change', () => {
            const size = Number(select.value);
            if (!PAGE_SIZES.includes(size)) return;
            LISTS[kind].size = size;
            LISTS[kind].page = 0;
            try {
                localStorage.setItem(PAGE_SIZE_KEY + kind, String(size));
            } catch {
                // Private mode: the choice just isn't remembered
            }
            drawList(kind);
        });
    });
}
