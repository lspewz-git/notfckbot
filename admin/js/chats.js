/** Acting on one chat: the row menu, messaging, blocking, adding content. */

import { $, setText, escapeHtml, $field } from './dom.js';
import { api } from './api.js';
import { mutate } from './data.js';
import { toast, openModal, closeModal, setReturnTo, clearReturnTo, focusField } from './ui.js';
import { chatLabel } from './format.js';
import { setSelectValue } from './select.js';
import { chatsById } from './store.js';
import { openTestNotifyModal } from './test-notify.js';
import { openChatStats } from './chat-stats.js';
import { showChanges } from './changes.js';

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

    $('action-test-notify').onclick = () => {
        closeModal('chat-actions-modal');
        setReturnTo(backToChat);
        openTestNotifyModal(chat.id);
    };

    $('action-settings').onclick = () => {
        closeModal('chat-actions-modal');
        setReturnTo(backToChat);
        openChatSettings(chat, label);
    };

    $('action-stats').onclick = () => {
        closeModal('chat-actions-modal');
        setReturnTo(backToChat);
        openChatStats(chat, label, backToChat);
    };

    $('action-changes').onclick = () => {
        closeModal('chat-actions-modal');
        setReturnTo(backToChat);
        setText('changes-sub', label);
        openModal('changes-modal');
        showChanges($('changes-root'), { path: `/chat/${encodeURIComponent(chat.id)}/changes` }).catch(() => {});
    };

    const blockBtn = $('action-block');
    blockBtn.querySelector('.action-title').textContent = isBlocked ? 'Unblock' : 'Block';
    blockBtn.querySelector('.action-desc').textContent = isBlocked
        ? 'Let this chat use the bot again'
        : 'Ignore this chat for a while';
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
    focusField(input);
    if (document.activeElement === input) input.select();
}

const unblockUser = (chatId) => mutate(`/chat/${chatId}/unblock`, { method: 'POST' }, 'Chat unblocked');

// --- Settings ---
/** The chat's bot settings: who presses its buttons (groups only) and the bottom menu. */
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;

