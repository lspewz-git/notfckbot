/** Shared search results and preview cards for the admin panel and My subscriptions. */
import { $, escapeHtml } from './dom.js';
import { openModal } from './ui.js';
import { NOTIFY, notifyField, posterSrc, titleCard, fitDescriptions } from './title-card.js';

/** One rating treatment across account and admin cards. Zero means not rated. */
export function titleRating(value) {
    if (!Number.isFinite(value) || value <= 0 || value > 10) return '';
    return `<span class="title-rating"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#star" /></svg><strong>${value.toFixed(1)}</strong><span class="mine-dim">/ 10 · TMDB</span></span>`;
}

/** Stored posters can be full TMDB URLs; always load them through the panel cache. */
export function titlePoster(url, action, id) {
    const path = String(url || '').match(/\/([^/]+\.(?:jpg|png|webp))$/i)?.[0];
    const image = path
        ? `<img src="/api/poster/w185${escapeHtml(path)}" alt="" loading="lazy" decoding="async" />`
        : '<span class="title-poster-empty" aria-hidden="true"></span>';
    return `<button type="button" class="title-poster" data-action="${action}" data-id="${escapeHtml(id)}" aria-label="Open details">${image}</button>`;
}

/** Keep a short readable preview, with the complete text available without another request. */
export function description(text) {
    const chars = Array.from(text || 'No description available.');
    if (chars.length <= 300) return escapeHtml(chars.join(''));
    const preview = chars
        .slice(0, 299)
        .join('')
        .replace(/\s+\S*$/, '')
        .trimEnd();
    return `<span data-description-short>${escapeHtml(preview)}…</span><span data-description-full hidden>${escapeHtml(chars.join(''))}</span> <button type="button" class="description-toggle" data-action="description-toggle" aria-expanded="false">Show more</button>`;
}

export function toggleDescription(button) {
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    button.parentElement.querySelector('[data-description-short]').hidden = expanded;
    button.parentElement.querySelector('[data-description-full]').hidden = !expanded;
    button.setAttribute('aria-expanded', String(expanded));
    button.textContent = expanded ? 'Show less' : 'Show more';
}

export function searchForm({ context, inputId, query = '', placeholder = 'Series or film title', back = '' }) {
    return `<form class="mine-search" data-content-search="${context}">${back ? `<button type="button" class="btn btn-ghost" data-action="${back}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#arrow-left" /></svg>Back</button>` : ''}<input id="${inputId}" class="input-field" type="search" name="q" placeholder="${escapeHtml(placeholder)}" autocomplete="off" enterkeyhint="search" value="${escapeHtml(query)}" /><button type="submit" class="btn btn-primary">Search</button></form>`;
}

/** Both forms submit on Search or Enter; clearing the field invalidates an old answer. */
export function setupSearchForms(handlers) {
    document.addEventListener('submit', (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        const run = handlers[form.dataset.contentSearch];
        if (!run) return;
        event.preventDefault();
        run(String(new FormData(form).get('q') || '').trim());
    });
    document.addEventListener('input', (event) => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        const form = input.closest('form[data-content-search]');
        if (form && input.value === '') handlers[/** @type {HTMLElement} */ (form).dataset.contentSearch]?.('');
    });
}

export const cardClose = (modal) =>
    `<button type="button" data-close="${modal}" class="modal-x" aria-label="Close"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#x" /></svg></button>`;

/** Both views use the same sheet: the shared title card, its close button and focus. */
export function openSearchCard(item, options) {
    const { modal, bodyId } = options;
    $(modal).innerHTML =
        `<div class="modal-content modal-narrow sheet-content title-sheet" id="${bodyId}">${searchCard(item, options)}</div>`;
    openModal(modal);
    fitDescriptions($(modal));
}

export const MODES = NOTIFY;

/** The Notify me radios (the shared title card's) */
export const modesField = (name, current, id, disabled = false) =>
    notifyField({ name, current, id, disabled, hint: false });

const CHECK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#check" /></svg>';

const thumb = (path) => {
    const src = posterSrc(path);
    return src
        ? `<img class="title-thumb" src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" />`
        : '<span class="title-thumb title-thumb-empty" aria-hidden="true"></span>';
};

/** Adapt TMDB's response once; the account API already returns this shape. */
export function searchItem(r) {
    const date = r.media_type === 'tv' ? r.first_air_date : r.release_date;
    return {
        tmdbId: `${r.media_type}_${r.id}`,
        kind: r.media_type,
        title:
            (r.media_type === 'tv' ? r.name || r.title : r.title || r.name) ||
            r.original_title ||
            r.original_name ||
            'Untitled',
        year: date?.slice(0, 4) || null,
        poster: r.poster_path || null,
        overview: r.overview || '',
        rating: r.vote_average || null,
        released: r.media_type === 'movie' && Boolean(date) && date <= new Date().toISOString().slice(0, 10),
        added: false
    };
}

const noteOf = (r) =>
    [r.kind === 'tv' ? 'Series' : 'Film', r.year, r.kind === 'movie' && r.released ? 'already out' : '']
        .filter(Boolean)
        .join(' · ');

/** Only action names differ; rendering and keyboard access are identical in both views. */
export function searchResults(items, { open, series, film }) {
    if (!items.length)
        return (
            '<div class="empty-state"><span class="empty-icon">' +
            '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#search" /></svg></span>' +
            '<p class="empty-title">Nothing found</p><p class="empty-text">Try another spelling or the original title.</p></div>'
        );
    return `<h2 class="group-title">Results</h2><ul class="group-list title-list">${items
        .map((r, index) => {
            const attrs = `data-id="${escapeHtml(r.tmdbId)}" data-index="${index}"`;
            const action = r.added
                ? `<span class="search-following">${CHECK}Following</span>`
                : `<button type="button" class="follow-btn" data-action="${r.kind === 'tv' ? series : film}" ${attrs} aria-label="Follow ${escapeHtml(r.title)}"><span>Follow</span></button>`;
            return (
                `<li><div class="group-row title-row search-row"><button type="button" class="search-result-open" data-action="${open}" ${attrs}>${thumb(r.poster)}` +
                `<span class="row-text"><span class="row-name">${escapeHtml(r.title)}</span><span class="row-meta">${escapeHtml(noteOf(r))}</span></span></button>${action}</div></li>`
            );
        })
        .join('')}</ul>`;
}

/** The search's Follow sheet: the title card with Notify me for a series, Follow and Cancel */
export function searchCard(r, { modeName, submit, modal, buttonId = '', titleId = 'mine-card-title' }) {
    const label = r.added ? 'Following' : 'Follow';
    return titleCard(
        { kind: r.kind, title: r.title, poster: r.poster, year: r.year, rating: r.rating, overview: r.overview },
        {
            titleId,
            close: modal,
            notify: r.kind === 'tv' && !r.added ? notifyField({ name: modeName, current: 'episode' }) : '',
            actions:
                `<button type="button" ${buttonId ? `id="${buttonId}"` : ''} class="sheet-btn-primary" data-action="${submit}" data-id="${escapeHtml(r.tmdbId)}"${r.added ? ' disabled' : ''}>${label}</button>` +
                `<button type="button" class="sheet-btn-secondary" data-close="${modal}">Cancel</button>`
        }
    );
}
