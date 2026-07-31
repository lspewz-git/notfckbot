const API_URL = '/api';

// --- Global State ---
let currentSection = 'dashboard';
let refreshTimer = 10;
let isPaused = true;
let currentLogs = [];
let logFilter = 'all';
let chatsById = new Map();
let subsByKey = new Map();
let contentSearchResults = [];
let addTargetChatId = null;
let selectedContent = null;
// Chat id to reopen the action menu for when a child modal is dismissed
let modalReturnTo = null;

// --- Initialization ---
async function init() {
    fetchData(true); // Initial load runs even though auto-refresh starts paused
    startTimer();
    setupEventListeners();
    setupFilters();
    updatePauseButton();
    enhanceSelects();
}

function getHeaders() {
    const token = localStorage.getItem('adminToken') || '';
    return {
        'Content-Type': 'application/json',
        'X-Admin-Token': token
    };
}

const TABLE_FILTERS = [
    { input: 'chats-filter', body: 'chats-body' },
    { input: 'subs-filter', body: 'subs-body' },
    { input: 'watchlist-filter', body: 'watchlist-body' }
];

function applyTableFilter(inputId, bodyId) {
    const input = document.getElementById(inputId);
    const body = document.getElementById(bodyId);
    if (!input || !body) return;

    const q = input.value.trim().toLowerCase();
    body.querySelectorAll('tr').forEach(row => {
        row.style.display = (!q || row.innerText.toLowerCase().includes(q)) ? '' : 'none';
    });
}

function setupFilters() {
    TABLE_FILTERS.forEach(({ input, body }) => {
        const el = document.getElementById(input);
        if (el) el.oninput = () => applyTableFilter(input, body);
    });
}

// --- Navigation ---
function switchSection(id) {
    currentSection = id;
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const targetSection = document.getElementById(`${id}-section`);
    if (targetSection) targetSection.classList.add('active');

    // Find nav item by text (hacky but works for this demo)
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        if (item.innerText.toLowerCase().includes(id)) item.classList.add('active');
    });

    fetchData(true); // Immediate fetch on switch
}

// --- Data Fetching ---
async function fetchData(isImmediate = false) {
    if (isPaused && !isImmediate) return;

    try {
        const [stats, health, logs, sys] = await Promise.all([
            fetch(`${API_URL}/stats`, { headers: getHeaders() }).then(r => r.json()),
            fetch(`${API_URL}/health`, { headers: getHeaders() }).then(r => r.json()),
            fetch(`${API_URL}/logs`, { headers: getHeaders() }).then(r => r.json()),
            fetch(`${API_URL}/health/system`, { headers: getHeaders() }).then(r => r.json())
        ]);

        updateStats(stats);
        updateHealth(health);
        updateSystem(sys);
        currentLogs = logs;
        renderLogs();

        // Conditional data based on active section
        if (currentSection === 'chats') fetchTypedData('chats');
        if (currentSection === 'subs') fetchTypedData('subs');
        if (currentSection === 'watchlist') fetchTypedData('films');

        // Fetch popular separately since it was just added
        fetch(`${API_URL}/stats/popular`, { headers: getHeaders() }).then(r => r.json()).then(updatePopular);

    } catch (err) {
        console.error('Fetch error:', err);
    }
}

async function fetchTypedData(type) {
    try {
        const data = await fetch(`${API_URL}/data/${type}`, { headers: getHeaders() }).then(r => r.json());
        renderTable(type, data);
    } catch (err) { console.error(`Error loading ${type}:`, err); }
}

// --- UI Updates ---
function updateStats(stats) {
    setText('chats-count', stats.chatsCount);
    setText('subs-count', stats.subsCount);
    setText('films-count', stats.filmsCount);
}

function updateHealth(h) {
    updateBadge('health-tg', h.telegram ? 'TG: OK' : 'TG: ERR', h.telegram ? 'ok' : 'error');
    updateBadge('health-tmdb', h.tmdb ? 'TMDB: OK' : 'TMDB: ERR', h.tmdb ? 'ok' : 'error');

    let proxyText = 'Proxy: OFF';
    let proxyClass = 'ghost';
    if (h.proxy === 'ok') { proxyText = 'Proxy: OK'; proxyClass = 'ok'; }
    else if (h.proxy === 'error') { proxyText = 'Proxy: ERR'; proxyClass = 'error'; }
    updateBadge('health-proxy', proxyText, proxyClass);
}

