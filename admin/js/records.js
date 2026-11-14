/** Acting on one subscription or watchlist entry. */

import { $, $field, setText, escapeHtml } from './dom.js';
import { api } from './api.js';
import { mutate } from './data.js';
import { openModal, closeModal, showConfirm, setReturnTo, clearReturnTo } from './ui.js';
import { setSelectValue } from './select.js';
import { chatLabel, chatDisplayName, formatReleaseDate, MODE_LABELS } from './format.js';
import { subsByKey } from './store.js';
import { titleCard, fitDescriptions, watchButton, filmDateBlocks } from './title-card.js';

/** Keep artwork already shown in the list when the detail response has none. */
const sourcePoster = (source) =>
    source?.closest('tr, .history-item')?.querySelector('.title-poster img')?.getAttribute('src') || '';

/**
 * One group of chats on a card: "Subscribers · 2", then a row per chat with its name and
 * avatar and, for subscriptions, the notification mode.
 * @param {string} label
 * @param {{ chat: { id: number, username: string | null, type: string }, mode?: string }[]} rows
 */
function peopleGroup(label, rows) {
    const items = rows
        .map(({ chat, mode }) => {
            const tag = mode ? `<span class="people-mode">${escapeHtml(MODE_LABELS[mode] || mode)}</span>` : '';
            return `<li>${chatDisplayName(chat)}${tag}</li>`;
        })
        .join('');
    return `<div class="people-group"><h4>${escapeHtml(label)} · ${rows.length}</h4><ul class="people-list">${items}</ul></div>`;
}

/**
 * Points the Kinopoisk button somewhere: the title's page, or a search by its name. Only the
 * address changes, never the label: a label swap a moment after the card opens made the
 * button change width and jump.
 */
function setKinopoiskLink(url, direct) {
    const link = /** @type {HTMLAnchorElement} */ ($('detail-body').querySelector('.tc-link'));
    link.href = url;
    link.title = direct ? '' : 'Kinopoisk search by title';
}

/**
 * The button works from the first moment as a search by title; once the server has the
 * title's Kinopoisk ID (stored, or looked up in Wikidata), it goes straight to the page.
 * `request` drops the answer if another card has been opened since.
 */
async function fillKinopoisk(type, id, title, request) {
    setKinopoiskLink(`https://www.kinopoisk.ru/index.php?kp_query=${encodeURIComponent(title)}`, false);
    try {
        const kp = await api(`/kinopoisk/${type}/${id}`);
        // Without an ID the server's link is a search too; the one above already has the title
        if (request === detailRequest && $('detail-modal').hasAttribute('open') && kp.id)
            setKinopoiskLink(kp.url, true);
    } catch {
        // The search link stays
    }
}

/** One shared title card, filled only by the latest open request. */
let detailRequest = 0;

async function openDetails(load) {
    const request = ++detailRequest;
    const modal = $('detail-modal');
    const body = $('detail-body');
    const fill = (html) => {
        const focused = body.contains(document.activeElement);
        body.innerHTML = html;
        if (focused) body.focus({ preventScroll: true });
    };
    body.innerHTML = titleCard(
        { kind: 'tv', title: 'Loading details…' },
        { titleId: 'detail-title', close: 'detail-modal' }
    );
    openModal('detail-modal');
    try {
        const { people, kinopoisk, ...card } = await load();
        if (request !== detailRequest || !modal.hasAttribute('open')) return;
        const url = `https://www.kinopoisk.ru/index.php?kp_query=${encodeURIComponent(card.title)}`;
        fill(
            titleCard(
                { ...card, kinopoiskUrl: url },
                {
                    titleId: 'detail-title',
                    close: 'detail-modal',
                    extra: `<div class="detail-people">${people}</div>`
                }
            )
        );
        setKinopoiskLink(url, false);
        fitDescriptions(body);
        fillKinopoisk(kinopoisk.type, kinopoisk.id, card.title, request);
    } catch {
        if (request !== detailRequest || !modal.hasAttribute('open')) return;
        fill(
            titleCard(
                { kind: 'tv', title: 'Failed to load details.' },
                { titleId: 'detail-title', close: 'detail-modal' }
            )
        );
        fitDescriptions(body);
    }
}

