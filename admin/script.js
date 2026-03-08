const API_URL = '/api';

async function fetchData() {
    try {
        const [statsRes, healthRes, logsRes] = await Promise.all([
            fetch(`${API_URL}/stats`),
            fetch(`${API_URL}/health`),
            fetch(`${API_URL}/logs`)
        ]);

        const stats = await statsRes.json();
        const health = await healthRes.json();
        const logs = await logsRes.json();

        updateStats(stats);
        updateHealth(health);
        updateLogs(logs);
    } catch (err) {
        console.error('Failed to fetch data:', err);
    }
}

function updateHealth(health) {
    const tgBadge = document.querySelector('#health-tg .health-badge');
    const tmdbBadge = document.querySelector('#health-tmdb .health-badge');
    const proxyBadge = document.querySelector('#health-proxy .health-badge');

    tgBadge.textContent = health.telegram ? 'OK' : 'ERROR';
    tgBadge.className = `health-badge ${health.telegram ? 'ok' : 'error'}`;

    tmdbBadge.textContent = health.tmdb ? 'OK' : 'ERROR';
    tmdbBadge.className = `health-badge ${health.tmdb ? 'ok' : 'error'}`;

    if (health.proxy === 'ok') {
        proxyBadge.textContent = 'OK';
        proxyBadge.className = 'health-badge ok';
    } else if (health.proxy === 'error') {
        proxyBadge.textContent = 'ERROR';
        proxyBadge.className = 'health-badge error';
    } else {
        proxyBadge.textContent = 'OFF';
        proxyBadge.className = 'health-badge secondary';
    }
}

function updateLogs(logs) {
    const viewer = document.getElementById('logs-viewer');
    const isAtBottom = viewer.scrollHeight - viewer.clientHeight <= viewer.scrollTop + 1;

    viewer.innerHTML = logs.map(log => `
        <div class="log-entry">
            <span class="log-time">[${log.time}]</span>
            <span class="log-text ${log.type}">${log.text}</span>
        </div>
    `).join('');

    if (isAtBottom) {
        viewer.scrollTop = viewer.scrollHeight;
    }
}