/** The quiet hours selects' options: "Off" and the 24 hours to start, the 24 hours to end. */
export function setupChatSettingsForm() {
    const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${hourLabel(h)}</option>`).join('');
    $('chat-settings-quiet-start').innerHTML = `<option value="">Off</option>${hours}`;
    $('chat-settings-quiet-end').innerHTML = hours;
    // With quiet hours off, there is no end to pick
    $field('chat-settings-quiet-start').addEventListener('change', syncQuietEnd);
}

function syncQuietEnd() {
    const off = $field('chat-settings-quiet-start').value === '';
    const end = $field('chat-settings-quiet-end');
    const shown = /** @type {HTMLElement} */ (end.closest('.custom-select') || end);
    shown.style.visibility = off ? 'hidden' : '';
}

function openChatSettings(chat, label) {
    const group = chat.type !== 'private';
    setText('chat-settings-sub', label);
    $('chat-settings-buttons-field').hidden = !group;
    setSelectValue('chat-settings-buttons', chat.buttons_mode === 'all' ? 'all' : 'owner');
    setSelectValue('chat-settings-menu', chat.menu_enabled === false ? 'off' : 'on');
    const quietOn = Number.isInteger(chat.quiet_start) && Number.isInteger(chat.quiet_end);
    setSelectValue('chat-settings-quiet-start', quietOn ? String(chat.quiet_start) : '');
    setSelectValue('chat-settings-quiet-end', String(quietOn ? chat.quiet_end : 8));
    setSelectValue('chat-settings-timezone', chat.timezone || 'Europe/Moscow');
    setSelectValue('chat-settings-digest-week', chat.digest_week ? 'on' : 'off');
    setSelectValue('chat-settings-digest-month', chat.digest_month ? 'on' : 'off');
    syncQuietEnd();

    const save = /** @type {HTMLButtonElement} */ ($('chat-settings-save'));
    save.onclick = async () => {
        if (save.disabled) return;
        const body = { menu_enabled: $field('chat-settings-menu').value === 'on' };
        if (group) body.buttons_mode = $field('chat-settings-buttons').value;
        const start = $field('chat-settings-quiet-start').value;
        const end = $field('chat-settings-quiet-end').value;
        if (start !== '' && start === end) {
            toast('Quiet hours need different start and end hours', 'warning');
            return;
        }
        body.quiet_start = start === '' ? null : Number(start);
        body.quiet_end = start === '' ? null : Number(end);
        body.timezone = $field('chat-settings-timezone').value;
        body.digest_week = $field('chat-settings-digest-week').value === 'on';
        body.digest_month = $field('chat-settings-digest-month').value === 'on';
        save.disabled = true;
        save.setAttribute('aria-busy', 'true');
        try {
            const ok = await mutate(`/chat/${chat.id}/settings`, { method: 'PATCH', body }, 'Settings saved');
            if (ok) {
                clearReturnTo();
                closeModal('chat-settings-modal');
            }
        } finally {
            save.disabled = false;
            save.removeAttribute('aria-busy');
        }
    };
    openModal('chat-settings-modal');
}

// --- Adding a series or a film ---
// One search covering both; the branch happens on submit.
let searchResults = [];
let targetChatId = null;
let selected = null;
// Counts openings of the dialog, so an add that finishes after it was closed and opened
// again (maybe for another chat) leaves the new one alone
let dialogSession = 0;
// While an add waits for the server
let adding = false;

// Opened from Serials or Movies: only that kind is searched, and the chat is picked in the
// dialog. Null when opened from a chat's menu: both kinds, for that chat.
let contentKind = null;

const SEARCH_PLACEHOLDER = { tv: 'Search serials...', movie: 'Search movies...' };

const addLabel = () => (selected && selected.mediaType === 'tv' ? 'Add Subscription' : 'Add to Watchlist');

/** The dialog's state for a fresh opening; `kind` and `heading` set what it searches and says. */
function resetAddContent(kind, heading, target) {
    dialogSession += 1;
    contentKind = kind;
    selected = null;
    searchResults = [];

    setText('add-content-heading', heading);
    setText('add-content-target', target);
    $('content-chat-field').hidden = !kind;
    const input = $field('content-search-input');
    input.value = '';
    input.placeholder = SEARCH_PLACEHOLDER[kind] || 'Search series or movies...';
    $('content-search-results').innerHTML = '';
    $('content-selected').style.display = 'none';
}

function openAddContentModal(chatId, label) {
    resetAddContent(null, 'Add for', label || chatId);
    targetChatId = chatId;

    openModal('add-content-modal');
    focusField($field('content-search-input'));
}

/**
 * From Serials (`tv`) or Movies (`movie`): add that kind for a chat picked in the dialog.
 * @param {'tv' | 'movie'} kind
 */
export async function openAddContentFor(kind) {
    resetAddContent(kind, kind === 'tv' ? 'Add serial' : 'Add movie', '');

    const select = $field('content-chat-select');
    let chats = Array.from(chatsById.values());
    if (!chats.length) {
        // The Chats table hasn't been loaded in this visit yet
        try {
            chats = await api('/data/chats');
        } catch {
            chats = [];
        }
    }
    // No chat is preselected: one picked by default is easy to miss, and that chat would then
    // get notifications it never asked for
    const options = chats.map(
        (c) =>
            `<option value="${escapeHtml(String(c.id))}">${escapeHtml(chatLabel(c))} (${escapeHtml(c.type)})</option>`
    );
    select.innerHTML = `<option value="">${chats.length ? 'Choose a chat…' : 'No chats yet'}</option>${options.join('')}`;
    // Keeps the styled dropdown's label in step with the new options
    setSelectValue('content-chat-select', '');

    openModal('add-content-modal');
    focusField($field('content-search-input'));
}

// Only the latest search may fill the list: an older, slower answer (or one for a dialog
// that has since been closed and reopened) is dropped
let searchRequest = 0;

export async function searchContent(query) {
    if (query.length < 2) return;
    const request = ++searchRequest;
    const session = dialogSession;
    try {
        const res = await api(`/tmdb/search?q=${encodeURIComponent(query)}`);
        if (request !== searchRequest || session !== dialogSession) return;
        searchResults = res.filter((r) =>
            contentKind ? r.media_type === contentKind : r.media_type === 'tv' || r.media_type === 'movie'
        );
        renderContentResults();
    } catch (err) {
        if (request === searchRequest && session === dialogSession) toast('Search failed: ' + err.message, 'error');
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
                ? // Through our server, like the cards: image.tmdb.org isn't reachable from every network
                  `<img class="result-poster" src="/api/poster/w92${escapeHtml(item.poster_path)}" alt="">`
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
    // Mid-add the button keeps saying "Adding…"; it gets this label when the add ends
    if (!adding) $('confirm-add-content').innerText = addLabel();
    $('content-selected').style.display = 'block';
}

export async function submitAddContent() {
    // From Serials or Movies the chat is whichever is picked in the dialog
    const chatId = contentKind ? $field('content-chat-select').value : targetChatId;
    if (!selected) return;
    if (!chatId) {
        toast('Choose a chat first', 'error');
        /** @type {HTMLElement} */ ($('content-chat-field').querySelector('.custom-select-trigger')).focus();
        return;
    }
    // The server asks TMDB for the title first, which can take a few seconds through the
    // proxy: show that it's working, and don't let a second click add it twice
    const btn = /** @type {HTMLButtonElement} */ ($('confirm-add-content'));
    if (adding) return;
    const session = dialogSession;

    const isTv = selected.mediaType === 'tv';
    const body = { chatId, tmdbId: selected.id };
    if (isTv) body.notify_type = $field('sub-notify-type').value;

    adding = true;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'Adding…';
    let ok;
    try {
        ok = await mutate(isTv ? '/subscription' : '/watchlist', { method: 'POST', body }, (res) => {
            // The server updates the mode of a subscription the chat already has
            if (isTv) return res.created === false ? 'Подписка уже была, режим обновлён' : 'Подписка добавлена';
            return res.isReleased ? 'Фильм добавлен, но он уже вышел' : 'Фильм добавлен в список ожидания';
        });
    } finally {
        adding = false;
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        // For whatever is selected now: another result may have been picked meanwhile
        btn.textContent = addLabel();
    }

    if (ok && session === dialogSession) {
        clearReturnTo();
        closeModal('add-content-modal');
    }
}
