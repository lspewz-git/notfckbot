import { t as i18nText, language } from './i18n.js';
/** Shared search results and preview cards for the admin panel and My subscriptions. */
import { $, escapeHtml } from './dom.js';
import { openModal } from './ui.js';
import { NOTIFY, notifyField, posterSrc, titleThumb, titleCard, fitDescriptions } from './title-card.js';

/** Stored posters can be full TMDB URLs; always load them through the panel cache. */
export function titlePoster(url, action, id) {
    const src = posterSrc(url);
    const image = src
        ? `<img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" />`
        : '<span class="title-poster-empty" aria-hidden="true"></span>';
    return (
        '<button type="button" class="title-poster" data-action="' +
        action +
        '" data-id="' +
        escapeHtml(id) +
        '" aria-label="' +
        i18nText('Open details') +
        '">' +
        image +
        '</button>'
    );
}

export function searchForm({
    context,
    inputId,
    query = '',
    placeholder = i18nText('Series or film title'),
    back = ''
}) {
    return (
        '<form class="mine-search" data-content-search="' +
        context +
        '">' +
        (back
            ? '<button type="button" class="btn btn-ghost" data-action="' +
              back +
              '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-arrow-left" /></svg>' +
              i18nText('Back') +
              '</button>'
            : '') +
        '<input id="' +
        inputId +
        '" class="input-field" type="search" name="q" placeholder="' +
        escapeHtml(placeholder) +
        '" autocomplete="off" enterkeyhint="search" value="' +
        escapeHtml(query) +
        '" /><button type="submit" class="btn btn-primary">' +
        i18nText('Search') +
        '</button></form>'
    );
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
    '<button type="button" data-close="' +
    modal +
    '" class="modal-x" aria-label="' +
    i18nText('Close') +
    '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-x" /></svg></button>';

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

const CHECK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-check" /></svg>';

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
            i18nText('Untitled'),
        year: date?.slice(0, 4) || null,
        englishTitle: r.englishTitle || '',
        poster: r.poster_path || null,
        overview: r.overview || '',
        rating: r.vote_average || null,
        // A search date alone may be a festival. Only a server-confirmed flag says it is out.
        released: r.media_type === 'movie' && r.released === true,
        added: false
    };
}

const noteOf = (r) =>
    [
        r.kind === 'tv' ? i18nText('Series') : i18nText('Film'),
        r.year,
        r.kind === 'movie' && r.released ? i18nText('already out') : ''
    ]
        .filter(Boolean)
        .join(' · ');

/** Only action names differ; rendering and keyboard access are identical in both views. */
export function searchResults(items, { open, series, film }) {
    if (!items.length)
        return (
            '<div class="empty-state"><span class="empty-icon">' +
            '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-search" /></svg></span>' +
            ('<p class="empty-title">' +
                i18nText('Nothing found') +
                '</p><p class="empty-text">' +
                i18nText('Try another spelling or the original title.') +
                '</p></div>')
        );
    return (
        '<h2 class="group-title">' +
        i18nText('Results') +
        '</h2><ul class="group-list title-list">' +
        items
            .map((r, index) => {
                const englishTitle = typeof r.englishTitle === 'string' ? r.englishTitle.trim() : '';
                const alternate =
                    language !== 'en' &&
                    englishTitle &&
                    englishTitle.toLocaleLowerCase() !== r.title.trim().toLocaleLowerCase()
                        ? `<span class="search-title-english" lang="en">${escapeHtml(englishTitle)}</span>`
                        : '';
                const attrs = `data-id="${escapeHtml(r.tmdbId)}" data-index="${index}"`;
                const action = r.added
                    ? `<span class="search-following">${CHECK}${i18nText('Following')}</span>`
                    : '<button type="button" class="follow-btn" data-action="' +
                      (r.kind === 'tv' ? series : film) +
                      '" ' +
                      attrs +
                      ' aria-label="' +
                      i18nText('Follow {{v2}}', { v2: escapeHtml(r.title) }) +
                      '"><span>' +
                      i18nText('Follow') +
                      '</span></button>';
                return (
                    `<li><div class="group-row title-row search-row"><button type="button" class="search-result-open" data-action="${open}" ${attrs}>${titleThumb(r.poster)}` +
                    `<span class="row-text"><span class="row-name">${escapeHtml(r.title)}</span>${alternate}<span class="row-meta">${escapeHtml(noteOf(r))}</span></span></button>${action}</div></li>`
                );
            })
            .join('') +
        '</ul>'
    );
}

/** The search's Follow sheet: the title card with Notify me for a series, Follow and Cancel */
export function searchCard(r, { modeName, submit, modal, buttonId = '', titleId = 'mine-card-title' }) {
    const label = r.added ? i18nText('Following') : i18nText('Follow');
    return titleCard(
        {
            kind: r.kind,
            catalogId: r.tmdbId,
            copyLocalized: true,
            title: r.title,
            poster: r.poster,
            year: r.year,
            rating: r.rating,
            overview: r.overview
        },
        {
            titleId,
            close: modal,
            notify: r.kind === 'tv' && !r.added ? notifyField({ name: modeName, current: 'episode' }) : '',
            actions:
                `<button type="button" ${buttonId ? `id="${buttonId}"` : ''} class="sheet-btn-primary" data-action="${submit}" data-id="${escapeHtml(r.tmdbId)}"${r.added ? ' disabled' : ''}>${label}</button>` +
                ('<button type="button" class="sheet-btn-secondary" data-close="' +
                    modal +
                    '">' +
                    i18nText('Cancel') +
                    '</button>')
        }
    );
}
