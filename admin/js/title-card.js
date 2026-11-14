/**
 * One title card for every sheet (the redesign, 06.11): Following, Calendar, Released and the search's
 * Follow sheet. Sections without data are left out. And the poster viewer: a tap on the card's
 * poster opens it large over everything.
 */
import { $, escapeHtml } from './dom.js';
import { openModal, closeModal } from './ui.js';
import { fitTitleSheet } from './title-sheet.js';
import { formatReleaseDate, formatPremiereRu, countryName, compactCountries } from './format.js';

const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}" /></svg>`;

const KP_LOGO =
    '<svg class="kp-logo" width="20" height="20" viewBox="0 0 300 300" aria-hidden="true"><use href="#kp-logo-symbol" /></svg>';

/** A stored poster path ("/abc.jpg") or a full TMDB URL, at a size, through the panel's cache */
export function posterSrc(path, size = 'w185') {
    const file = String(path || '').match(/\/[^/]+\.(?:jpg|jpeg|png|webp)$/i)?.[0];
    return file ? `/api/poster/${size}${file}` : '';
}

/**
 * A film's two date blocks, Release and Digital release, for every card (Released, Following,
 * Calendar): one builder, one date format ("10 Jun 2026", the user's pick 14.11). Without a known
 * digital date the Russian one stands in; the Russian dates otherwise go into the notes.
 * @param {{ release?: string | null, releaseCountries?: string[], ruPremiere?: string | null,
 *   digital?: string | null, digitalCountry?: string | null, ruDigital?: string | null,
 *   ruServices?: string | null }} d
 */
export function filmDateBlocks(d) {
    const countries = compactCountries(d.releaseCountries);
    const digital = d.digital || d.ruDigital;
    const digitalCountry = d.digital ? d.digitalCountry : d.ruDigital ? 'RU' : null;
    const digitalNote =
        d.ruDigital && (d.ruDigital !== digital || digitalCountry !== 'RU')
            ? `In Russia ${formatReleaseDate(d.ruDigital)}${d.ruServices ? ` · ${d.ruServices}` : ''}`
            : d.ruDigital === digital && digitalCountry === 'RU'
              ? d.ruServices || ''
              : '';
    return [
        {
            label: 'Release',
            icon: 'clapperboard',
            value: d.release ? `${formatReleaseDate(d.release)}${countries ? ` · ${countries}` : ''}` : 'Date unknown',
            note:
                d.ruPremiere && !d.releaseCountries?.includes('RU') ? `In Russia ${formatPremiereRu(d.ruPremiere)}` : ''
        },
        {
            label: 'Digital release',
            icon: 'tv',
            value: digital
                ? `${formatReleaseDate(digital)}${digitalCountry ? ` · ${countryName(digitalCountry)}` : ''}`
                : 'Date unknown',
            note: digitalNote
        }
    ];
}

/** The same poster thumbnail in search, Following and Calendar. */
export function titleThumb(path, cls = 'title-thumb', { lazy = true } = {}) {
    const src = posterSrc(path);
    return src
        ? `<img class="${cls}" src="${escapeHtml(src)}" alt=""${lazy ? ' loading="lazy"' : ''} decoding="async" />`
        : `<span class="${cls} title-thumb-empty" aria-hidden="true"></span>`;
}

export const NOTIFY = {
    episode: { short: 'Every episode', long: 'Every episode' },
    first_and_full: { short: 'Ep. 1 + season', long: 'Episode 1 and the whole season' },
    season: { short: 'Season', long: 'When the whole season is out' }
};

/** "Series · 2 seasons", "Series · 2025", "Film · 2017" */
function kindLine(t) {
    if (t.kind === 'tv') {
        const n = Number(t.seasons);
        return ['Series', n > 0 ? `${n} season${n === 1 ? '' : 's'}` : t.year].filter(Boolean).join(' · ');
    }
    return ['Film', t.year].filter(Boolean).join(' · ');
}

function ratingLine(value) {
    const rated = Number.isFinite(value) && value > 0 && value <= 10;
    return rated
        ? `<p class="tc-rating">${icon('star')}<strong>${value.toFixed(1)}</strong><span>/ 10 · TMDB</span></p>`
        : `<p class="tc-rating tc-unrated">${icon('star')}<span>Not rated on TMDB yet</span></p>`;
}