function updateSystem(sys) {
    if (!sys) return;

    // CPU
    setText('sys-cpu-val', `${sys.cpu}%`);
    document.getElementById('sys-cpu-bar').style.width = `${sys.cpu}%`;

    // RAM
    setText('sys-mem-val', `${sys.mem}%`);
    document.getElementById('sys-mem-bar').style.width = `${sys.mem}%`;

    // Info
    setText('sys-uptime', sys.uptime);
    setText('sys-platform', `${sys.platform} (${sys.arch})`);
}

function updatePopular(list) {
    const container = document.getElementById('popular-list');
    if (!list || list.length === 0) {
        container.innerHTML = '<p style="text-align:center;color:var(--text-dim)">No data yet.</p>';
        return;
    }
    container.innerHTML = list.map((item, idx) => `
        <div class="popular-item" onclick="openSeriesDetails('${item.seriesId}')">
            <div class="popular-rank">${idx + 1}</div>
            <div style="flex:1">
                <div style="font-weight:600">${item.Series.title}</div>
                <div style="font-size:0.75rem; color:var(--text-dim)">${item.subCount} subscribers</div>
            </div>
            <div style="font-size:1.2rem; color:var(--primary)">›</div>
        </div>
    `).join('');
}

// --- Log Rendering ---
function renderLogs() {
    const viewer = document.getElementById('logs-viewer');
    const filtered = currentLogs.filter(l => {
        if (logFilter === 'all') return true;
        if (logFilter === 'error') return l.type === 'error' || l.text.includes('❌');
        if (logFilter === 'success') return l.text.includes('✅');
        return true;
    });

    viewer.innerHTML = filtered.map(l => `
        <div class="log-entry ${l.type}">
            <span class="log-time" style="color:var(--text-dim); font-size: 0.75rem;">${l.time}</span>
            <span class="type-tag">${l.type}</span>
            <span class="log-text">${l.text}</span>
        </div>
    `).join('');

    // Auto-scroll to bottom
    viewer.scrollTop = viewer.scrollHeight;
}

function filterLogs(type) {
    logFilter = type;
    document.querySelectorAll('.log-filters .btn').forEach(b => {
        b.classList.toggle('active', b.innerText.toLowerCase() === type);
    });
    renderLogs();
}

// --- Table Rendering ---
function renderTable(type, data) {
    const bodyId = type === 'films' ? 'watchlist-body' : `${type}-body`;
    const body = document.getElementById(bodyId);
    if (!body) return;

    // Keep the raw records around — the action menu reads them by id instead of
    // smuggling names through onclick attributes.
    if (type === 'chats') chatsById = new Map(data.map(c => [String(c.id), c]));
    if (type === 'subs') subsByKey = new Map(data.map(s => [subKey(s.chatId, s.seriesId), s]));

    if (data.length === 0) {
        body.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-dim)">No records found.</td></tr>`;
        return;
    }

    body.innerHTML = data.map(item => {
        if (type === 'chats') {
            const isBlocked = item.blockedUntil && new Date(item.blockedUntil) > new Date();
            const status = isBlocked ? `<span class="badge error">Blocked</span>` : `<span class="badge ok">Active</span>`;
            return `
                <tr>
                    <td><code>${item.id}</code></td>
                    <td>${chatDisplayName(item)}</td>
                    <td><span style="font-size:0.7rem; text-transform:uppercase">${item.type}</span></td>
                    <td>${status}</td>
                    <td>
                        <button class="btn btn-ghost" onclick="openChatActions('${item.id}')">Actions</button>
                    </td>
                </tr>
            `;
        }
        if (type === 'subs') {
            const key = subKey(item.chatId, item.seriesId);
            return `
                <tr>
                    <td>${item.Chat ? escapeHtml(chatLabel(item.Chat)) : item.chatId}</td>
                    <td style="cursor:pointer; color:var(--primary)" onclick="openSeriesDetails('${item.seriesId}')">${item.Series ? escapeHtml(item.Series.title) : 'Unknown'}</td>
                    <td>${seriesStatusBadge(item.Series && item.Series.status)}</td>
                    <td><span class="badge ok">${MODE_LABELS[item.notify_type] || item.notify_type}</span></td>
                    <td>
                        <div class="row-actions">
                            <button class="btn btn-ghost" onclick="openModeModal('${key}')">Mode</button>
                            <button class="btn btn-danger" onclick="deleteSub('${item.chatId}', '${item.seriesId}')">Delete</button>
                        </div>
                    </td>
                </tr>
            `;
        }
        if (type === 'films') {
            return `
                <tr>
                    <td>${item.Chat ? escapeHtml(chatLabel(item.Chat)) : item.chatId}</td>
                    <td>${item.title}</td>
                    <td>${item.year || 'N/A'}</td>
                    <td>${item.premiere_digital || 'Unknown'}</td>
                    <td><button class="btn btn-danger" onclick="deleteWatchlistItem('${item.id}')">Delete</button></td>
                </tr>
            `;
        }
    }).join('');

    // The rows were just replaced — re-apply whatever filter is active
    const filter = TABLE_FILTERS.find(f => f.body === bodyId);
    if (filter) applyTableFilter(filter.input, filter.body);
}

