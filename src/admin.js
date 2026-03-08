const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const _getProxyAgent = (url) => {
    if (!url) return null;
    if (url.startsWith('socks')) return new SocksProxyAgent(url, { rejectUnauthorized: false });
    if (url.startsWith('http')) return new HttpsProxyAgent(url, { rejectUnauthorized: false });
    return null;
};
const { Chat, Series, Subscription, Watchlist } = require('./db');
const { checkUpdates } = require('./cron');
const tmdb = require('./api/tmdb');

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
        const [chatsCount, seriesCount, subsCount, filmsCount] = await Promise.all([
            Chat.count(),
            Series.count(),
            Subscription.count(),
            Watchlist.count(),
        ]);
        res.json({ chatsCount, seriesCount, subsCount, filmsCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/data/:type', async (req, res) => {
    try {
        const { type } = req.params;
        let data = [];
        if (type === 'subs') {
            data = await Subscription.findAll({
                include: [{ model: Chat }, { model: Series }],
            });
        } else if (type === 'series') {
            data = await Series.findAll();
        } else if (type === 'films') {
            data = await Watchlist.findAll({
                include: [{ model: Chat }],
            });
        } else if (type === 'chats') {
            data = await Chat.findAll({
                order: [['createdAt', 'DESC']]
            });
        }
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/logs', (req, res) => {
    res.json(logBuffer);
});

app.get('/api/tmdb/search', requireAdminToken, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ error: 'Query is required' });
        const results = await tmdb.searchMulti(q);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/health', async (req, res) => {
    const health = { telegram: false, tmdb: false, proxy: 'off' };
    const proxyUrl = process.env.TMDB_PROXY_URL;

    if (proxyUrl) {
        health.proxy = 'error'; // Default to error if URL exists
    }

    const [tgResult, tmdbResult, proxyResult] = await Promise.allSettled([
        app.get('bot').telegram.getMe(),
        axios.get('https://api.themoviedb.org/3/authentication', {
            headers: { 'Authorization': `Bearer ${process.env.TMDB_API_KEY}` },
            timeout: 5000,
            httpsAgent: _getProxyAgent(proxyUrl),
            proxy: false
        }),
        proxyUrl ? axios.get('https://google.com', {
            timeout: 5000,
            httpsAgent: _getProxyAgent(proxyUrl),
            proxy: false
        }) : Promise.resolve({ status: 200 })
    ]);

    if (tgResult.status === 'fulfilled') health.telegram = true;
    if (tmdbResult.status === 'fulfilled' && tmdbResult.value.status === 200) health.tmdb = true;

    if (proxyUrl) {
        if (proxyResult.status === 'fulfilled' && proxyResult.value.status === 200) {
            health.proxy = 'ok';
        } else {
            health.proxy = 'error';
        }
    } else {
        health.proxy = 'off';
    }

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

app.post('/api/subscription', requireAdminToken, async (req, res) => {
    const { chatId, tmdbId, notify_type } = req.body;
    if (!chatId || !tmdbId) {
        return res.status(400).json({ error: 'chatId and tmdbId are required' });
    }

    try {
        // 1. Ensure Chat exists
        const chat = await Chat.findByPk(chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });

        // 2. Ensure Series exists, or fetch/create it
        let series = await Series.findByPk(tmdbId);
        if (!series) {
            const details = await tmdb.getDetails(tmdbId, 'tv');
            series = await Series.create({
                tmdb_id: String(tmdbId),
                title: details.name || details.original_name,
                last_season: details.number_of_seasons || 0,
                last_episode: 0,
                poster_url: details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : null
            });
        }

        // 3. Create or update subscription
        const [sub, created] = await Subscription.findOrCreate({
            where: { chatId, seriesId: tmdbId },
            defaults: { notify_type: notify_type || 'episode' }
        });

        if (!created && notify_type) {
            await sub.update({ notify_type });
        }

        res.json({ success: true, created, subscription: sub });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chat/:chatId/block', requireAdminToken, async (req, res) => {
    const { chatId } = req.params;
    const { minutes } = req.body;
    try {
        const chat = await Chat.findByPk(chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });

        const duration = parseInt(minutes, 10) || 5;
        const blockUntil = new Date(Date.now() + duration * 60 * 1000);

        await chat.update({ blockedUntil: blockUntil });
        res.json({ success: true, blockedUntil: blockUntil });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chat/:chatId/unblock', requireAdminToken, async (req, res) => {
    const { chatId } = req.params;
    try {
        const chat = await Chat.findByPk(chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });

        await chat.update({ blockedUntil: null });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



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
        tmdbApiKey: process.env.TMDB_API_KEY || '',
        tmdbProxyUrl: process.env.TMDB_PROXY_URL || '',
        adminToken: process.env.ADMIN_TOKEN || '',
    });
});

// Update configuration at runtime and persist to .env
app.post('/api/config', requireAdminToken, (req, res) => {
    const { tmdbApiKey, tmdbProxyUrl } = req.body;

    if (tmdbApiKey && tmdbApiKey.trim()) {
        const newKey = tmdbApiKey.trim();
        process.env.TMDB_API_KEY = newKey;
        updateEnvFile('TMDB_API_KEY', newKey);
    }

    if (tmdbProxyUrl !== undefined) {
        const newProxy = tmdbProxyUrl.trim();
        process.env.TMDB_PROXY_URL = newProxy;
        updateEnvFile('TMDB_PROXY_URL', newProxy);
    }

    console.log('[Admin] Configuration updated successfully.');
    res.json({
        success: true,
        tmdbApiKey: process.env.TMDB_API_KEY,
        tmdbProxyUrl: process.env.TMDB_PROXY_URL
    });
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
