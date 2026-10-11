/** Test notifications controller: choose recipient and series, preview and send. */

import { $, $field, escapeHtml, debounce } from './dom.js';
import { api } from './api.js';
import { toast, openModal, closeModal } from './ui.js';
import { setSelectValue } from './select.js';
import { chatLabel } from './format.js';
import { chatsById } from './store.js';

let trackedSeries = [];
let searchResults = [];
let selectedSeries = null;
let isSearchMode = false;

export async function openTestNotifyModal(chatId = null, seriesId = null) {
    // 1. Populate chats
    const chatSelect = $field('test-notify-chat-select');
    chatSelect.innerHTML = '';

    let chats = Array.from(chatsById.values());
    if (!chats.length) {
        try {
            chats = await api('/data/chats');
        } catch (e) {
            chats = [];
        }
    }

    if (chats.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No chats found';
        chatSelect.appendChild(opt);
    } else {
        chats.forEach((chat) => {
            const opt = document.createElement('option');
            opt.value = String(chat.id);
            const label = chatLabel(chat);
            opt.textContent = `${label} (${chat.type} • ID ${chat.id})`;
            chatSelect.appendChild(opt);
        });
    }

    if (chatId) {
        setSelectValue('test-notify-chat-select', String(chatId));
    } else if (chats.length > 0) {
        setSelectValue('test-notify-chat-select', String(chats[0].id));
    }

    // 2. Fetch and populate tracked series
    const seriesSelect = $field('test-notify-series-select');
    seriesSelect.innerHTML = '';
    try {
        trackedSeries = await api('/data/series');
    } catch (e) {
        trackedSeries = [];
    }

    if (trackedSeries.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No tracked series in database';
        seriesSelect.appendChild(opt);
        switchSeriesTab('search');
    } else {
        trackedSeries.forEach((s) => {
            const opt = document.createElement('option');
            opt.value = s.tmdb_id;
            opt.textContent = `${s.title} (S${s.last_season || 1}E${s.last_episode || 1})`;
            seriesSelect.appendChild(opt);
        });

        switchSeriesTab('db');

        if (seriesId) {
            const found = trackedSeries.find((s) => s.tmdb_id === seriesId || s.tmdb_id === `tv_${seriesId}`);
            if (found) {
                setSelectValue('test-notify-series-select', found.tmdb_id);
                onTrackedSeriesChange(found.tmdb_id);
            }
        } else {
            setSelectValue('test-notify-series-select', trackedSeries[0].tmdb_id);
            onTrackedSeriesChange(trackedSeries[0].tmdb_id);
        }
    }

    // 3. Reset inputs
    $field('test-series-search-input').value = '';
    $('test-series-search-results').innerHTML = '';
    setSelectValue('test-notify-mode-select', 'episode');

    openModal('test-notify-modal');
}

function onTrackedSeriesChange(seriesId) {
    const s = trackedSeries.find((item) => item.tmdb_id === seriesId);
    if (!s) return;

    selectedSeries = {
        id: s.tmdb_id,
        title: s.title,
        season: s.last_season || 1,
        episode: s.last_episode || 1
    };

    $field('test-notify-season').value = String(selectedSeries.season);
    $field('test-notify-episode').value = String(selectedSeries.episode);
}

export function switchSeriesTab(mode) {
    isSearchMode = mode === 'search';
    $('tab-test-series-db').classList.toggle('active', !isSearchMode);
    $('tab-test-series-search').classList.toggle('active', isSearchMode);

    $('test-series-db-container').style.display = isSearchMode ? 'none' : 'block';
    $('test-series-search-container').style.display = isSearchMode ? 'block' : 'none';

    if (!isSearchMode && trackedSeries.length > 0) {
        const val = $field('test-notify-series-select').value;
        onTrackedSeriesChange(val);
    }
}

export async function searchTmdbSeries(query) {
    const box = $('test-series-search-results');
    if (query.length < 2) {
        searchResults = [];
        box.innerHTML = '';
        box.style.display = 'none';
        return;
    }
    try {
        const res = await api(`/tmdb/search?q=${encodeURIComponent(query)}`);
        searchResults = res.filter((r) => r.media_type === 'tv');
        renderSearchResults();
    } catch (err) {
        toast('Search failed: ' + err.message, 'error');
    }
}

function renderSearchResults() {
    const box = $('test-series-search-results');
    if (!searchResults.length) {
        box.innerHTML = '<p class="empty-note">Ничего не найдено</p>';
        box.style.display = 'block';
        return;
    }

    box.innerHTML = searchResults
        .map((item, idx) => {
            const year = item.first_air_date ? item.first_air_date.split('-')[0] : 'N/A';
            const isChosen = selectedSeries && selectedSeries.id === item.id;
            return `
            <div class="popular-item" data-action="select-test-search-series" data-index="${idx}" style="${isChosen ? 'background: var(--surface-3); font-weight: 600;' : ''}">
                <span class="result-title">${escapeHtml(item.name || item.original_name)} (${year})</span>
                <span class="badge ok">📺 Series</span>
            </div>
        `;
        })
        .join('');
    box.style.display = 'block';
}

export function selectSearchSeries(idx) {
    const item = searchResults[idx];
    if (!item) return;

    selectedSeries = {
        id: item.id,
        title: item.name || item.original_name,
        season: 1,
        episode: 1
    };

    $field('test-notify-season').value = '1';
    $field('test-notify-episode').value = '1';
    $field('test-series-search-input').value = selectedSeries.title;

    $('test-series-search-results').style.display = 'none';
    toast(`Выбран сериал: ${selectedSeries.title}`, 'info');
}

export async function sendTestNotification() {
    const chatId = $field('test-notify-chat-select').value;
    if (!chatId) return toast('Please select a recipient chat', 'warning');

    const seriesId = isSearchMode ? selectedSeries?.id : $field('test-notify-series-select').value;
    if (!seriesId) return toast('Please select a series', 'warning');

    const mode = $field('test-notify-mode-select').value || 'episode';
    const season = parseInt($field('test-notify-season').value, 10) || 1;
    const episode = parseInt($field('test-notify-episode').value, 10) || 1;

    const btn = $field('send-test-notify-btn');
    btn.disabled = true;
    btn.innerText = 'Sending...';

    try {
        await api('/test-notification', {
            method: 'POST',
            body: {
                chatId,
                seriesId,
                mode,
                season,
                episode
            }
        });
        toast('Тестовое уведомление успешно отправлено! 🚀', 'success');
        closeModal('test-notify-modal');
    } catch (e) {
        toast('Ошибка отправки: ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerText = 'Send Notification';
    }
}

export function setupTestNotifyDialog() {
    $('tab-test-series-db').onclick = () => switchSeriesTab('db');
    $('tab-test-series-search').onclick = () => switchSeriesTab('search');

    $field('test-notify-series-select').onchange = (e) => {
        onTrackedSeriesChange(/** @type {HTMLSelectElement} */ (e.target).value);
    };

    $field('test-series-search-input').oninput = debounce((e) => {
        searchTmdbSeries(e.target.value.trim());
    }, 400);

    $('send-test-notify-btn').onclick = sendTestNotification;
}
