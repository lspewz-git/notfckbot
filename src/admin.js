const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { Chat, Series, Subscription } = require('./db');
const { checkUpdates } = require('./cron');

const app = express();
const PORT = 3000;

// --- Log Buffer (captured INSIDE the module, not as a global side effect) ---
const logBuffer = [];
let originalLog = null;
let originalError = null;

function startLogCapture() {
    originalLog = console.log;
    originalError = console.error;

    console.log = (...args) => {
        const text = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
        logBuffer.push({ type: 'log', time: new Date().toLocaleTimeString(), text });
        if (logBuffer.length > 200) logBuffer.shift();
        originalLog.apply(console, args);
    };

    console.error = (...args) => {
        const text = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
        logBuffer.push({ type: 'error', time: new Date().toLocaleTimeString(), text });
        if (logBuffer.length > 200) logBuffer.shift();
        originalError.apply(console, args);
    };
}

// --- Auth Middleware for destructive/sensitive endpoints ---
function requireAdminToken(req, res, next) {
    const adminToken = process.env.ADMIN_TOKEN;
    // If no token is configured, skip auth (backward compat for local dev)
    if (!adminToken || adminToken === 'change_me_to_a_strong_secret') return next();

    const provided = req.headers['x-admin-token'];
    if (!provided || provided !== adminToken) {
        return res.status(401).json({ error: 'Unauthorized: missing or invalid X-Admin-Token header.' });
    }
    return next();
}

app.use(cors());
app.use(express.json());

// Serve static files from 'admin' directory
app.use(express.static(path.join(__dirname, '../admin')));

// --- Read-only endpoints (no auth required) ---

app.get('/api/stats', async (req, res) => {
    try {
        const [chatsCount, seriesCount, subsCount] = await Promise.all([
            Chat.count(),
            Series.count(),
            Subscription.count(),
        ]);
        res.json({ chatsCount, seriesCount, subsCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/data', async (req, res) => {
    try {
        const subscriptions = await Subscription.findAll({
            include: [{ model: Chat }, { model: Series }],
        });
        res.json(subscriptions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/logs', (req, res) => {
    res.json(logBuffer);
});

app.get('/api/health', async (req, res) => {
    const health = { telegram: false, kinopoisk: false };

    const [tgResult, kpResult] = await Promise.allSettled([
        app.get('bot').telegram.getMe(),
        axios.get('https://api.kinopoisk.dev/v1.4/movie/random', {
            headers: { 'X-API-KEY': process.env.KINOPOISK_API_KEY },
            timeout: 5000,
        }),
    ]);

    if (tgResult.status === 'fulfilled') health.telegram = true;
    if (kpResult.status === 'fulfilled' && kpResult.value.status === 200) health.kinopoisk = true;

    res.json(health);
});

app.get('/api/chats', async (req, res) => {
    try {
        const chats = await Chat.findAll({ include: [Series] });
        res.json(chats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Write endpoints (auth required) ---

app.post('/api/broadcast', requireAdminToken, async (req, res) => {
    const { message } = req.body;
    if (!message || !message.trim()) {
        return res.status(400).json({ error: 'Message is required' });
    }

    const bot = app.get('bot');
    try {
        const chats = await Chat.findAll();
        let successCount = 0;
        let failCount = 0;

        for (const chat of chats) {
            try {
                await bot.telegram.sendMessage(
                    chat.id,
                    `📣 <b>ОБЪЯВЛЕНИЕ:</b>\n\n${message}`,
                    { parse_mode: 'HTML' }
                );
                successCount++;
            } catch (e) {
                failCount++;
            }
            // FIX: Rate limit — Telegram allows ~30 messages/sec; 50ms keeps us safe
            await new Promise(r => setTimeout(r, 50));
        }
        res.json({ success: true, successCount, failCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/trigger-check', requireAdminToken, async (req, res) => {
    const bot = app.get('bot');
    try {
        checkUpdates(bot); // Run in background, don't await
        res.json({ success: true, message: 'Update check started' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/subscription/:chatId/:seriesId', requireAdminToken, async (req, res) => {
    const { chatId, seriesId } = req.params;
    try {
        await Subscription.destroy({ where: { chatId, seriesId } });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Helper to mask an API key: show only first 4 and last 4 chars
const maskKey = (key) => {
    if (!key || key.length < 10) return '••••••••';
    return key.slice(0, 4) + '•'.repeat(key.length - 8) + key.slice(-4);
};

// Helper to update a value in the .env file
const updateEnvFile = (key, value) => {
    const envPath = path.join(__dirname, '../.env');
    try {
        let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(content)) {
            content = content.replace(regex, `${key}=${value}`);
        } else {
            content += `\n${key}=${value}`;
        }
        fs.writeFileSync(envPath, content, 'utf-8');
    } catch (err) {
        console.error('[Admin] Failed to write .env:', err.message);
    }
};

app.get('/api/config', requireAdminToken, (req, res) => {
    res.json({
        kinopoiskApiKey: maskKey(process.env.KINOPOISK_API_KEY),
        adminToken: maskKey(process.env.ADMIN_TOKEN),
    });
});

// Update KINOPOISK_API_KEY at runtime and persist to .env
app.post('/api/config', requireAdminToken, (req, res) => {
    const { kinopoiskApiKey } = req.body;

    if (!kinopoiskApiKey || !kinopoiskApiKey.trim()) {
        return res.status(400).json({ error: 'kinopoiskApiKey is required' });
    }

    const newKey = kinopoiskApiKey.trim();
    // Update in memory — takes effect immediately for all new API calls
    process.env.KINOPOISK_API_KEY = newKey;
    // Persist to .env so it survives restarts
    updateEnvFile('KINOPOISK_API_KEY', newKey);

    console.log('[Admin] KINOPOISK_API_KEY updated successfully.');
    res.json({ success: true, kinopoiskApiKey: maskKey(newKey) });
});

app.post('/api/clear-all', requireAdminToken, async (req, res) => {
    try {
        await Subscription.destroy({ where: {} });
        await Series.destroy({ where: {} });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function startAdminServer(bot) {
    // FIX: Log capture is started here, not at module load time (avoids global side effect)
    startLogCapture();
    app.set('bot', bot);
    app.listen(PORT, () => {
        console.log(`🚀 Admin Panel running on http://localhost:${PORT}`);
    });
}

module.exports = { startAdminServer };