// --- Smart Refresh Logic ---
function startTimer() {
    setInterval(() => {
        if (isPaused) return;
        refreshTimer--;
        if (refreshTimer <= 0) {
            refreshTimer = 10;
            fetchData();
        }
        document.getElementById('refresh-timer').innerText = refreshTimer;
    }, 1000);
}

function updatePauseButton() {
    const btn = document.getElementById('pause-refresh');
    if (!btn) return;
    btn.innerText = isPaused ? 'Resume' : 'Pause';
    btn.classList.toggle('btn-primary', isPaused);
    // Countdown is meaningless while paused
    setText('refresh-timer', isPaused ? '—' : refreshTimer);
}

document.getElementById('pause-refresh').onclick = () => {
    isPaused = !isPaused;
    if (!isPaused) refreshTimer = 10;
    updatePauseButton();
};

// --- API Actions ---
async function openDM(id, name) {
    setText('dm-target-info', `To: ${name || id}`);
    openModal('dm-modal');
    document.getElementById('confirm-dm').onclick = async () => {
        const msg = document.getElementById('dm-text').value.trim();
        if (!msg) return toast('Enter a message first', 'warning');
        try {
            const res = await fetch(`${API_URL}/chat/${id}/message`, {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify({ message: msg })
            }).then(r => r.json());

            if (!res.success) return toast('Failed to send: ' + (res.error || 'Unknown error'), 'error');

            toast('Message sent', 'success');
            modalReturnTo = null;
            closeModal('dm-modal');
            document.getElementById('dm-text').value = '';
        } catch (e) { toast('Failed to send', 'error'); }
    };
}

async function openSeriesDetails(tmdbId) {
    const modal = document.getElementById('detail-modal');
    document.getElementById('detail-loading').style.display = 'block';
    document.getElementById('detail-ready').style.display = 'none';
    modal.style.display = 'flex';

    try {
        const data = await fetch(`${API_URL}/series/${tmdbId}`, { headers: getHeaders() }).then(r => r.json());
        setText('detail-title', data.name);
        setText('detail-desc', data.overview || 'No description available.');
        setText('detail-meta', `Rating: ⭐️ ${data.vote_average.toFixed(1)} • Seasons: ${data.number_of_seasons}`);
        setText('detail-subs-count', `${data.subCount} Subscribers`);
        document.getElementById('detail-poster').src = data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : 'https://via.placeholder.com/200x300';

        document.getElementById('detail-loading').style.display = 'none';
        document.getElementById('detail-ready').style.display = 'block';
    } catch (e) {
        document.getElementById('detail-loading').innerText = 'Failed to load details.';
    }
}

// --- Legacy & Core Logic ---
// (Search, Sub, Film addition reused from previous implementation but adapted for new modals)

// TMDB reports one of: Returning Series / In Production / Planned / Pilot /
// Ended / Canceled. There is no "paused" state in the API.
const SERIES_STATUS = {
    'Returning Series': { label: 'On Air', cls: 'ok' },
    'In Production': { label: 'In Production', cls: 'warn' },
    'Planned': { label: 'Planned', cls: 'warn' },
    'Pilot': { label: 'Pilot', cls: 'warn' },
    'Ended': { label: 'Ended', cls: 'muted' },
    'Canceled': { label: 'Canceled', cls: 'error' }
};

const MODE_LABELS = {
    episode: 'Every episode',
    season: 'Whole season',
    first_and_full: '1st + season'
};

