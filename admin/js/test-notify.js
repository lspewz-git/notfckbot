/** Test notifications: send any alert the bot can send (episode, status, film) to a chosen chat. */

import { $, $field, escapeHtml, debounce } from './dom.js';
import { api } from './api.js';
import { toast, openModal, closeModal, clearReturnTo } from './ui.js';
import { setSelectValue } from './select.js';
import { chatLabel } from './format.js';
import { chatsById } from './store.js';

// The alerts that come with a season and an episode; the rest (status, film) need neither
const EPISODE_MODES = ['episode', 'first_and_full', 'season'];
// What each kind of title is called in the dialog
const KIND_TEXT = {
    tv: {
        label: 'Series',
        tracked: 'Tracked series',
        placeholder: 'Type series name to search...',
        badge: '📺 Series'
    },
    movie: { label: 'Film', tracked: 'Films on lists', placeholder: 'Type film name to search...', badge: '🎬 Movie' }
};

let trackedSeries = [];
// One entry per film on any chat's list: { tmdb_id, title, year }
let trackedFilms = [];
// tv for the episode and status alerts, movie for "film is out"
let kind = 'tv';
let searchResults = [];
// The pick from the search tab; the tracked tab reads its <select> directly, so
// neither tab's choice can be sent from the other
let searchPick = null;
let isSearchMode = false;
// Only the latest search may render (debounced requests can finish out of order)
let searchRequest = 0;

const kindOf = (mode) => (mode === 'film' ? 'movie' : 'tv');

export async function openTestNotifyModal(chatId = null, seriesId = null) {
    searchPick = null;
    searchResults = [];
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

    // 2. What can be picked: tracked series, and the films on any list
    const [series, films] = await Promise.all([
        api('/data/series').catch(() => []),
        api('/data/films').catch(() => [])
    ]);
    trackedSeries = series;
    const seen = new Set();
    trackedFilms = films
        .filter((f) => !seen.has(f.tmdb_id) && seen.add(f.tmdb_id))
        .map((f) => ({ tmdb_id: f.tmdb_id, title: f.title, year: f.year }));

    // 3. Start on "new episode", with the given series if any
    $field('test-series-search-input').value = '';
    $('test-series-search-results').innerHTML = '';
    setSelectValue('test-notify-mode-select', 'episode');
    kind = 'tv';
    applyKind();
    if (seriesId) {
        const found = trackedSeries.find((s) => s.tmdb_id === seriesId || s.tmdb_id === `tv_${seriesId}`);
        if (found) {
            setSelectValue('test-notify-series-select', found.tmdb_id);
            onTrackedSeriesChange(found.tmdb_id);
        }
    }

    openModal('test-notify-modal');
}

/** Labels, the tracked list and the tabs for the current kind (series or film). */
function applyKind() {
    const text = KIND_TEXT[kind];
    $('test-title-label').textContent = text.label;
    $('tab-test-series-db').textContent = text.tracked;
    $field('test-series-search-input').placeholder = text.placeholder;

    const tracked = kind === 'tv' ? trackedSeries : trackedFilms;
    const select = $field('test-notify-series-select');
    select.innerHTML = tracked.length
        ? tracked
              .map((t) => {
                  const what = kind === 'tv' ? `S${t.last_season || 1}E${t.last_episode || 1}` : t.year || 'no date';
                  return `<option value="${escapeHtml(t.tmdb_id)}">${escapeHtml(t.title)} (${escapeHtml(String(what))})</option>`;
              })
              .join('')
        : `<option value="">${kind === 'tv' ? 'No tracked series in database' : 'No films on any list'}</option>`;
    setSelectValue('test-notify-series-select', tracked.length ? tracked[0].tmdb_id : '');
    switchSeriesTab(tracked.length ? 'db' : 'search');
}

/** The alert type decides the kind of title and whether season and episode apply. */
function onModeChange(mode) {
    $('test-notify-episode-fields').hidden = !EPISODE_MODES.includes(mode);
    const next = kindOf(mode);
    if (next === kind) return;
    kind = next;
    // A series picked in search can't be sent as a film, or the other way round
    searchPick = null;
    searchResults = [];
    $field('test-series-search-input').value = '';
    $('test-series-search-results').innerHTML = '';
    $('test-series-search-results').style.display = 'none';
    applyKind();
}

function onTrackedSeriesChange(seriesId) {
    if (kind !== 'tv') return;
    const s = trackedSeries.find((item) => item.tmdb_id === seriesId);
    if (!s) return;

    // The stored latest episode, when the bot has one; empty means "latest" on the server
    $field('test-notify-season').value = s.last_season ? String(s.last_season) : '';
    $field('test-notify-episode').value = s.last_episode ? String(s.last_episode) : '';
}

