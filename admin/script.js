const API_URL = '/api';

// --- Global State ---
let currentSection = 'dashboard';
let refreshTimer = 60;
let isPaused = false;
let currentLogs = [];
let logFilter = 'all';

// --- Initialization ---
async function init() {
    fetchData();
    startTimer();
    setupEventListeners();
    setupFilters();
}

function getHeaders() {
    const token = localStorage.getItem('adminToken') || '';
    return {
        'Content-Type': 'application/json',
        'X-Admin-Token': token
    };
}

function setupFilters() {
    const chatFilter = document.getElementById('chats-filter');
    if (chatFilter) {
        chatFilter.oninput = (e) => {
            const q = e.target.value.toLowerCase();
            const rows = document.querySelectorAll('#chats-body tr');
            rows.forEach(row => {
                const text = row.innerText.toLowerCase();
                row.style.display = text.includes(q) ? '' : 'none';
            });
        };
    }
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
                    <td>${item.username || 'Unknown'}</td>
                    <td><span style="font-size:0.7rem; text-transform:uppercase">${item.type}</span></td>
                    <td>${status}</td>
                    <td>
                        <div class="chat-actions">
                            <button class="btn btn-ghost" onclick="openDM('${item.id}', '${item.username || ''}')">✉️ Msg</button>
                            <button class="btn btn-primary" onclick="openAddSubModal('${item.id}')">+ Sub</button>
                            <button class="btn btn-primary" onclick="openAddFilmModal('${item.id}')">+ Film</button>
                            ${isBlocked ? `<button class="btn btn-ghost" onclick="unblockUser('${item.id}')">Unblock</button>` : `<button class="btn btn-danger" onclick="blockUser('${item.id}')">Block</button>`}
                        </div>
                    </td>
                </tr>
            `;
        }
        if (type === 'subs') {
            return `
                <tr>
                    <td>${item.Chat ? item.Chat.username : item.chatId}</td>
                    <td style="cursor:pointer; color:var(--primary)" onclick="openSeriesDetails('${item.seriesId}')">${item.Series ? item.Series.title : 'Unknown'}</td>
                    <td><span class="badge ok">${item.notify_type}</span></td>
                    <td><button class="btn btn-danger" onclick="deleteSub('${item.chatId}', '${item.seriesId}')">Delete</button></td>
                </tr>
            `;
        }
        if (type === 'films') {
            return `
                <tr>
                    <td>${item.Chat ? item.Chat.username : item.chatId}</td>
                    <td>${item.title}</td>
                    <td>${item.year || 'N/A'}</td>
                    <td>${item.premiere_digital || 'Unknown'}</td>
                    <td><button class="btn btn-danger" onclick="deleteWatchlistItem('${item.id}')">Delete</button></td>
                </tr>
            `;
        }
    }).join('');

    // Re-apply filter if active
    const q = document.getElementById('chats-filter')?.value.toLowerCase();
    if (q && type === 'chats') {
        const rows = body.querySelectorAll('tr');
        rows.forEach(row => {
            const text = row.innerText.toLowerCase();
            row.style.display = text.includes(q) ? '' : 'none';
        });
    }
}

// --- Smart Refresh Logic ---
function startTimer() {
    setInterval(() => {
        if (isPaused) return;
        refreshTimer--;
        if (refreshTimer <= 0) {
            refreshTimer = 60;
            fetchData();
        }
        document.getElementById('refresh-timer').innerText = refreshTimer;
    }, 1000);
}

document.getElementById('pause-refresh').onclick = (e) => {
    isPaused = !isPaused;
    e.target.innerText = isPaused ? 'Resume' : 'Pause';
    e.target.classList.toggle('btn-primary', isPaused);
};

// --- API Actions ---
async function openDM(id, name) {
    document.getElementById('dm-target-info').innerText = `To: ${name || id}`;
    document.getElementById('dm-modal').style.display = 'flex';
    document.getElementById('confirm-dm').onclick = async () => {
        const msg = document.getElementById('dm-text').value.trim();
        if (!msg) return alert('Enter message');
        try {
            const res = await fetch(`${API_URL}/chat/${id}/message`, {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify({ message: msg })
            }).then(r => r.json());
            if (res.success) {
                alert('Message sent!');
                closeModal('dm-modal');
                document.getElementById('dm-text').value = '';
            }
        } catch (e) { alert('Failed to send'); }
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

const addSubModal = document.getElementById('add-sub-modal');
const filmAddModal = document.getElementById('add-film-modal');

window.openAddSubModal = (chatId) => {
    document.getElementById('add-sub-chat-id').innerText = chatId;
    addSubModal.style.display = 'flex';
};

window.openAddFilmModal = (chatId) => {
    document.getElementById('add-film-chat-id').innerText = chatId;
    filmAddModal.style.display = 'flex';
};

window.closeModal = (id) => document.getElementById(id).style.display = 'none';

function setupEventListeners() {
    document.getElementById('refresh-btn').onclick = () => fetchData(true);
    document.getElementById('trigger-btn').onclick = async () => {
        await fetch(`${API_URL}/trigger-check`, { method: 'POST' });
        alert('Update check triggered!');
    };

    // Series search logic
    document.getElementById('series-search-input').oninput = debounce(async (e) => {
        const q = e.target.value.trim();
        if (q.length < 2) return;
        const res = await fetch(`${API_URL}/tmdb/search?q=${encodeURIComponent(q)}`, { headers: getHeaders() }).then(r => r.json());
        const results = res.filter(r => r.media_type === 'tv');
        document.getElementById('search-results').innerHTML = results.map(item => `
            <div class="popular-item" onclick="selectSeries('${item.id}', '${item.name.replace(/'/g, "\\'")}')">
                <img src="https://image.tmdb.org/t/p/w92${item.poster_path}" style="width:40px; border-radius:4px;">
                <span>${item.name} (${item.first_air_date?.split('-')[0] || 'N/A'})</span>
            </div>
        `).join('');
    }, 500);

    // Film search logic
    document.getElementById('film-search-input').oninput = debounce(async (e) => {
        const q = e.target.value.trim();
        if (q.length < 2) return;
        const res = await fetch(`${API_URL}/tmdb/search?q=${encodeURIComponent(q)}`, { headers: getHeaders() }).then(r => r.json());
        const results = res.filter(r => r.media_type === 'movie');
        document.getElementById('film-search-results').innerHTML = results.map(item => `
            <div class="popular-item" onclick="selectMovie('${item.id}', '${item.title.replace(/'/g, "\\'")}')">
                <img src="https://image.tmdb.org/t/p/w92${item.poster_path}" style="width:40px; border-radius:4px;">
                <span>${item.title} (${item.release_date?.split('-')[0] || 'N/A'})</span>
            </div>
        `).join('');
    }, 500);
}

window.selectSeries = (id, title) => {
    window.currentTmdbId = id;
    document.getElementById('selected-series-title').innerText = title;
    document.getElementById('sub-options').style.display = 'block';
};

document.getElementById('confirm-add-sub').onclick = async () => {
    const chatId = document.getElementById('add-sub-chat-id').innerText;
    const res = await fetch(`${API_URL}/subscription`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
            chatId,
            tmdbId: window.currentTmdbId,
            notify_type: document.getElementById('sub-notify-type').value
        })
    }).then(r => r.json());
    if (res.success) { alert('Subscribed!'); closeModal('add-sub-modal'); fetchData(true); }
};

window.selectMovie = (id, title) => {
    window.currentMovieId = id;
    document.getElementById('selected-film-title').innerText = title;
    document.getElementById('film-selected-info').style.display = 'block';
};

document.getElementById('confirm-add-film').onclick = async () => {
    const chatId = document.getElementById('add-film-chat-id').innerText;
    const res = await fetch(`${API_URL}/watchlist`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ chatId, tmdbId: window.currentMovieId })
    }).then(r => r.json());
    if (res.success) {
        if (res.isReleased) alert('⚠️ Фильм уже вышел!');
        else alert('✅ Фильм успешно добавлен!');
        closeModal('add-film-modal');
        fetchData(true);
    }
};

// --- Helpers ---
function setText(id, text) { const el = document.getElementById(id); if (el) el.innerText = text; }
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