function seriesStatusBadge(status) {
    if (!status) {
        return '<span class="badge muted" title="Filled in by the next update check">Unknown</span>';
    }
    const known = SERIES_STATUS[status];
    if (!known) return `<span class="badge muted">${escapeHtml(status)}</span>`;
    return `<span class="badge ${known.cls}" title="TMDB: ${escapeHtml(status)}">${known.label}</span>`;
}

const subKey = (chatId, seriesId) => `${chatId}|${seriesId}`;

window.openModeModal = (key) => {
    const sub = subsByKey.get(key);
    if (!sub) return;

    const title = sub.Series ? sub.Series.title : sub.seriesId;
    const who = sub.Chat ? chatLabel(sub.Chat) : sub.chatId;
    setText('mode-target', `${title} • ${who}`);
    setSelectValue('mode-select', sub.notify_type);

    document.getElementById('confirm-mode').onclick = async () => {
        const notify_type = document.getElementById('mode-select').value;
        if (notify_type === sub.notify_type) return closeModal('mode-modal');

        try {
            // POST /api/subscription updates notify_type on an existing row
            const res = await fetch(`${API_URL}/subscription`, {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify({ chatId: sub.chatId, tmdbId: sub.seriesId, notify_type })
            }).then(r => r.json());

            if (!res.success) return toast('Failed to update: ' + (res.error || 'Unknown error'), 'error');

            toast(`Mode set to "${MODE_LABELS[notify_type]}"`, 'success');
            closeModal('mode-modal');
            fetchData(true);
        } catch (e) { toast('Request failed', 'error'); }
    };

    openModal('mode-modal');
};

function chatLabel(chat) {
    if (chat.username) return chat.username;
    return chat.type === 'private' ? 'Unknown user' : 'Unnamed group';
}

function chatDisplayName(chat) {
    const icon = chat.type === 'private' ? '👤' : (chat.type === 'channel' ? '📣' : '👥');
    const label = escapeHtml(chatLabel(chat));
    const dim = chat.username ? '' : ' style="color:var(--text-dim); font-style:italic"';
    return `<span${dim}>${icon} ${label}</span>`;
}

// One button per row opens this menu instead of crowding the Actions column
window.openChatActions = (chatId) => {
    const chat = chatsById.get(String(chatId));
    if (!chat) return;

    const isBlocked = chat.blockedUntil && new Date(chat.blockedUntil) > new Date();
    const label = chatLabel(chat);

    setText('chat-actions-title', label);
    setText('chat-actions-sub', `${chat.type} • ID ${chat.id}`);

    document.getElementById('action-add').onclick = () => {
        closeModal('chat-actions-modal');
        modalReturnTo = chat.id;
        openAddContentModal(chat.id, label);
    };

    document.getElementById('action-message').onclick = () => {
        closeModal('chat-actions-modal');
        modalReturnTo = chat.id;
        openDM(chat.id, label);
    };

    const blockBtn = document.getElementById('action-block');
    blockBtn.innerText = isBlocked ? '✅ Unblock' : '🚫 Block';
    blockBtn.classList.toggle('action-row-danger', !isBlocked);
    blockBtn.onclick = () => {
        closeModal('chat-actions-modal');
        if (isBlocked) {
            unblockUser(chat.id);
        } else {
            modalReturnTo = chat.id;
            blockUser(chat.id, label);
        }
    };

    openModal('chat-actions-modal');
};

// --- Unified "add series or film" flow ---
window.openAddContentModal = (chatId, label) => {
    addTargetChatId = chatId;
    selectedContent = null;
    contentSearchResults = [];

    setText('add-content-target', label || chatId);
    document.getElementById('content-search-input').value = '';
    document.getElementById('content-search-results').innerHTML = '';
    document.getElementById('content-selected').style.display = 'none';

    openModal('add-content-modal');
    document.getElementById('content-search-input').focus();
};

function renderContentResults() {
    const box = document.getElementById('content-search-results');
    if (!contentSearchResults.length) {
        box.innerHTML = '<p style="text-align:center; color:var(--text-dim)">Nothing found.</p>';
        return;
    }

    box.innerHTML = contentSearchResults.map((item, idx) => {
        const isTv = item.media_type === 'tv';
        const title = isTv ? item.name : item.title;
        const year = (isTv ? item.first_air_date : item.release_date)?.split('-')[0] || 'N/A';
        const poster = item.poster_path
            ? `<img src="https://image.tmdb.org/t/p/w92${item.poster_path}" style="width:40px; border-radius:4px;">`
            : '<div class="poster-stub">?</div>';
        return `
            <div class="popular-item" onclick="selectContent(${idx})">
                ${poster}
                <span style="flex:1">${escapeHtml(title)} (${year})</span>
                <span class="badge ${isTv ? 'ok' : ''}">${isTv ? '📺 Series' : '🎬 Movie'}</span>
            </div>
        `;
    }).join('');
}

