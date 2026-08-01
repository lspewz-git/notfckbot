/** Acting on one subscription or watchlist entry. */

import { $, setText } from './dom.js';
import { api } from './api.js';
import { mutate } from './data.js';
import { openModal, closeModal, showConfirm } from './ui.js';
import { setSelectValue } from './select.js';
import { chatLabel, MODE_LABELS } from './format.js';
import { subsByKey } from './store.js';

export async function openSeriesDetails(tmdbId) {
    $('detail-loading').style.display = 'block';
    $('detail-ready').style.display = 'none';
    openModal('detail-modal');

    try {
        const data = await api(`/series/${tmdbId}`);
        setText('detail-title', data.name);
        setText('detail-desc', data.overview || 'No description available.');
        setText('detail-meta', `Rating: ⭐️ ${data.vote_average.toFixed(1)} • Seasons: ${data.number_of_seasons}`);
        setText('detail-subs-count', `${data.subCount} Subscribers`);
        $('detail-poster').src = data.poster_path
            ? `https://image.tmdb.org/t/p/w500${data.poster_path}`
            : 'https://via.placeholder.com/200x300';

        $('detail-loading').style.display = 'none';
        $('detail-ready').style.display = 'block';
    } catch (e) {
        $('detail-loading').innerText = 'Failed to load details.';
    }
}

export function openModeModal(key) {
    const sub = subsByKey.get(key);
    if (!sub) return;

    const title = sub.Series ? sub.Series.title : sub.seriesId;
    const who = sub.Chat ? chatLabel(sub.Chat) : sub.chatId;
    setText('mode-target', `${title} • ${who}`);
    setSelectValue('mode-select', sub.notify_type);

    $('confirm-mode').onclick = async () => {
        const notify_type = $('mode-select').value;
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
        text: 'The user will no longer be notified about this film\'s release.',
        confirmLabel: 'Yes, remove',
        cancelLabel: 'No, keep it',
        onConfirm: () => mutate(`/watchlist/${id}`, { method: 'DELETE' }, 'Removed from watchlist')
    });
}
