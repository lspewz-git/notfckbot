/** Acting on one chat: the row menu, messaging, blocking, adding content. */

import { $, setText, escapeHtml, $field } from './dom.js';
import { api } from './api.js';
import { mutate } from './data.js';
import { toast, openModal, closeModal, setReturnTo, clearReturnTo } from './ui.js';
import { chatLabel } from './format.js';
import { chatsById } from './store.js';

// --- The per-row menu ---
// One button per row opens this instead of crowding the Actions column
export function openChatActions(chatId) {
    const chat = chatsById.get(String(chatId));
    if (!chat) return;

    const isBlocked = chat.blockedUntil && new Date(chat.blockedUntil) > new Date();
    const label = chatLabel(chat);
    const backToChat = () => openChatActions(chat.id);

    setText('chat-actions-title', label);
    setText('chat-actions-sub', `${chat.type} • ID ${chat.id}`);

    $('action-add').onclick = () => {
        closeModal('chat-actions-modal');
        setReturnTo(backToChat);
        openAddContentModal(chat.id, label);
    };

    $('action-message').onclick = () => {
        closeModal('chat-actions-modal');
        setReturnTo(backToChat);
        openDM(chat.id, label);
    };

    const blockBtn = $('action-block');
    blockBtn.innerText = isBlocked ? '✅ Unblock' : '🚫 Block';
    blockBtn.classList.toggle('action-row-danger', !isBlocked);
    blockBtn.onclick = () => {
        closeModal('chat-actions-modal');
        if (isBlocked) {
            unblockUser(chat.id);
        } else {
            setReturnTo(backToChat);
            blockUser(chat.id, label);
        }
    };

    openModal('chat-actions-modal');
}

// --- Direct message ---
function openDM(id, name) {
    setText('dm-target-info', `To: ${name || id}`);
    openModal('dm-modal');

    $('confirm-dm').onclick = async () => {
        const message = $field('dm-text').value.trim();
        if (!message) return toast('Enter a message first', 'warning');

        try {
            await api(`/chat/${id}/message`, { method: 'POST', body: { message } });
            toast('Message sent', 'success');
            clearReturnTo();
            closeModal('dm-modal');
            $field('dm-text').value = '';
        } catch (e) {
            toast('Failed to send: ' + e.message, 'error');
        }
    };
}

// --- Block / unblock ---
function blockUser(chatId, label) {
    const input = $field('block-minutes');
    setText('block-target', label ? `${label} • ID ${chatId}` : `ID ${chatId}`);
    input.value = '5';

    const submit = () => {
        const minutes = parseInt(input.value, 10);
        if (!minutes || minutes < 1) return toast('Enter a duration of at least 1 minute', 'warning');

        clearReturnTo();
        closeModal('block-modal');
        mutate(`/chat/${chatId}/block`, { method: 'POST', body: { minutes } }, `Blocked for ${minutes} min`);
    };

    $('confirm-block').onclick = submit;
    input.onkeydown = (e) => {
        if (e.key === 'Enter') submit();
    };

    openModal('block-modal');
    input.focus();
    input.select();
}

const unblockUser = (chatId) => mutate(`/chat/${chatId}/unblock`, { method: 'POST' }, 'Chat unblocked');

// --- Adding a series or a film ---
// One search covering both; the branch happens on submit.
let searchResults = [];
let targetChatId = null;
let selected = null;

function openAddContentModal(chatId, label) {
    targetChatId = chatId;
    selected = null;
    searchResults = [];

    setText('add-content-target', label || chatId);
    $field('content-search-input').value = '';
    $('content-search-results').innerHTML = '';
    $('content-selected').style.display = 'none';

    openModal('add-content-modal');
    $field('content-search-input').focus();
}

export async function searchContent(query) {
    if (query.length < 2) return;
    try {
        const res = await api(`/tmdb/search?q=${encodeURIComponent(query)}`);
        searchResults = res.filter((r) => r.media_type === 'tv' || r.media_type === 'movie');
        renderContentResults();
    } catch (err) {
        toast('Search failed: ' + err.message, 'error');
    }
}

function renderContentResults() {
    const box = $('content-search-results');
    if (!searchResults.length) {
        box.innerHTML = '<p class="empty-note">Nothing found.</p>';
        return;
    }

    box.innerHTML = searchResults
        .map((item, idx) => {
            const isTv = item.media_type === 'tv';
            const title = isTv ? item.name : item.title;
            const year = (isTv ? item.first_air_date : item.release_date)?.split('-')[0] || 'N/A';
            const poster = item.poster_path
                ? `<img class="result-poster" src="https://image.tmdb.org/t/p/w92${item.poster_path}" alt="">`
                : '<div class="poster-stub">?</div>';
            return `
            <div class="popular-item" data-action="select-content" data-index="${idx}">
                ${poster}
                <span class="result-title">${escapeHtml(title)} (${year})</span>
                <span class="badge ${isTv ? 'ok' : ''}">${isTv ? '📺 Series' : '🎬 Movie'}</span>
            </div>
        `;
        })
        .join('');
}

export function selectContent(idx) {
    const item = searchResults[idx];
    if (!item) return;

    const isTv = item.media_type === 'tv';
    selected = { id: item.id, mediaType: item.media_type, title: isTv ? item.name : item.title };

    setText('selected-content-title', selected.title);
    // Notification mode only makes sense for series
    $('notify-field').style.display = isTv ? 'block' : 'none';
    $('confirm-add-content').innerText = isTv ? 'Add Subscription' : 'Add to Watchlist';
    $('content-selected').style.display = 'block';
}

export async function submitAddContent() {
    if (!selected || !targetChatId) return;

    const isTv = selected.mediaType === 'tv';
    const body = { chatId: targetChatId, tmdbId: selected.id };
    if (isTv) body.notify_type = $field('sub-notify-type').value;

    const ok = await mutate(isTv ? '/subscription' : '/watchlist', { method: 'POST', body }, (res) => {
        if (isTv) return 'Подписка добавлена';
        return res.isReleased ? 'Фильм добавлен, но он уже вышел' : 'Фильм добавлен в список ожидания';
    });

    if (ok) {
        clearReturnTo();
        closeModal('add-content-modal');
    }
}
