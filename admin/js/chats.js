/** Acting on one chat: the row menu, messaging, blocking, adding content. */

import { $, setText, $field } from './dom.js';
import { api } from './api.js';
import { mutate } from './data.js';
import { toast, openModal, closeModal, setReturnTo, clearReturnTo, focusField } from './ui.js';
import { chatLabel } from './format.js';
import { setSelectValue } from './select.js';
import { chatsById } from './store.js';
import { openChatStats } from './chat-stats.js';
import { showChanges } from './changes.js';
import { showAccessIn } from './access.js';
import { searchItem, searchResults as resultsView, openSearchCard, searchForm } from './content-search.js';
import { chatChip, openChatPicker } from './chat-picker.js';

// --- The per-row menu ---
// One button per row opens this instead of crowding the Actions column
export function openChatActions(chatId) {
    const chat = chatsById.get(String(chatId));
    if (!chat) return;

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
    setReturnTo(() => openChatActions(chat.id));
    const backToSettings = () => {
        setReturnTo(() => openChatActions(chat.id));
        showAccessIn(chatsById.get(String(chat.id)) || chat, backToSettings);
        openModal('chat-settings-modal');
    };
    const isBlocked = chat.blockedUntil && new Date(chat.blockedUntil) > new Date();
    // Only a person can sign in: private chats get their role and password rows
    showAccessIn(chat, backToSettings);

    const blockBtn = $('action-block');
    blockBtn.querySelector('.action-title').textContent = isBlocked ? 'Unblock' : 'Block';
    blockBtn.querySelector('.action-desc').textContent = isBlocked
        ? 'Let this chat use the bot again'
        : 'Ignore this chat for a while';
    blockBtn.classList.toggle('action-row-danger', !isBlocked);
    blockBtn.onclick = () => {
        closeModal('chat-settings-modal');
        if (isBlocked) {
            clearReturnTo();
            unblockUser(chat.id);
        } else {
            setReturnTo(backToSettings);
            blockUser(chat.id, label);
        }
    };

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
let existingContent = [];
let membership = null;
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
let availableChats = [];
let pickedChatId = '';

const SEARCH_PLACEHOLDER = { tv: 'Search serials...', movie: 'Search movies...' };

const addLabel = (item) => (item.kind === 'tv' ? 'Subscribe' : item.released ? 'Add' : 'Wait for it');

/** The dialog's state for a fresh opening; `kind` and `heading` set what it searches and says. */
function resetAddContent(kind, heading, target) {
    dialogSession += 1;
    contentKind = kind;
    selected = null;
    searchResults = [];
    existingContent = [];
    membership = null;
    pickedChatId = '';
    availableChats = [];

    setText('add-content-heading', heading);
    setText('add-content-target', target);
    $('content-chat-field').hidden = !kind;
    $('content-search-form').innerHTML = searchForm({
        context: 'admin',
        inputId: 'content-search-input',
        placeholder: SEARCH_PLACEHOLDER[kind] || 'Series or film title'
    });
    $('content-search-results').innerHTML = '';
    closeModal('content-card-modal');
}

function openAddContentModal(chatId, label) {
    resetAddContent(null, 'Add for', label || chatId);
    targetChatId = String(chatId);

    openModal('add-content-modal');
    focusField($field('content-search-input'));
}

/**
 * From Serials (`tv`) or Movies (`movie`): add that kind for a chat picked in the dialog.
 * @param {'tv' | 'movie'} kind
 */
export async function openAddContentFor(kind) {
    resetAddContent(kind, kind === 'tv' ? 'Add serial' : 'Add movie', '');

    const session = dialogSession;
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
    if (session !== dialogSession) return;
    availableChats = chats.map((c) => ({
        id: String(c.id),
        title: chatLabel(c),
        type: c.type,
        hint: c.type === 'private' ? 'Private chat' : c.type === 'channel' ? 'Channel' : 'Group'
    }));
    renderContentChat();

    openModal('add-content-modal');
    focusField($field('content-search-input'));
}

function renderContentChat() {
    const chat = availableChats.find((c) => c.id === pickedChatId);
    $('content-chat-field').innerHTML = chatChip({
        title: chat?.title || 'Choose a chat…',
        accent: chat?.type === 'private',
        action: 'content-chat-open'
    });
}

export function openContentChats() {
    const session = dialogSession;
    openChatPicker(availableChats, pickedChatId, (id) => {
        if (session !== dialogSession) return;
        pickedChatId = id;
        renderContentChat();
        renderContentResults();
        $('content-chat-field').querySelector('button').focus({ preventScroll: true });
    });
}

// Only the latest search may fill the list: an older, slower answer (or one for a dialog
// that has since been closed and reopened) is dropped
let searchRequest = 0;

export async function searchContent(query) {
    const request = ++searchRequest;
    const session = dialogSession;
    if (query.length < 2) {
        searchResults = [];
        $('content-search-results').innerHTML = '';
        return;
    }
    $('content-search-results').innerHTML = '<p class="empty-note">Searching…</p>';
    try {
        // The membership list belongs to this opening, not to each search keystroke.
        membership ||= Promise.all([api('/data/subs'), api('/data/films')]).then(([subs, films]) => [
            ...subs.map((s) => ({
                chatId: String(s.chatId),
                tmdbId: String(s.seriesId).startsWith('tv_') ? String(s.seriesId) : `tv_${s.seriesId}`
            })),
            ...films.filter((f) => !f.notified).map((f) => ({ chatId: String(f.chatId), tmdbId: String(f.tmdb_id) }))
        ]);
        const [res, known] = await Promise.all([api(`/tmdb/search?q=${encodeURIComponent(query)}`), membership]);
        if (request !== searchRequest || session !== dialogSession) return;
        existingContent = known;
        searchResults = res
            .filter((r) =>
                contentKind ? r.media_type === contentKind : r.media_type === 'tv' || r.media_type === 'movie'
            )
            .map(searchItem);
        renderContentResults();
    } catch (err) {
        if (request === searchRequest && session === dialogSession) {
            membership = null;
            $('content-search-results').innerHTML = '<p class="empty-note">Search failed. Try again.</p>';
            toast('Search failed: ' + err.message, 'error');
        }
    }
}

function renderContentResults() {
    if ($field('content-search-input').value.trim().length < 2) {
        $('content-search-results').innerHTML = '';
        return;
    }
    const chatId = contentKind ? pickedChatId : targetChatId;
    searchResults.forEach((r) => {
        r.added = existingContent.some((c) => c.chatId === String(chatId) && c.tmdbId === r.tmdbId);
    });
    $('content-search-results').innerHTML = resultsView(searchResults, {
        open: 'select-content',
        series: 'select-content',
        film: 'add-content-film'
    });
}

export function selectContent(idx, quickAdd = false) {
    const item = searchResults[idx];
    if (!item) return;
    // Snapshot the chat with the card: it cannot silently change underneath an add.
    const chatId = contentKind ? pickedChatId : targetChatId;
    selected = { ...item, chatId };
    if (quickAdd) {
        submitAddContent();
        return;
    }
    openSearchCard(item, {
        modeName: 'content-new-mode',
        submit: 'submit-content',
        modal: 'content-card-modal',
        bodyId: 'content-card-body',
        buttonId: 'confirm-add-content',
        titleId: 'content-card-title'
    });
}

export async function submitAddContent() {
    if (!selected || selected.added || adding) return;
    const item = selected;
    if (!item.chatId) {
        closeModal('content-card-modal');
        toast('Choose a chat first', 'error');
        $('content-chat-field').querySelector('button').focus();
        return;
    }
    const session = dialogSession;
    const button = /** @type {HTMLButtonElement | null} */ ($('confirm-add-content'));
    const picked = /** @type {HTMLInputElement | null} */ (
        document.querySelector('input[name="content-new-mode"]:checked')
    );
    const isTv = item.kind === 'tv';
    const body = { chatId: item.chatId, tmdbId: Number(item.tmdbId.split('_')[1]) };
    if (isTv) body.notify_type = picked?.value || 'episode';
    adding = true;
    if (button) {
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.textContent = 'Adding…';
    }
    let ok;
    try {
        ok = await mutate(isTv ? '/subscription' : '/watchlist', { method: 'POST', body }, (res) => {
            if (isTv) return res.created === false ? 'Subscription already exists; mode updated' : 'Subscribed';
            return res.isReleased
                ? 'The film is already out: added to the released ones'
                : 'The bot writes when the film is out';
        });
    } finally {
        adding = false;
        if (button) {
            button.disabled = false;
            button.removeAttribute('aria-busy');
            button.textContent = addLabel(item);
        }
    }
    if (ok && session === dialogSession) {
        existingContent.push({ chatId: String(item.chatId), tmdbId: item.tmdbId });
        const result = searchResults.find((r) => r.tmdbId === item.tmdbId);
        if (result) result.added = true;
        if (selected?.tmdbId === item.tmdbId && selected?.chatId === item.chatId) {
            selected.added = true;
            closeModal('content-card-modal');
        }
        renderContentResults();
    }
}