/**
 * A collapsed summary, with the three choices and their hint revealed on demand.
 * @param {{ name: string, current: string, id?: string | null, disabled?: boolean, hint?: boolean }} o
 */
export function notifyField({ name, current, id = null, disabled = false, hint = true }) {
    const optionsId = `notify-options-${name}`;
    const radios = Object.entries(NOTIFY)
        .map(
            ([key, m]) =>
                `<label class="tc-radio"><input type="radio" name="${name}" value="${key}"${id ? ` data-mine="mode" data-id="${escapeHtml(id)}"` : ''}${current === key ? ' checked' : ''} />` +
                `<span class="tc-radio-mark" aria-hidden="true"></span><span>${m.long}</span></label>`
        )
        .join('');
    return (
        `<fieldset class="tc-notify mine-modes"${disabled ? ' disabled' : ''}>` +
        `<button type="button" class="tc-notify-toggle" data-action="tc-notify" aria-expanded="false" aria-controls="${escapeHtml(optionsId)}">` +
        `${icon('bell')}<span class="tc-notify-summary"><span>Notify me</span><strong>${NOTIFY[current]?.long || NOTIFY.episode.long}</strong></span>${icon('chevron-down')}</button>` +
        `<div class="tc-notify-options" id="${escapeHtml(optionsId)}" hidden><fieldset><legend>Notify me</legend><div class="tc-radios">${radios}</div></fieldset>` +
        (hint
            ? `<p class="tc-hint">${icon('bell')}<span>Releases the bot will message you about are marked with a bell in Calendar.</span></p>`
            : '') +
        '</div></fieldset>'
    );
}

/**
 * @param {{
 *   kind: string, title: string, poster?: string | null, seasons?: number | null, year?: string | number | null,
 *   rating?: number | null, genres?: string | null, networks?: string | null, overview?: string | null,
 *   kinopoiskUrl?: string | null, status?: string | null,
 *   premieres?: { season: number, date?: string | null }[],
 *   date?: DateBlock | DateBlock[] | null
 * }} t
 * @typedef {{ label: string, value: string, when?: string, bell?: boolean, note?: string, hint?: string, icon?: string }} DateBlock
 *   `hint`: a quieter line under the note
 * @param {{ titleId?: string, notify?: string, extra?: string, error?: string, actions?: string, close?: string }} [options]
 *   `notify`: the Notify me markup; `extra`: anything between it and the actions; `close`: the modal id
 */
export function titleCard(
    t,
    { titleId = 'mine-card-title', notify = '', extra = '', error = '', actions = '', close = '' } = {}
) {
    const src = posterSrc(t.poster);
    const big = posterSrc(t.poster, 'w500');
    const poster = src
        ? `<button type="button" class="tc-poster" data-action="poster-view" data-src="${escapeHtml(big)}" data-thumb="${escapeHtml(src)}" data-title="${escapeHtml(t.title)}" aria-label="Open the poster of ${escapeHtml(t.title)}"><img src="${escapeHtml(src)}" alt="" decoding="async" />` +
          // The large one starts loading with the card: the server's first download from TMDB takes seconds
          `<img class="tc-poster-preload" src="${escapeHtml(big)}" alt="" hidden fetchpriority="low" /></button>`
        : '<span class="tc-poster tc-poster-empty" aria-hidden="true"></span>';
    const about = [t.genres, t.networks, t.status].filter(Boolean).join(' · ');
    // One date block, or several (a film: in cinemas and online)
    const date = (Array.isArray(t.date) ? t.date : t.date ? [t.date] : [])
        .map(
            (d) =>
                `<div class="tc-date">${icon(d.icon || 'calendar')}<span class="tc-date-text"><span class="tc-date-label">${escapeHtml(d.label)}</span>` +
                `<span class="tc-date-value">${escapeHtml(d.value)}</span>${d.note ? `<span class="tc-date-label">${escapeHtml(d.note)}</span>` : ''}${d.hint ? `<span class="tc-date-hint">${escapeHtml(d.hint)}</span>` : ''}</span>` +
                (d.when || d.bell
                    ? `<span class="tc-date-when">${d.bell ? `<span class="tc-bell" role="img" aria-label="The bot will message you about this" title="The bot will message you about this">${icon('bell')}</span>` : ''}${escapeHtml(d.when || '')}</span>`
                    : '') +
                '</div>'
        )
        .join('');
    const description = t.overview?.trim();
    const overview = description
        ? `<div class="tc-description"><p class="tc-overview" data-clamp><span class="tc-copy">${escapeHtml(description)}</span><span class="tc-tail" hidden><span class="tc-ellipsis">… </span><button type="button" class="tc-more" data-action="tc-more" aria-expanded="false">Show more</button></span></p></div>`
        : '';
    const kinopoisk = t.kinopoiskUrl
        ? `<a class="tc-link" href="${escapeHtml(t.kinopoiskUrl)}" target="_blank" rel="noopener noreferrer">${KP_LOGO}<span>Open on Kinopoisk</span>${icon('external-link')}</a>`
        : '';
    return (
        '<span class="sheet-grabber tc-grabber" aria-hidden="true"></span>' +
        (close
            ? `<button type="button" class="sheet-close" data-close="${close}" aria-label="Close">${icon('x')}</button>`
            : '') +
        `<div class="tc-scroll"><div class="tc-head">${poster}<div class="tc-facts"><h2 id="${titleId}">${escapeHtml(t.title)}</h2>` +
        `<p>${escapeHtml(kindLine(t))}</p>${ratingLine(t.rating)}${about ? `<p>${escapeHtml(about)}</p>` : ''}</div></div>` +
        (t.premieres?.length ? seasonPremieres(t.premieres, titleId) : date) +
        overview +
        notify +
        extra +
        `<div class="tc-footer">${kinopoisk}${error}${actions ? `<div class="tc-actions">${actions}</div>` : ''}</div></div>`
    );
}