export function switchSeriesTab(mode) {
    isSearchMode = mode === 'search';
    $('tab-test-series-db').classList.toggle('active', !isSearchMode);
    $('tab-test-series-search').classList.toggle('active', isSearchMode);

    $('test-series-db-container').style.display = isSearchMode ? 'none' : 'block';
    $('test-series-search-container').style.display = isSearchMode ? 'block' : 'none';

    if (!isSearchMode && kind === 'tv' && trackedSeries.length > 0) {
        onTrackedSeriesChange($field('test-notify-series-select').value);
    } else {
        // Episode numbers from the tracked tab don't apply to a searched title
        $field('test-notify-season').value = '';
        $field('test-notify-episode').value = '';
    }
}

export async function searchTmdbSeries(query) {
    const box = $('test-series-search-results');
    const request = ++searchRequest;
    // Typing again un-picks: what is sent must match what the field shows
    if (!searchPick || query !== searchPick.title) searchPick = null;
    if (query.length < 2) {
        searchResults = [];
        box.innerHTML = '';
        box.style.display = 'none';
        return;
    }
    try {
        const res = await api(`/tmdb/search?q=${encodeURIComponent(query)}`);
        if (request !== searchRequest) return;
        searchResults = res.filter((r) => r.media_type === kind);
        renderSearchResults();
    } catch (err) {
        if (request === searchRequest) toast('Search failed: ' + err.message, 'error');
    }
}

const resultTitle = (item) => item.name || item.title || item.original_name || item.original_title;

function renderSearchResults() {
    const box = $('test-series-search-results');
    if (!searchResults.length) {
        box.innerHTML = '<p class="empty-note">Ничего не найдено</p>';
        box.style.display = 'block';
        return;
    }

    box.innerHTML = searchResults
        .map((item, idx) => {
            const date = item.first_air_date || item.release_date;
            const year = date ? date.split('-')[0] : 'N/A';
            const isChosen = searchPick && searchPick.id === item.id;
            return `
            <div class="popular-item" data-action="select-test-search-series" data-index="${idx}" role="button" tabindex="0" style="${isChosen ? 'background: var(--surface-3); font-weight: 600;' : ''}">
                <span class="result-title">${escapeHtml(resultTitle(item))} (${year})</span>
                <span class="badge ok">${KIND_TEXT[kind].badge}</span>
            </div>
        `;
        })
        .join('');
    box.style.display = 'block';
}

export function selectSearchSeries(idx) {
    const item = searchResults[idx];
    if (!item) return;

    searchPick = { id: item.id, title: resultTitle(item) };

    // Empty = the latest aired episode, filled in by the server
    $field('test-notify-season').value = '';
    $field('test-notify-episode').value = '';
    $field('test-series-search-input').value = searchPick.title;

    $('test-series-search-results').style.display = 'none';
    toast(`Выбрано: ${searchPick.title}`, 'info');
}

export async function sendTestNotification() {
    const chatId = $field('test-notify-chat-select').value;
    if (!chatId) return toast('Please select a recipient chat', 'warning');

    const mode = $field('test-notify-mode-select').value || 'episode';
    const titleId = isSearchMode ? searchPick?.id : $field('test-notify-series-select').value;
    const noun = kind === 'tv' ? 'series' : 'film';
    if (!titleId) {
        return toast(isSearchMode ? `Pick a ${noun} from the search results` : `Please select a ${noun}`, 'warning');
    }

    /** @type {Record<string, unknown>} */
    const body = { chatId, mode, ...(kind === 'tv' ? { seriesId: titleId } : { filmId: titleId }) };
    if (EPISODE_MODES.includes(mode)) {
        // Left empty: the server uses the latest aired episode
        const num = (id) => {
            const n = parseInt($field(id).value, 10);
            return n > 0 ? n : undefined;
        };
        body.season = num('test-notify-season');
        body.episode = num('test-notify-episode');
    }

    const btn = $field('send-test-notify-btn');
    btn.disabled = true;
    btn.innerText = 'Sending...';

    try {
        await api('/test-notification', { method: 'POST', body });
        toast('Тестовое уведомление успешно отправлено! 🚀', 'success');
        // Done: nothing to return to, and a leftover return would fire on some later dialog
        clearReturnTo();
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
    $field('test-notify-mode-select').addEventListener('change', (e) =>
        onModeChange(/** @type {HTMLSelectElement} */ (e.target).value)
    );

    $field('test-series-search-input').oninput = debounce((e) => {
        searchTmdbSeries(e.target.value.trim());
    }, 400);

    $('send-test-notify-btn').onclick = sendTestNotification;
}
