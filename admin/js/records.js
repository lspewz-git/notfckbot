/** Acting on one subscription or watchlist entry. */

import { $, $field, $img, setText, escapeHtml } from './dom.js';
import { api } from './api.js';
import { mutate } from './data.js';
import { openModal, closeModal, showConfirm, setReturnTo, clearReturnTo } from './ui.js';
import { setSelectValue } from './select.js';
import { chatLabel, chatDisplayName, formatReleaseDate, formatPremiereRu, MODE_LABELS } from './format.js';
import { subsByKey } from './store.js';

/** "/abc.jpg" -> the same TMDB poster, fetched by our server (see /api/poster). */
const posterUrl = (path) => (path ? `/api/poster/w342${path}` : '');

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
    const link = /** @type {HTMLAnchorElement} */ ($('detail-kp'));
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
        if (request === detailRequest && kp.id) setKinopoiskLink(kp.url, true);
    } catch {
        // The search link stays
    }
}

/**
 * Opens the card and fills it from `load()`.
 * @param {() => Promise<{ title: string, meta: string, desc: string, people: string, poster: string,
 *   kinopoisk: { type: 'tv' | 'movie', id: string } }>} load
 */
let detailRequest = 0;

async function openDetails(load) {
    // Only the latest card may fill the dialog: a slow earlier response is dropped
    const request = ++detailRequest;
    $('detail-loading').innerText = 'Loading details…';
    $('detail-loading').style.display = 'block';
    $('detail-ready').style.display = 'none';
    openModal('detail-modal');

    try {
        const card = await load();
        if (request !== detailRequest) return;
        setText('detail-title', card.title);
        setText('detail-meta', card.meta);
        setText('detail-desc', card.desc || 'No description available.');
        $('detail-people').innerHTML = card.people;
        const dates = $('detail-dates');
        dates.innerHTML = card.dates || '';
        dates.hidden = !card.dates;

        const img = $img('detail-poster');
        img.hidden = !card.poster;
        img.onerror = () => {
            img.hidden = true;
        };
        img.src = card.poster;

        $('detail-loading').style.display = 'none';
        $('detail-ready').style.display = '';
        fillKinopoisk(card.kinopoisk.type, card.kinopoisk.id, card.title, request);
    } catch (e) {
        if (request === detailRequest) $('detail-loading').innerText = 'Failed to load details.';
    }
}

export const openSeriesDetails = (tmdbId) =>
    openDetails(async () => {
        const data = await api(`/series/${tmdbId}`);
        const rating = data.vote_average ? `TMDB ⭐️ ${data.vote_average.toFixed(1)}` : 'Not rated on TMDB yet';
        const subs = data.subscribers || [];
        return {
            title: data.name,
            meta: `${rating} • ${data.number_of_seasons} season${data.number_of_seasons === 1 ? '' : 's'}`,
            desc: data.overview,
            people: subs.length ? peopleGroup('Subscribers', subs) : '<p class="people-none">No subscribers.</p>',
            poster: posterUrl(data.poster_path),
            kinopoisk: { type: 'tv', id: String(tmdbId).replace('tv_', '') }
        };
    });

export const openFilmDetails = (tmdbId) =>
    openDetails(async () => {
        const data = await api(`/movie/${tmdbId}`);
        const rating = data.vote_average ? `TMDB ⭐️ ${data.vote_average.toFixed(1)}` : 'Not rated on TMDB yet';
        const d = data.dates || {};
        const row = (label, iso, note, format = formatReleaseDate) =>
            iso ? `<dt>${label}</dt><dd>${escapeHtml(format(iso))}${note ? ` · ${escapeHtml(note)}` : ''}</dd>` : '';
        const dates =
            row('Release', d.release || data.release_date) +
            row('Premiere in Russia', d.ruPremiere, null, formatPremiereRu) +
            (d.digital && !(d.digitalCountry === 'RU' && d.digital === d.ruDigital)
                ? row('Digital', d.digital, d.digitalCountry)
                : '') +
            row('Digital in Russia', d.ruDigital, d.ruServices);
        const chats = data.chats || [];
        const waiting = chats.filter((c) => !c.notified);
        const notified = chats.filter((c) => c.notified);
        const people =
            (waiting.length ? peopleGroup('Waiting for release', waiting) : '') +
            (notified.length ? peopleGroup('Already notified', notified) : '');
        return {
            title: data.title || data.original_title,
            meta: `${rating} • ${data.status || 'Unknown status'}`,
            dates: dates || '<dt>Release</dt><dd>TBA</dd>',
            desc: data.overview,
            people: people || '<p class="people-none">No chat has this film on its list.</p>',
            poster: posterUrl(data.poster_path),
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
