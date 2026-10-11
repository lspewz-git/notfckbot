/** Acting on one subscription or watchlist entry. */

import { $, $field, $img, setText } from './dom.js';
import { api } from './api.js';
import { mutate } from './data.js';
import { openModal, closeModal, showConfirm } from './ui.js';
import { setSelectValue } from './select.js';
import { chatLabel, formatReleaseDate, MODE_LABELS } from './format.js';
import { subsByKey } from './store.js';

/** "/abc.jpg" -> the same TMDB poster, fetched by our server (see /api/poster). */
const posterUrl = (path) => (path ? `/api/poster/w342${path}` : '');

/**
 * Opens the card and fills it from `load()`.
 * @param {() => Promise<{ title: string, meta: string, desc: string, count: string, poster: string }>} load
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
        setText('detail-subs-count', card.count);

        const img = $img('detail-poster');
        img.hidden = !card.poster;
        img.onerror = () => {
            img.hidden = true;
        };
        img.src = card.poster;

        $('detail-loading').style.display = 'none';
        $('detail-ready').style.display = '';
    } catch (e) {
        if (request === detailRequest) $('detail-loading').innerText = 'Failed to load details.';
    }
}

export const openSeriesDetails = (tmdbId) =>
    openDetails(async () => {
        const data = await api(`/series/${tmdbId}`);
        const rating = data.vote_average ? `⭐️ ${data.vote_average.toFixed(1)}` : 'Not rated yet';
        const n = data.subCount;
        return {
            title: data.name,
            meta: `${rating} • ${data.number_of_seasons} season${data.number_of_seasons === 1 ? '' : 's'}`,
            desc: data.overview,
            count: `${n} subscriber${n === 1 ? '' : 's'}`,
            poster: posterUrl(data.poster_path)
        };
    });

export const openFilmDetails = (tmdbId) =>
    openDetails(async () => {
        const data = await api(`/movie/${tmdbId}`);
        const rating = data.vote_average ? `⭐️ ${data.vote_average.toFixed(1)}` : 'Not rated yet';
        const release = data.release_date ? formatReleaseDate(data.release_date) : 'Release date TBA';
        return {
            title: data.title || data.original_title,
            meta: `${rating} • ${release} • ${data.status || 'Unknown status'}`,
            desc: data.overview,
            count: data.notified
                ? `${data.waiting} waiting • ${data.notified} already notified`
                : `${data.waiting} waiting for release`,
            poster: posterUrl(data.poster_path)
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
        if (notify_type === sub.notify_type) return closeModal('mode-modal');

        // POST /api/subscription updates notify_type on an existing row
        const ok = await mutate(
            '/subscription',
            { method: 'POST', body: { chatId: sub.chatId, tmdbId: sub.seriesId, notify_type } },
            `Mode set to "${MODE_LABELS[notify_type]}"`
        );
        if (ok) closeModal('mode-modal');
    };

    openModal('mode-modal');
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
