/** Shared search results and preview cards for the admin panel and My subscriptions. */
import { escapeHtml } from './dom.js';

export const MODES = {
    episode: { short: 'Every episode', long: 'Every episode' },
    first_and_full: { short: 'Ep. 1 + season', long: 'Episode 1 and the whole season' },
    season: { short: 'Season', long: 'When the whole season is out' }
};

export const modesField = (name, current, id) =>
    `<fieldset class="mine-modes"><legend class="field-label">Notify me</legend>${Object.entries(MODES)
        .map(
            ([key, m]) =>
                `<label class="mine-radio"><input type="radio" name="${name}" value="${key}"${id ? ` data-mine="mode" data-id="${escapeHtml(id)}"` : ''}${current === key ? ' checked' : ''} /> ${m.long}</label>`
        )
        .join('')}</fieldset>`;

const picture = (path, big = false) =>
    path
        ? `<img class="mine-poster${big ? ' mine-poster-big' : ''}" src="/api/poster/w185${escapeHtml(path)}" alt="" />`
        : `<span class="mine-poster mine-poster-empty${big ? ' mine-poster-big' : ''}" aria-hidden="true"></span>`;

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
        released: r.media_type === 'movie' && Boolean(date) && date <= new Date().toISOString().slice(0, 10),
        added: false
    };
}

/** Only action names differ; rendering and keyboard access are identical in both views. */
export function searchResults(items, { open, series, film }) {
    if (!items.length) return '<p class="empty-note">Nothing found. Try another spelling or the original title.</p>';
    return `<ul class="glass-card mine-rows">${items
        .map((r, index) => {
            const attrs = `data-id="${escapeHtml(r.tmdbId)}" data-index="${index}"`;
            const note = [
                r.kind === 'tv' ? 'Series' : 'Film',
                r.year,
                r.kind === 'movie' && r.released ? 'already out' : ''
            ]
                .filter(Boolean)
                .join(' · ');
            const action = r.added
                ? '<span class="mine-chip">Added</span>'
                : `<button type="button" class="btn btn-outline btn-compact" data-action="${r.kind === 'tv' ? series : film}" ${attrs}>${r.kind === 'tv' ? 'Subscribe' : r.released ? 'Add' : 'Wait for it'}</button>`;
            return `<li><div class="mine-row"><button type="button" class="search-result-open" data-action="${open}" ${attrs}>${picture(r.poster)}<span class="mine-row-text"><span class="mine-row-title">${escapeHtml(r.title)}</span><span class="mine-dim">${escapeHtml(note)}</span></span></button>${action}</div></li>`;
        })
        .join('')}</ul>`;
}

export function searchCard(r, { modeName, submit, modal, buttonId = '', titleId = 'mine-card-title' }) {
    const label = r.added ? 'Added' : r.kind === 'tv' ? 'Subscribe' : r.released ? 'Add' : 'Wait for it';
    return (
        `<div class="mine-card-head">${picture(r.poster, true)}<div><h3 id="${titleId}">${escapeHtml(r.title)}</h3><p class="mine-dim">${escapeHtml([r.kind === 'tv' ? 'Series' : 'Film', r.year, r.kind === 'movie' && r.released ? 'already out' : ''].filter(Boolean).join(' · '))}</p></div></div>` +
        (r.overview ? `<p class="mine-overview">${escapeHtml(r.overview)}</p>` : '') +
        (r.kind === 'tv' && !r.added ? modesField(modeName, 'episode', null) : '') +
        `<div class="modal-actions"><button type="button" ${buttonId ? `id="${buttonId}"` : ''} class="btn btn-primary btn-grow" data-action="${submit}" data-id="${escapeHtml(r.tmdbId)}"${r.added ? ' disabled' : ''}>${label}</button><button type="button" class="btn btn-ghost" data-close="${modal}">Cancel</button></div>`
    );
}