// Broadcast Logic
document.getElementById('send-broadcast').onclick = async () => {
    const msgInput = document.getElementById('broadcast-msg');
    const message = msgInput.value.trim();
    if (!message) return alert('Please enter a message');

    if (!confirm('Send this message to ALL users?')) return;

    try {
        const res = await fetch(`${API_URL}/broadcast`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        const result = await res.json();
        if (result.success) {
            alert(`Broadcast sent!\nSuccess: ${result.successCount}\nFailed: ${result.failCount}`);
            msgInput.value = '';
        } else {
            alert('Error: ' + result.error);
        }
    } catch (err) {
        alert('Failed to send broadcast');
    }
};

// Trigger Manual Check
document.getElementById('trigger-btn').onclick = async () => {
    try {
        const res = await fetch(`${API_URL}/trigger-check`, { method: 'POST' });
        const result = await res.json();
        if (result.success) {
            alert('Update check triggered. Check logs for progress!');
            fetchData();
        }
    } catch (err) {
        alert('Failed to trigger update check');
    }
};

function updateStats(stats) {
    document.getElementById('chats-count').textContent = stats.chatsCount;
    document.getElementById('subs-count').textContent = stats.subsCount;
    document.getElementById('series-count').textContent = stats.seriesCount;
    document.getElementById('films-count').textContent = stats.filmsCount;
}

// List Modal Logic
const listModal = document.getElementById('list-modal');
const listModalTitle = document.getElementById('list-modal-title');
const listTableHead = document.getElementById('list-table-head');
const listTableBody = document.getElementById('list-table-body');
const listFilterInput = document.getElementById('list-filter-input');
let currentListData = [];

async function openList(type) {
    listModal.style.display = 'flex';
    listTableBody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Loading...</td></tr>';

    let title = '';
    if (type === 'subs') title = 'Active Subscriptions';
    else if (type === 'series') title = 'Monitored Series';
    else if (type === 'films') title = 'Watchlist Films';
    else if (type === 'chats') title = 'Users / Chats';
    listModalTitle.textContent = title;

    try {
        const res = await fetch(`${API_URL}/data/${type}`);
        currentListData = await res.json();
        renderListData(type, currentListData);
    } catch (err) {
        listTableBody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:red;">Failed to load data</td></tr>';
    }
}

function renderListData(type, data) {
    listTableHead.innerHTML = '';
    listTableBody.innerHTML = '';

    if (data.length === 0) {
        listTableBody.innerHTML = '<tr><td colspan="5" style="text-align:center;">No data found.</td></tr>';
        return;
    }

    if (type === 'subs') {
        listTableHead.innerHTML = `<tr><th>Chat ID</th><th>User Name</th><th>Series</th><th>Type</th><th>Actions</th></tr>`;
        data.forEach(sub => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${sub.chatId}</td>
                <td>${sub.Chat ? (sub.Chat.username || 'N/A') : 'N/A'}</td>
                <td>${sub.Series ? sub.Series.title : 'Unknown'}</td>
                <td><span class="badge ${sub.notify_type}">${sub.notify_type}</span></td>
                <td><button class="danger action-btn" onclick="deleteSub('${sub.chatId}', '${sub.seriesId}')">Delete</button></td>
            `;
            listTableBody.appendChild(tr);
        });
    } else if (type === 'series') {
        listTableHead.innerHTML = `<tr><th>TMDB ID</th><th>Title</th><th>Last Season</th><th>Last Ep</th></tr>`;
        data.forEach(item => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${item.tmdb_id}</td>
                <td>${item.title}</td>
                <td>${item.last_season}</td>
                <td>${item.last_episode}</td>
            `;
            listTableBody.appendChild(tr);
        });
    } else if (type === 'films') {
        listTableHead.innerHTML = `<tr><th>Chat ID</th><th>User Name</th><th>Film Title</th><th>Year</th><th>Digital Release</th></tr>`;
        data.forEach(item => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${item.chatId}</td>
                <td>${item.Chat ? (item.Chat.username || 'N/A') : 'N/A'}</td>
                <td>${item.title}</td>
                <td>${item.year || 'N/A'}</td>
                <td>${item.premiere_digital || 'N/A'}</td>
            `;
            listTableBody.appendChild(tr);
        });
    } else if (type === 'chats') {
        listTableHead.innerHTML = `<tr><th>Chat ID</th><th>Username</th><th>Type</th><th>Status</th><th>Actions</th></tr>`;
        data.forEach(item => {
            const tr = document.createElement('tr');

            const isBlocked = item.blockedUntil && new Date(item.blockedUntil) > new Date();
            let statusHtml = '<span class="badge ok">Active</span>';
            let actionsHtml = `
                <select id="block-time-${item.id}" style="padding: 0.3rem; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text);">
                    <option value="5">5 Minutes</option>
                    <option value="60">1 Hour</option>
                    <option value="1440">1 Day</option>
                    <option value="52560000">Forever</option>
                </select>
                <button class="danger action-btn" onclick="blockUser('${item.id}')" style="margin-left: 0.5rem;">Block</button>
            `;

            if (isBlocked) {
                const unblockTime = new Date(item.blockedUntil).toLocaleString();
                statusHtml = `<span class="badge error">Blocked until ${unblockTime}</span>`;
                actionsHtml = `<button class="secondary action-btn" onclick="unblockUser('${item.id}')">Unblock</button>`;
            }

            const usernameDisplay = item.username || 'Unknown';

            tr.innerHTML = `
                <td>${item.id}</td>
                <td>${usernameDisplay}</td>
                <td>${item.type}</td>
                <td>${statusHtml}</td>
                <td>${actionsHtml}</td>
            `;
            listTableBody.appendChild(tr);
        });
    }
}

async function blockUser(chatId) {
    const minSelect = document.getElementById(`block-time-${chatId}`);
    const minutes = minSelect ? parseInt(minSelect.value, 10) : 5;

    if (!confirm(`Are you sure you want to block user ${chatId} for ${minutes} minutes?`)) return;

    try {
        const res = await fetch(`${API_URL}/chat/${chatId}/block`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ minutes })
        });
        if (res.ok) openList('chats'); // refresh current view
        else alert('Failed to block user');
    } catch (err) {
        alert('Failed to block user');
    }
}

async function unblockUser(chatId) {
    if (!confirm(`Are you sure you want to UNBLOCK user ${chatId}?`)) return;

    try {
        const res = await fetch(`${API_URL}/chat/${chatId}/unblock`, {
            method: 'POST'
        });
        if (res.ok) openList('chats'); // refresh current view
        else alert('Failed to unblock user');
    } catch (err) {
        alert('Failed to unblock user');
    }
}

async function deleteSub(chatId, seriesId) {
    if (!confirm('Are you sure you want to delete this subscription?')) return;

    try {
        const res = await fetch(`${API_URL}/subscription/${chatId}/${seriesId}`, {
            method: 'DELETE'
        });
        if (res.ok) fetchData();
    } catch (err) {
        alert('Failed to delete subscription');
    }
}

// Modal Logic
const modal = document.getElementById('modal');
const clearBtn = document.getElementById('clear-all-btn');
const cancelBtn = document.getElementById('cancel-clear');
const confirmBtn = document.getElementById('confirm-clear');

clearBtn.onclick = () => modal.style.display = 'flex';
cancelBtn.onclick = () => modal.style.display = 'none';

confirmBtn.onclick = async () => {
    try {
        const res = await fetch(`${API_URL}/clear-all`, { method: 'POST' });
        if (res.ok) {
            modal.style.display = 'none';
            fetchData();
        }
    } catch (err) {
        alert('Failed to clear data');
    }
};

document.getElementById('refresh-btn').onclick = fetchData;

// Filtering
document.getElementById('list-filter-input').oninput = (e) => {
    const term = e.target.value.toLowerCase();
    const rows = document.querySelectorAll('#list-table-body tr');
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(term) ? '' : 'none';
    });
};

// ============================================================
// Settings: TMDB API Key
// ============================================================

const apikeyInput = document.getElementById('apikey-input');
const apikeyStatus = document.getElementById('apikey-status');
const proxyInput = document.getElementById('proxy-input');
const proxyStatus = document.getElementById('proxy-status');

// Load the masked key on startup
async function loadConfig() {
    try {
        const res = await fetch(`${API_URL}/config`);
        const data = await res.json();
        apikeyInput.placeholder = data.tmdbApiKey || '••••••••';
        proxyInput.placeholder = data.tmdbProxyUrl || 'None';
    } catch { /* silent */ }
}

// Toggle show/hide
document.getElementById('toggle-apikey').onclick = () => {
    apikeyInput.type = apikeyInput.type === 'password' ? 'text' : 'password';
};

// Save new key
document.getElementById('save-apikey').onclick = async () => {
    const newKey = apikeyInput.value.trim();
    if (!newKey) {
        apikeyStatus.textContent = '⚠️ Key cannot be empty';
        apikeyStatus.className = 'apikey-status error';
        return;
    }

    try {
        const res = await fetch(`${API_URL}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tmdbApiKey: newKey })
        });
        const result = await res.json();
        if (result.success) {
            apikeyInput.value = '';
            apikeyInput.placeholder = result.tmdbApiKey;
            apikeyStatus.textContent = '✅ Saved! Takes effect immediately.';
            apikeyStatus.className = 'apikey-status success';
            setTimeout(() => { apikeyStatus.textContent = ''; }, 4000);
        } else {
            apikeyStatus.textContent = '❌ Error: ' + result.error;
            apikeyStatus.className = 'apikey-status error';
        }
    } catch (err) {
        apikeyStatus.textContent = '❌ Network error';
        apikeyStatus.className = 'apikey-status error';
    }
};

// Save new proxy
document.getElementById('save-proxy').onclick = async () => {
    const newProxy = proxyInput.value.trim();

    try {
        const res = await fetch(`${API_URL}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tmdbProxyUrl: newProxy })
        });
        const result = await res.json();
        if (result.success) {
            proxyInput.value = '';
            proxyInput.placeholder = result.tmdbProxyUrl || 'None';
            proxyStatus.textContent = '✅ Proxy updated! Checking health...';
            proxyStatus.className = 'apikey-status success';
            setTimeout(() => { proxyStatus.textContent = ''; }, 4000);
            fetchData(); // Refresh health status
        } else {
            proxyStatus.textContent = '❌ Error: ' + result.error;
            proxyStatus.className = 'apikey-status error';
        }
    } catch (err) {
        proxyStatus.textContent = '❌ Network error';
        proxyStatus.className = 'apikey-status error';
    }
};

// Initial load
loadConfig();
fetchData();
setInterval(fetchData, 30000); // Auto refresh every 30s