/** All title entry points use the same watch/unfollow controls and delegated action. */
export function subscriptionActions(item, disabled = false) {
    return (
        watchButton(item.links) +
        (item.id == null
            ? ''
            : `<button type="button" class="sheet-btn-danger-soft" data-action="mine-ask-unfollow"${disabled ? ' disabled' : ''}>Unfollow</button>`)
    );
}

/** Equal-weight premiere blocks; three per row at most, with full-width incomplete rows. */
function seasonPremieres(premieres, titleId) {
    const gridId = `${titleId}-seasons`;
    const rows = premieres
        .map(({ season, date }, index) => {
            const parsed = /^(\d{4})-(\d{2})-(\d{2})/.exec(date || '');
            const month = parsed
                ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
                      Number(parsed[2]) - 1
                  ]
                : '';
            const value = parsed && month ? `${Number(parsed[3])} ${month}` : 'TBA';
            return `<div class="tc-season"${index >= 3 ? ' hidden' : ''}>${icon('calendar')}<div class="tc-season-text"><span class="tc-season-label">${icon('calendar')}<span>Season ${escapeHtml(season)}</span></span><strong><span>${escapeHtml(value)}</span>${parsed && month ? `<small>${parsed[1]}</small>` : ''}</strong></div></div>`;
        })
        .join('');
    return (
        `<section class="tc-premieres"><h3>Season premieres</h3><div class="tc-season-grid" id="${gridId}" data-columns="${Math.min(3, premieres.length)}">${rows}</div>` +
        (premieres.length > 3
            ? `<button type="button" class="tc-seasons-more" data-action="tc-seasons" data-count="${premieres.length - 3}" aria-expanded="false" aria-controls="${gridId}"><span>Show more · ${premieres.length - 3} seasons</span>${icon('chevron-down')}</button>`
            : '') +
        '</section>'
    );
}

/** The primary Watch link from a title's links, if it has one */
export function watchButton(links) {
    const watch = (links || []).find((l) => l.kind === 'watch');
    return watch
        ? `<a class="sheet-btn-primary tc-watch" href="${escapeHtml(watch.url)}" target="_blank" rel="noopener noreferrer">${icon('play')}<span>${escapeHtml(watch.label || 'Watch on SSPoisk')}</span></a>`
        : '';
}

/** Fit the shared description to available space after opening or updating a title card. */
export function fitDescriptions(root) {
    fitTitleSheet(root);
}