/** Chat information is the only admin-only part of a title card. */
function titlePeople(details, tv) {
    if (tv) {
        const subs = details.subscribers || [];
        return subs.length ? peopleGroup('Subscribers', subs) : '<p class="people-none">No subscribers.</p>';
    }
    const chats = details.chats || [];
    const waiting = chats.filter((chat) => !chat.notified);
    const notified = chats.filter((chat) => chat.notified);
    return (
        (waiting.length ? peopleGroup('Waiting for release', waiting) : '') +
            (notified.length ? peopleGroup('Already notified', notified) : '') ||
        '<p class="people-none">No chat has this film on its list.</p>'
    );
}

/** Private enrichment never holds up the common public Released card. */
async function releasedPeople(item) {
    const tv = item.kind === 'tv';
    const details = await api(`/${tv ? 'series' : 'movie'}/${item.tmdbId}`);
    return titlePeople(details, tv);
}

/** The date block of a released title: its season's premiere, or a film's release */
function releasedDate(item) {
    if (item.kind === 'tv') {
        const seasons = (item.seasons || []).filter(Boolean);
        if (!seasons.length) return null;
        const premiere = (season) => (item.seasonPremieres || []).find((s) => s.season === season)?.date;
        const [first, ...more] = seasons;
        return {
            label: `Season ${first} premiere`,
            value: formatReleaseDate(premiere(first)),
            note: more.map((season) => `Season ${season}: ${formatReleaseDate(premiere(season))}`).join(' · ')
        };
    }
    const d = item.dates || { release: item.date, ruPremiere: item.ruPremiere, ruDigital: item.ruDigital };
    return filmDateBlocks(d);
}

let releasedRequest = 0;

/**
 * One title card for both scopes; account supplies personal chat actions. Only admins request
 * private subscriber/chat information, which never holds up the card.
 */
export function openReleasedDetails(
    item,
    source,
    admin = false,
    { actions = watchButton(item.links), error = '' } = {}
) {
    const request = ++releasedRequest;
    const tv = item.kind === 'tv';
    const genres = Array.isArray(item.genres) ? item.genres.join(', ') : item.genres;
    $('released-body').innerHTML = titleCard(
        {
            kind: item.kind,
            title: item.title,
            poster: item.poster,
            seasons: tv ? item.seasonCount : null,
            year: tv ? null : item.year,
            rating: item.rating,
            genres,
            networks: item.networks || null,
            overview: item.overview || '',
            kinopoiskUrl: item.kinopoiskUrl || null,
            date: releasedDate(item),
            premieres: tv
                ? (item.seasons || []).map((season) => ({
                      season,
                      date: (item.seasonPremieres || []).find((s) => s.season === season)?.date
                  }))
                : []
        },
        {
            titleId: 'released-title',
            close: 'released-modal',
            actions,
            error,
            extra: admin
                ? '<div id="released-people" class="detail-people"><p class="people-none">Loading chat information…</p></div>'
                : ''
        }
    );
    openModal('released-modal');
    fitDescriptions($('released-modal'));
    if (!admin) return;
    const fill = (html) => {
        if (request !== releasedRequest || !$('released-people')) return;
        $('released-people').innerHTML = html;
        fitDescriptions($('released-modal'));
    };
    releasedPeople(item)
        .then(fill)
        .catch(() => fill('<p class="people-none">Chat information unavailable.</p>'));
}