window.selectContent = (idx) => {
    const item = contentSearchResults[idx];
    if (!item) return;

    const isTv = item.media_type === 'tv';
    selectedContent = { id: item.id, mediaType: item.media_type, title: isTv ? item.name : item.title };

    setText('selected-content-title', selectedContent.title);
    // Notification mode only makes sense for series
    document.getElementById('notify-field').style.display = isTv ? 'block' : 'none';
    document.getElementById('confirm-add-content').innerText = isTv ? 'Add Subscription' : 'Add to Watchlist';
    document.getElementById('content-selected').style.display = 'block';
};

document.getElementById('confirm-add-content').onclick = async () => {
    if (!selectedContent || !addTargetChatId) return;

    const isTv = selectedContent.mediaType === 'tv';
    const url = isTv ? `${API_URL}/subscription` : `${API_URL}/watchlist`;
    const body = { chatId: addTargetChatId, tmdbId: selectedContent.id };
    if (isTv) body.notify_type = document.getElementById('sub-notify-type').value;

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify(body)
        }).then(r => r.json());

        if (!res.success) return toast('Failed: ' + (res.error || 'Unknown error'), 'error');

        if (isTv) toast('Подписка добавлена', 'success');
        else if (res.isReleased) toast('Фильм добавлен, но он уже вышел', 'warning');
        else toast('Фильм добавлен в список ожидания', 'success');

        modalReturnTo = null;
        closeModal('add-content-modal');
        fetchData(true);
    } catch (e) { toast('Request failed', 'error'); }
};

window.openModal = (id) => document.getElementById(id).style.display = 'flex';
window.closeModal = (id) => document.getElementById(id).style.display = 'none';

// Dismissing a modal that was opened from the chat action menu goes back to it
// instead of dropping the user all the way out.
window.closeModalReturning = (id) => {
    closeModal(id);
    if (modalReturnTo === null) return;
    const chatId = modalReturnTo;
    modalReturnTo = null;
    openChatActions(chatId);
};

function toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerText = message;
    container.appendChild(el);

    setTimeout(() => {
        el.classList.add('toast-out');
        setTimeout(() => el.remove(), 300);
    }, 3500);
}

// Generic confirmation dialog. The safe choice ("No") is the visually dominant one.
function showConfirm({ title = 'Are you sure?', text, confirmLabel = 'Yes', cancelLabel = 'No, cancel', onConfirm }) {
    setText('confirm-title', title);
    setText('confirm-text', text);

    const confirmBtn = document.getElementById('modal-confirm-btn');
    const cancelBtn = document.getElementById('modal-cancel-btn');
    confirmBtn.innerText = confirmLabel;
    cancelBtn.innerText = cancelLabel;

    confirmBtn.onclick = async () => {
        closeModal('confirm-modal');
        await onConfirm();
    };
    cancelBtn.onclick = () => closeModal('confirm-modal');

    openModal('confirm-modal');
    cancelBtn.focus();
}

function setupEventListeners() {
    document.getElementById('refresh-btn').onclick = async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('spinning');
        refreshTimer = 10;
        try {
            await fetchData(true);
        } finally {
            btn.classList.remove('spinning');
        }
    };

    document.getElementById('trigger-btn').onclick = async () => {
        await fetch(`${API_URL}/trigger-check`, { method: 'POST', headers: getHeaders() });
        toast('Update check triggered', 'success');
    };

    document.getElementById('broadcast-btn').onclick = () => {
        document.getElementById('broadcast-msg').value = '';
        setSelectValue('broadcast-target', 'all');
        openModal('broadcast-modal');
        document.getElementById('broadcast-msg').focus();
    };

    document.getElementById('send-broadcast').onclick = sendBroadcast;

    document.getElementById('danger-btn').onclick = () => openModal('danger-modal');

    document.getElementById('wipe-all-btn').onclick = () => showConfirm({
        title: '⚠️ Wipe all data?',
        text: 'This empties the entire database — all chats, subscriptions, series and watchlist entries. Every user will have to start over with /start. This cannot be undone.',
        confirmLabel: 'Yes, wipe',
        cancelLabel: 'No, keep my data',
        onConfirm: wipeAllData
    });

    // One search box covering both series and movies
    document.getElementById('content-search-input').oninput = debounce(async (e) => {
        const q = e.target.value.trim();
        if (q.length < 2) return;
        const res = await fetch(`${API_URL}/tmdb/search?q=${encodeURIComponent(q)}`, { headers: getHeaders() }).then(r => r.json());
        contentSearchResults = res.filter(r => r.media_type === 'tv' || r.media_type === 'movie');
        renderContentResults();
    }, 500);
}

