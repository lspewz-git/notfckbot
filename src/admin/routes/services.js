/** The dialogs behind the TG / TMDB / KP badges: masked token, check with the service, replace. */
const axios = require('axios');
const { buildProxyAgent } = require('../../proxy');
const { checkKinopoiskKey } = require('../../api/kinopoisk');
const { updateEnvFile, maskToken } = require('../env');
const { invalidateHealth } = require('./health');

const router = require('express').Router();

const outbound = () => ({ httpsAgent: buildProxyAgent(process.env.TMDB_PROXY_URL), proxy: false, timeout: 8000 });

/**
 * One entry per external service. `check(token)` throws if the service rejects the
 * token, otherwise returns what the dialog shows: `details` rows and, where the
 * service has one, today's `quota`.
 */
const SERVICES = {
    telegram: {
        label: 'Telegram Bot API',
        env: 'BOT_TOKEN',
        statusUrl: 'https://t.me/BotFather',
        statusLabel: 'Open @BotFather',
        // Telegraf holds the token for the life of the process
        restartOnChange: true,
        // <bot id>:<secret>. Strict, because the token becomes part of the request path
        format: /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/,
        formatHint: 'a token from @BotFather, like 123456789:AA…',
        check: async (token) => {
            const res = await axios.get(`https://api.telegram.org/bot${token}/getMe`, outbound());
            const me = res.data.result;
            return {
                details: [
                    ['Bot', `@${me.username}`],
                    ['Bot ID', String(me.id)]
                ]
            };
        }
    },
    tmdb: {
        label: 'TMDB API',
        env: 'TMDB_API_KEY',
        // The v4 Read Access Token is a JWT
        format: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
        formatHint: 'the API Read Access Token (starts with eyJ…)',
        statusUrl: 'https://status.themoviedb.org',
        statusLabel: 'Status page',
        check: async (token) => {
            await axios.get('https://api.themoviedb.org/3/authentication', {
                ...outbound(),
                headers: { Authorization: `Bearer ${token}` }
            });
            return { details: [['Quota', 'No daily limit (about 50 requests per second)']] };
        }
    },
    kinopoisk: {
        label: 'Kinopoisk API',
        env: 'KINOPOISK_API_KEY',
        format: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        formatHint: 'a Kinopoisk API key (1a2b3c4d-1a2b-…)',
        statusUrl: 'https://kinopoiskapiunofficial.tech/status',
        statusLabel: 'Status page',
        check: async (token) => {
            const q = await checkKinopoiskKey(token);
            return {
                quota: { used: q.used, limit: q.limit },
                details: [
                    ['Account', q.accountType || '—'],
                    ['Today', `${q.used} of ${q.limit} requests used`]
                ]
            };
        }
    }
};

const describeError = (err) =>
    err.response
        ? `${err.response.status} ${err.response.data?.description || err.response.statusText || ''}`.trim()
        : err.message;

// Own keys only, so "constructor" and friends are not services
const findService = (name) => (Object.hasOwn(SERVICES, name) ? SERVICES[name] : null);

// What the server knows on its own (from .env): instant, so the dialog shows the token
// right away. The service itself is asked separately, below.
router.get('/api/services/:name', (req, res) => {
    const service = findService(req.params.name);
    if (!service) return res.status(404).json({ error: 'Unknown service' });

    const token = process.env[service.env];
    res.json({
        name: req.params.name,
        label: service.label,
        configured: Boolean(token),
        masked: maskToken(token),
        statusUrl: service.statusUrl,
        statusLabel: service.statusLabel,
        restartOnChange: Boolean(service.restartOnChange)
    });
});

// Asks the service whether the current token works: as slow as the service (seconds on a timeout)
router.get('/api/services/:name/check', async (req, res) => {
    const service = findService(req.params.name);
    if (!service) return res.status(404).json({ error: 'Unknown service' });

    const token = process.env[service.env];
    const out = { configured: Boolean(token), ok: false, details: [] };
    if (!token) return res.json(out);

    try {
        Object.assign(out, await service.check(token), { ok: true });
    } catch (err) {
        // Not `error`: the panel treats a body with `error` as a failed request
        out.checkError = describeError(err);
        // The status the service answered with (e.g. 401 for a revoked token); absent when
        // it didn't answer at all: a timeout, a refused or dropped connection
        if (err.response) out.status = err.response.status;
    }
    res.json(out);
});

router.post('/api/services/:name', async (req, res) => {
    const service = findService(req.params.name);
    if (!service) return res.status(404).json({ error: 'Unknown service' });

    const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    if (!service.format.test(token)) {
        return res.status(400).json({ error: `That doesn't look like ${service.formatHint}` });
    }

    try {
        await service.check(token);
    } catch (err) {
        return res.status(400).json({ error: `${service.label} rejected the token: ${describeError(err)}` });
    }

    process.env[service.env] = token;
    updateEnvFile(service.env, token);
    invalidateHealth();
    console.log(`[Admin] ${service.env} updated (${maskToken(token)}).`);

    res.json({ success: true, masked: maskToken(token), restarting: Boolean(service.restartOnChange) });

    // docker-compose's restart policy brings the process straight back with the new .env
    if (service.restartOnChange) setTimeout(() => process.exit(0), 800);
});

module.exports = router;
