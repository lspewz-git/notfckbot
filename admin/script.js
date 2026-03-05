const API_URL = '/api';

async function fetchData() {
    try {
        const [statsRes, dataRes, healthRes, logsRes] = await Promise.all([
            fetch(`${API_URL}/stats`),
            fetch(`${API_URL}/data`),
            fetch(`${API_URL}/health`),
            fetch(`${API_URL}/logs`)
        ]);

        const stats = await statsRes.json();
        const subs = await dataRes.json();
        const health = await healthRes.json();
        const logs = await logsRes.json();

        updateStats(stats);
        updateTable(subs);
        updateHealth(health);
        updateLogs(logs);
    } catch (err) {
        console.error('Failed to fetch data:', err);
    }
}

function updateHealth(health) {
    const tgBadge = document.querySelector('#health-tg .health-badge');
    const kpBadge = document.querySelector('#health-kp .health-badge');

    tgBadge.textContent = health.telegram ? 'OK' : 'ERROR';
    tgBadge.className = `health-badge ${health.telegram ? 'ok' : 'error'}`;

    kpBadge.textContent = health.kinopoisk ? 'OK' : 'ERROR';
    kpBadge.className = `health-badge ${health.kinopoisk ? 'ok' : 'error'}`;
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
}

function updateTable(subs) {
    const tbody = document.getElementById('subs-table-body');
    tbody.innerHTML = '';

    subs.forEach(sub => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${sub.chatId}</td>
            <td>${sub.Chat ? (sub.Chat.username || 'N/A') : 'N/A'}</td>
            <td>${sub.Series ? sub.Series.title : 'Unknown'}</td>
            <td><span class="badge ${sub.notify_type}">${sub.notify_type}</span></td>
            <td>
                <button class="danger action-btn" onclick="deleteSub('${sub.chatId}', '${sub.seriesId}')">Delete</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
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
document.getElementById('filter-input').oninput = (e) => {
    const term = e.target.value.toLowerCase();
    const rows = document.querySelectorAll('#subs-table-body tr');
    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(term) ? '' : 'none';
    });
};

// ============================================================
// Settings: Kinopoisk API Key
// ============================================================

const apikeyInput = document.getElementById('apikey-input');
const apikeyStatus = document.getElementById('apikey-status');

// Load the masked key on startup
async function loadConfig() {
    try {
        const res = await fetch(`${API_URL}/config`);
        const data = await res.json();
        apikeyInput.placeholder = data.kinopoiskApiKey || '••••••••';
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
            body: JSON.stringify({ kinopoiskApiKey: newKey })
        });
        const result = await res.json();
        if (result.success) {
            apikeyInput.value = '';
            apikeyInput.placeholder = result.kinopoiskApiKey;
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

// Initial load
loadConfig();
fetchData();
setInterval(fetchData, 30000); // Auto refresh every 30s