const BROADCAST_AUDIENCE_LABELS = {
    all: 'every private chat and group',
    private: 'every private chat',
    groups: 'every group and channel'
};

function sendBroadcast() {
    const message = document.getElementById('broadcast-msg').value.trim();
    if (!message) return toast('Enter a message first', 'warning');

    const target = document.getElementById('broadcast-target').value;

    showConfirm({
        title: '📢 Send broadcast?',
        text: `This sends the message to ${BROADCAST_AUDIENCE_LABELS[target]}. Delivery cannot be undone or recalled.`,
        confirmLabel: 'Yes, send',
        cancelLabel: 'No, cancel',
        onConfirm: async () => {
            const btn = document.getElementById('send-broadcast');
            btn.disabled = true;
            btn.innerText = 'Sending...';

            try {
                const res = await fetch(`${API_URL}/broadcast`, {
                    method: 'POST',
                    headers: getHeaders(),
                    body: JSON.stringify({ message, target })
                }).then(r => r.json());

                if (!res.success) return toast('Broadcast failed: ' + (res.error || 'Unknown error'), 'error');

                const failed = res.failCount ? `, ${res.failCount} failed` : '';
                toast(`Delivered to ${res.successCount} chats${failed}`, res.failCount ? 'warning' : 'success');
                closeModal('broadcast-modal');
                document.getElementById('broadcast-msg').value = '';
            } catch (e) {
                toast('Request failed', 'error');
            } finally {
                btn.disabled = false;
                btn.innerText = 'Send Broadcast';
            }
        }
    });
}

async function wipeAllData() {
    try {
        const res = await fetch(`${API_URL}/clear-all`, {
            method: 'POST',
            headers: getHeaders()
        }).then(r => r.json());

        if (res.success) {
            const d = res.deleted || {};
            closeModal('danger-modal');
            toast(`Wiped ${d.chats ?? 0} chats, ${d.subscriptions ?? 0} subscriptions, ${d.watchlist ?? 0} watchlist entries, ${d.series ?? 0} series.`, 'success');
            fetchData(true);
        } else {
            toast('Failed to wipe: ' + (res.error || 'Unknown error'), 'error');
        }
    } catch (e) { toast('Request failed', 'error'); }
}

// --- Subscription & Watchlist Management ---

function deleteSub(chatId, seriesId) {
    showConfirm({
        title: 'Delete subscription?',
        text: 'The user will stop receiving notifications for this series.',
        confirmLabel: 'Yes, delete',
        cancelLabel: 'No, keep it',
        onConfirm: async () => {
            try {
                const res = await fetch(`${API_URL}/subscription/${chatId}/${seriesId}`, {
                    method: 'DELETE',
                    headers: getHeaders()
                }).then(r => r.json());

                if (!res.success) return toast('Failed to delete: ' + (res.error || 'Unknown error'), 'error');
                toast('Subscription deleted', 'success');
                fetchData(true);
            } catch (e) { toast('Request failed', 'error'); }
        }
    });
}

function deleteWatchlistItem(id) {
    showConfirm({
        title: 'Remove from watchlist?',
        text: 'The user will no longer be notified about this film\'s release.',
        confirmLabel: 'Yes, remove',
        cancelLabel: 'No, keep it',
        onConfirm: async () => {
            try {
                const res = await fetch(`${API_URL}/watchlist/${id}`, {
                    method: 'DELETE',
                    headers: getHeaders()
                }).then(r => r.json());

                if (!res.success) return toast('Failed to delete: ' + (res.error || 'Unknown error'), 'error');
                toast('Removed from watchlist', 'success');
                fetchData(true);
            } catch (e) { toast('Request failed', 'error'); }
        }
    });
}