function toggleNotify(button) {
    const field = button.closest('.tc-notify');
    const options = field.querySelector('.tc-notify-options');
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    options.hidden = !open;
    fitDescriptions(field.closest('.modal-content'));
    // All sheet entry points share this handler, including Follow before anything is saved.
    if (!field.dataset.watched) {
        field.dataset.watched = 'true';
        const select = (event) => {
            const radio = /** @type {HTMLInputElement} */ (event.target);
            if (!radio.matches('input[type="radio"]')) return;
            field.querySelector('.tc-notify-summary strong').textContent = NOTIFY[radio.value].long;
            button.setAttribute('aria-expanded', 'false');
            // Return keyboard focus before hiding the selected radio.
            button.focus({ preventScroll: true });
            options.hidden = true;
            fitDescriptions(field.closest('.modal-content'));
        };
        field.addEventListener('change', select);
        // A second tap on the current choice has no change event, but still closes the list.
        field.addEventListener('click', select);
    }
}

function toggleMore(button) {
    const text = button.closest('.tc-overview');
    const open = button.getAttribute('aria-expanded') !== 'true';
    text.classList.toggle('is-open', open);
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? 'Show less' : 'Show more';
    fitDescriptions(button.closest('.modal-content'));
}

function toggleSeasons(button) {
    const open = button.getAttribute('aria-expanded') !== 'true';
    for (const row of [...button.closest('.tc-premieres').querySelectorAll('.tc-season')].slice(3)) row.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.querySelector('span').textContent = open ? 'Show less' : `Show more · ${button.dataset.count} seasons`;
    fitDescriptions(button.closest('.modal-content'));
}

// --- The poster, large ---

function openPoster(button) {
    const modal = $('poster-modal');
    const img = /** @type {HTMLImageElement} */ (modal.querySelector('.poster-view-img'));
    // The small poster fills the box at once, the large one replaces it when it arrives (or now, if cached)
    img.alt = `Poster: ${button.dataset.title}`;
    img.dataset.want = button.dataset.src;
    if (!loadPoster(button.dataset.src)) img.src = button.dataset.thumb;
    openModal('poster-modal');
}

let attempt = 0;
// Only the latest load may change the viewer: one from before a close and reopen keeps quiet
let loader = null;

/**
 * Loads the large poster: blurred under a loading circle until it arrives. The server's first
 * download from TMDB can fail (slow proxy, busy), so it tries twice more before the retry icon.
 * True when it was already cached and is shown at once.
 */
function loadPoster(src, fresh = false) {
    const modal = $('poster-modal');
    const view = modal.querySelector('.poster-view');
    const img = /** @type {HTMLImageElement} */ (modal.querySelector('.poster-view-img'));
    const retry = /** @type {HTMLButtonElement} */ (modal.querySelector('.poster-retry'));
    // A new query string: the same src again would not start a new request after a failure
    const next = () => `${src}?retry=${++attempt}`;
    let url = fresh ? next() : src;
    let left = 2;
    const large = new window.Image();
    loader = large;
    large.onload = large.onerror = (e) => {
        if (loader !== large || !modal.open) return;
        if (e.type === 'error' && left > 0) {
            left -= 1;
            url = next();
            setTimeout(() => loader === large && (large.src = url), 1500);
            return;
        }
        view.removeAttribute('aria-busy');
        if (e.type === 'load') img.src = url;
        else view.classList.add('poster-failed');
        retry.hidden = e.type === 'load';
    };
    view.classList.remove('poster-failed');
    retry.hidden = true;
    large.src = url;
    if (large.complete && large.naturalWidth) {
        img.src = url;
        view.removeAttribute('aria-busy');
        return true;
    }
    view.setAttribute('aria-busy', 'true');
    return false;
}

/** The retry icon after the last failure: the loading circle and its tries again */
function retryPoster() {
    const img = /** @type {HTMLImageElement} */ ($('poster-modal').querySelector('.poster-view-img'));
    loadPoster(img.dataset.want, true);
}

/** A swipe down closes the poster, like a tap anywhere (data-close on the whole view) */
export function setupPosterViewer() {
    const modal = $('poster-modal');
    if (!modal) return;
    let startY = null;
    modal.addEventListener('touchstart', (e) => (startY = e.touches.length === 1 ? e.touches[0].clientY : null), {
        passive: true
    });
    modal.addEventListener('touchend', (e) => {
        if (startY !== null && e.changedTouches[0].clientY - startY > 60) closeModal('poster-modal');
        startY = null;
    });
}

export const titleCardActions = {
    'tc-notify': toggleNotify,
    'tc-more': toggleMore,
    'tc-seasons': toggleSeasons,
    'poster-view': openPoster,
    'poster-retry': retryPoster
};
