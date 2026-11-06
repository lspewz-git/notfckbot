/**
 * One title card for every sheet (the redesign, 06.11): Following, Calendar, Released and the search's
 * Follow sheet. Sections without data are left out. And the poster viewer: a tap on the card's
 * poster opens it large over everything.
 */
import { $, escapeHtml } from './dom.js';
import { openModal, closeModal } from './ui.js';

const icon = (name) =>
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/vendor/lucide.svg#${name}" /></svg>`;

const KP_LOGO =
    '<svg class="kp-logo" width="20" height="20" viewBox="0 0 300 300" aria-hidden="true"><use href="#kp-logo-symbol" /></svg>';

/** A stored poster path ("/abc.jpg") or a full TMDB URL, at a size, through the panel's cache */
export function posterSrc(path, size = 'w185') {
    const file = String(path || '').match(/\/[^/]+\.(?:jpg|jpeg|png|webp)$/i)?.[0];
    return file ? `/api/poster/${size}${file}` : '';
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
 *   kinopoiskUrl?: string | null,
 *   date?: { label: string, value: string, when?: string, bell?: boolean, note?: string } | null
 * }} t
 * @param {{ titleId?: string, notify?: string, extra?: string, actions?: string, close?: string }} [options]
 *   `notify`: the Notify me markup; `extra`: anything between it and the actions; `close`: the modal id
 */
export function titleCard(t, { titleId = 'mine-card-title', notify = '', extra = '', actions = '', close = '' } = {}) {
    const src = posterSrc(t.poster);
    const big = posterSrc(t.poster, 'w500');
    const poster = src
        ? `<button type="button" class="tc-poster" data-action="poster-view" data-src="${escapeHtml(big)}" data-thumb="${escapeHtml(src)}" data-title="${escapeHtml(t.title)}" aria-label="Open the poster of ${escapeHtml(t.title)}"><img src="${escapeHtml(src)}" alt="" decoding="async" /></button>`
        : '<span class="tc-poster tc-poster-empty" aria-hidden="true"></span>';
    const about = [t.genres, t.networks].filter(Boolean).join(' · ');
    const date = t.date
        ? `<div class="tc-date">${icon('calendar')}<span class="tc-date-text"><span class="tc-date-label">${escapeHtml(t.date.label)}</span>` +
          `<span class="tc-date-value">${escapeHtml(t.date.value)}</span>${t.date.note ? `<span class="tc-date-label">${escapeHtml(t.date.note)}</span>` : ''}</span>` +
          (t.date.when || t.date.bell
              ? `<span class="tc-date-when">${t.date.bell ? `<span class="tc-bell" role="img" aria-label="The bot will message you about this" title="The bot will message you about this">${icon('bell')}</span>` : ''}${escapeHtml(t.date.when || '')}</span>`
              : '') +
          '</div>'
        : '';
    const description = t.overview?.trim();
    const overview = description
        ? `<p class="tc-overview" data-clamp>${escapeHtml(description)}</p><button type="button" class="tc-more" data-action="tc-more" aria-expanded="false" hidden>Show more</button>`
        : '';
    const kinopoisk = t.kinopoiskUrl
        ? `<a class="tc-link" href="${escapeHtml(t.kinopoiskUrl)}" target="_blank" rel="noopener noreferrer">${KP_LOGO}<span>Open on Kinopoisk</span>${icon('external-link')}</a>`
        : '';
    return (
        (close
            ? `<button type="button" class="sheet-close" data-close="${close}" aria-label="Close">${icon('x')}</button>`
            : '') +
        `<div class="tc-head">${poster}<div class="tc-facts"><h2 id="${titleId}">${escapeHtml(t.title)}</h2>` +
        `<p>${escapeHtml(kindLine(t))}</p>${ratingLine(t.rating)}${about ? `<p>${escapeHtml(about)}</p>` : ''}</div></div>` +
        date +
        overview +
        kinopoisk +
        notify +
        extra +
        (actions ? `<div class="tc-actions">${actions}</div>` : '')
    );
}

/** The primary Watch link from a title's links, if it has one */
export function watchButton(links) {
    const watch = (links || []).find((l) => l.kind === 'watch');
    return watch
        ? `<a class="sheet-btn-primary tc-watch" href="${escapeHtml(watch.url)}" target="_blank" rel="noopener noreferrer">${icon('play')}<span>${escapeHtml(watch.label || 'Watch on SSPoisk')}</span></a>`
        : '';
}

/** "Show more" only where the three lines cut the text; call once the card is in an open dialog */
export function fitDescriptions(root) {
    for (const text of root.querySelectorAll('[data-clamp]')) {
        const more = /** @type {HTMLElement} */ (text.nextElementSibling);
        if (more?.dataset.action === 'tc-more') more.hidden = text.scrollHeight <= text.clientHeight + 1;
    }
}

function toggleNotify(button) {
    const field = button.closest('.tc-notify');
    const options = field.querySelector('.tc-notify-options');
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    options.hidden = !open;
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
        };
        field.addEventListener('change', select);
        // A second tap on the current choice has no change event, but still closes the list.
        field.addEventListener('click', select);
    }
}

function toggleMore(button) {
    const text = button.previousElementSibling;
    const open = button.getAttribute('aria-expanded') !== 'true';
    text.classList.toggle('is-open', open);
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? 'Show less' : 'Show more';
}

// --- The poster, large ---

function openPoster(button) {
    const modal = $('poster-modal');
    const img = /** @type {HTMLImageElement} */ (modal.querySelector('.poster-view-img'));
    // The small poster shows at once, the large one replaces it when it arrives
    img.src = button.dataset.thumb;
    img.alt = `Poster: ${button.dataset.title}`;
    const large = new window.Image();
    large.onload = () => {
        if (img.dataset.want === button.dataset.src) img.src = button.dataset.src;
    };
    img.dataset.want = button.dataset.src;
    large.src = button.dataset.src;
    openModal('poster-modal');
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
    'poster-view': openPoster
};