function blockUser(chatId, label) {
    const input = document.getElementById('block-minutes');
    setText('block-target', label ? `${label} • ID ${chatId}` : `ID ${chatId}`);
    input.value = '5';

    const submit = async () => {
        const minutes = parseInt(input.value, 10);
        if (!minutes || minutes < 1) return toast('Enter a duration of at least 1 minute', 'warning');

        modalReturnTo = null;
        closeModal('block-modal');

        try {
            const res = await fetch(`${API_URL}/chat/${chatId}/block`, {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify({ minutes })
            }).then(r => r.json());

            if (!res.success) return toast('Failed to block', 'error');
            toast(`Blocked for ${minutes} min`, 'success');
            fetchData(true);
        } catch (e) { toast('Request failed', 'error'); }
    };

    document.getElementById('confirm-block').onclick = submit;
    input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };

    openModal('block-modal');
    input.focus();
    input.select();
}

async function unblockUser(chatId) {
    try {
        const res = await fetch(`${API_URL}/chat/${chatId}/unblock`, {
            method: 'POST',
            headers: getHeaders()
        }).then(r => r.json());

        if (!res.success) return toast('Failed to unblock', 'error');
        toast('Chat unblocked', 'success');
        fetchData(true);
    } catch (e) { toast('Request failed', 'error'); }
}

// --- Custom Dropdowns ---
// The native <select> popup is rendered by the OS and ignores our CSS. The real
// <select> stays in the DOM (hidden) so `el.value` keeps working everywhere;
// a styled button + panel drive it.
let openDropdown = null;

function closeDropdown() {
    if (!openDropdown) return;
    openDropdown.panel.remove();
    openDropdown.trigger.setAttribute('aria-expanded', 'false');
    openDropdown = null;
}

function setSelectValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function enhanceSelect(select) {
    const wrap = document.createElement('div');
    wrap.className = 'custom-select';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);

    // Drop .select-field so a second pass won't wrap this element again
    select.classList.remove('select-field');
    select.classList.add('custom-select-native');
    select.tabIndex = -1;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select-field custom-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    wrap.appendChild(trigger);

    const syncLabel = () => {
        const opt = select.options[select.selectedIndex];
        trigger.innerText = opt ? opt.text : '';
    };
    syncLabel();
    select.addEventListener('change', syncLabel);

    const openPanel = () => {
        const panel = document.createElement('div');
        panel.className = 'custom-select-panel';
        panel.setAttribute('role', 'listbox');
        panel.onclick = (e) => e.stopPropagation();

        Array.from(select.options).forEach((opt, idx) => {
            const isSelected = idx === select.selectedIndex;
            const row = document.createElement('button');
            row.type = 'button';
            row.className = `custom-select-option${isSelected ? ' selected' : ''}`;
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', String(isSelected));
            row.innerHTML = `<span>${escapeHtml(opt.text)}</span>` +
                (isSelected ? '<span class="custom-select-check">✓</span>' : '');
            row.onclick = () => {
                select.value = opt.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                closeDropdown();
                trigger.focus();
            };
            panel.appendChild(row);
        });

        document.body.appendChild(panel);

        // Fixed positioning keeps the panel out of the modal's overflow clipping
        const rect = trigger.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        panel.style.width = `${rect.width}px`;
        panel.style.left = `${rect.left}px`;
        panel.style.top = (spaceBelow < panel.offsetHeight + 12 && rect.top > spaceBelow)
            ? `${rect.top - panel.offsetHeight - 6}px`
            : `${rect.bottom + 6}px`;

        trigger.setAttribute('aria-expanded', 'true');
        openDropdown = { trigger, panel };

        const first = panel.querySelector('.selected') || panel.firstChild;
        if (first) first.focus();
    };

    trigger.onclick = (e) => {
        e.stopPropagation();
        const wasOpen = openDropdown && openDropdown.trigger === trigger;
        closeDropdown();
        if (!wasOpen) openPanel();
    };
}

function enhanceSelects() {
    document.querySelectorAll('select.select-field').forEach(enhanceSelect);

    document.addEventListener('click', closeDropdown);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDropdown(); });
    window.addEventListener('resize', closeDropdown);
    window.addEventListener('scroll', closeDropdown, true);
}

// --- Helpers ---
function setText(id, text) { const el = document.getElementById(id); if (el) el.innerText = text; }
function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}
function updateBadge(id, text, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerText = text;
    el.className = `badge ${type}`;
}
function debounce(func, wait) {
    let timeout;
    return function () {
        const context = this, args = arguments;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

// Start the APP
init();