export const openSeriesDetails = (tmdbId, source = null) => {
    const poster = sourcePoster(source);
    const released = source?.closest('[data-release-year]');
    const year = released?.dataset.releaseYear;
    const seasons = (released?.dataset.releaseSeasons || '').split(',').map(Number).filter(Boolean);
    return openDetails(async () => {
        const data = await api(`/series/${tmdbId}`);
        return {
            kind: 'tv',
            title: data.name || data.original_name,
            seasons: data.number_of_seasons,
            rating: data.vote_average,
            overview: data.overview,
            date: {
                label: year ? `Season premiere in ${year}` : 'Premiere',
                value: year ? 'None listed' : formatReleaseDate(data.first_air_date)
            },
            premieres: year
                ? seasons.map((season) => ({
                      season,
                      date: (data.seasons || []).find((s) => s.season_number === season)?.air_date
                  }))
                : [],
            people: titlePeople(data, true),
            poster: poster || data.poster_path,
            kinopoisk: { type: 'tv', id: String(tmdbId).replace('tv_', '') }
        };
    });
};

export const openFilmDetails = (tmdbId, source = null) =>
    openDetails(async () => {
        const data = await api(`/movie/${tmdbId}`);
        return {
            kind: 'movie',
            title: data.title || data.original_title,
            year: (data.dates?.release || data.release_date || '').slice(0, 4) || null,
            status: data.status || 'Unknown status',
            rating: data.vote_average,
            overview: data.overview,
            date: releasedDate({ kind: 'movie', dates: data.dates || {} }),
            people: titlePeople(data, false),
            poster: sourcePoster(source) || data.poster_path,
            kinopoisk: { type: 'movie', id: String(tmdbId).replace('movie_', '') }
        };
    });

export function openModeModal(key) {
    const sub = subsByKey.get(key);
    if (!sub) return;

    const title = sub.Series ? sub.Series.title : sub.seriesId;
    const who = sub.Chat ? chatLabel(sub.Chat) : sub.chatId;
    setText('mode-target', `${title} • ${who}`);
    setSelectValue('mode-select', sub.notify_type);

    $('confirm-mode').onclick = async () => {
        const notify_type = $field('mode-select').value;
        // Saving ends the flow: nothing to return to
        if (notify_type === sub.notify_type) {
            clearReturnTo();
            return closeModal('mode-modal');
        }

        // POST /api/subscription updates notify_type on an existing row
        const ok = await mutate(
            '/subscription',
            { method: 'POST', body: { chatId: sub.chatId, tmdbId: sub.seriesId, notify_type } },
            `Mode set to "${MODE_LABELS[notify_type]}"`
        );
        if (ok) {
            clearReturnTo();
            closeModal('mode-modal');
        }
    };

    openModal('mode-modal');
}

/**
 * Phones: Mode and Delete behind one button, in a sheet like the chat actions.
 * Cancelling the chosen dialog comes back here.
 */
export function openSubActions(key) {
    const sub = subsByKey.get(key);
    if (!sub) return;
    const back = () => openSubActions(key);

    setText('sub-actions-title', sub.Series ? sub.Series.title : sub.seriesId);
    setText('sub-actions-sub', sub.Chat ? chatLabel(sub.Chat) : String(sub.chatId));
    setText('sub-action-mode-desc', `Now: ${MODE_LABELS[sub.notify_type] || sub.notify_type}`);

    $('sub-action-mode').onclick = () => {
        closeModal('sub-actions-modal');
        setReturnTo(back);
        openModeModal(key);
    };
    $('sub-action-delete').onclick = () => {
        closeModal('sub-actions-modal');
        setReturnTo(back);
        deleteSub(sub.chatId, sub.seriesId);
    };

    openModal('sub-actions-modal');
}

export function deleteSub(chatId, seriesId) {
    showConfirm({
        title: 'Delete subscription?',
        text: 'The user will stop receiving notifications for this series.',
        confirmLabel: 'Yes, delete',
        cancelLabel: 'No, keep it',
        onConfirm: () => mutate(`/subscription/${chatId}/${seriesId}`, { method: 'DELETE' }, 'Subscription deleted')
    });
}

export function deleteWatchlistItem(id) {
    showConfirm({
        title: 'Remove from watchlist?',
        text: "The user will no longer be notified about this film's release.",
        confirmLabel: 'Yes, remove',
        cancelLabel: 'No, keep it',
        onConfirm: () => mutate(`/watchlist/${id}`, { method: 'DELETE' }, 'Removed from watchlist')
    });
}
