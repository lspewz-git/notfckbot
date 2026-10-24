/**
 * The Settings section: the server's .env field by field. Every changed value is checked before
 * anything is written (tokens with their service, the proxy as a URL, the interval against the
 * schedules that work), then all of them go to .env in one write. Restart from here too.
 */
const { writeEnv, isSafeEnvValue, maskToken } = require('../env');
const {
    proxyUrlProblem,
    withSavedPassword,
    redactProxyUrl,
    hasProxyPassword,
    applyProxyToBot
} = require('../../proxy');
const { UPDATE_INTERVAL_HOURS, INTERVAL_CHOICES, parseIntervalHours } = require('../../constants');
const { SERVICES, describeError } = require('./services');
const { invalidateHealth } = require('./health');
const { restartBlock, restartSoon } = require('../restart');
const { readSchedule } = require('../../recap/schedule');

const router = require('express').Router();
const { log } = require('../../log');

/** What waits for a restart: saved, but the running process still uses the old value. */
function pendingRestart(bot) {
    const pending = [];
    if (parseIntervalHours(process.env.UPDATE_INTERVAL_HOURS, { quiet: true }) !== UPDATE_INTERVAL_HOURS)
        pending.push('interval');
    // Telegraf holds the token it started with
    if (bot && bot.telegram && process.env.BOT_TOKEN && bot.telegram.token !== process.env.BOT_TOKEN) {
        pending.push('telegram');
    }
    return pending;
}

/** Everything the page shows. Secrets only masked; the database password not at all. */
function currentSettings(bot) {
    return {
        tokens: Object.fromEntries(
            Object.entries(SERVICES).map(([name, service]) => [
                name,
                { masked: maskToken(process.env[service.env]), configured: Boolean(process.env[service.env]) }
            ])
        ),
        proxy: {
            url: redactProxyUrl(process.env.TMDB_PROXY_URL),
            hasPassword: hasProxyPassword(process.env.TMDB_PROXY_URL)
        },
        interval: {
            hours: parseIntervalHours(process.env.UPDATE_INTERVAL_HOURS, { quiet: true }),
            active: UPDATE_INTERVAL_HOURS,
            choices: INTERVAL_CHOICES
        },
        database: {
            host: process.env.DB_HOST || '',
            name: process.env.DB_NAME || '',
            user: process.env.DB_USER || ''
        },
        // The year recap sent by date: shown here, set in Year recap → Schedule (routes/recap-schedule.js)
        recap: readSchedule(),
        restart: { pending: pendingRestart(bot), blocked: restartBlock() },
        // When this process started: the panel shows "running since"
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString()
    };
}

router.get('/api/settings', (req, res) => {
    res.json(currentSettings(req.app.get('bot')));
});

/**
 * Body: any of { tokens: { telegram?, tmdb?, kinopoisk? }, proxyUrl?, intervalHours? }; what is
 * left out stays as it is. On a problem nothing is written, and `fields` says which field it is.
 */
router.post('/api/settings', async (req, res) => {
    const body = req.body || {};
    const changes = {};
    const fields = {};

    if (body.intervalHours !== undefined) {
        const hours = Number(body.intervalHours);
        if (!INTERVAL_CHOICES.includes(hours)) fields.interval = `Pick one of ${INTERVAL_CHOICES.join(', ')} hours`;
        // 3 with nothing in .env is no change: the default is 3 already
        else if (hours !== parseIntervalHours(process.env.UPDATE_INTERVAL_HOURS, { quiet: true })) {
            changes.UPDATE_INTERVAL_HOURS = String(hours);
        }
    }

    if (body.proxyUrl !== undefined) {
        const typed = typeof body.proxyUrl === 'string' ? body.proxyUrl.trim() : '';
        const url = withSavedPassword(typed, process.env.TMDB_PROXY_URL);
        const problem = !isSafeEnvValue(url) || /\s/.test(url) ? 'One line, no spaces' : proxyUrlProblem(url);
        if (problem) fields.proxy = problem;
        else changes.TMDB_PROXY_URL = url;
    }

    // Each token is checked with its own service; all at once, so a slow one doesn't add up
    const tokens = body.tokens && typeof body.tokens === 'object' ? body.tokens : {};
    await Promise.all(
        Object.entries(tokens).map(async ([name, value]) => {
            const service = Object.hasOwn(SERVICES, name) ? SERVICES[name] : null;
            if (!service) return;
            const token = typeof value === 'string' ? value.trim() : '';
            if (!service.format.test(token)) {
                fields[name] = `That doesn't look like ${service.formatHint}`;
                return;
            }
            try {
                await service.check(token);
                changes[service.env] = token;
            } catch (err) {
                fields[name] = `${service.label} rejected it: ${describeError(err)}`;
            }
        })
    );

    if (Object.keys(fields).length) {
        return res.status(400).json({ error: 'Nothing was saved: fix the marked fields', fields });
    }
    // Unchanged values are not news
    for (const [key, value] of Object.entries(changes)) if (process.env[key] === value) delete changes[key];
    if (!Object.keys(changes).length) return res.json({ saved: [], settings: currentSettings(req.app.get('bot')) });

    try {
        writeEnv(changes);
    } catch (err) {
        return res.status(500).json({ error: `Couldn't write .env: ${err.message}` });
    }
    Object.assign(process.env, changes);
    // The proxy and the TMDB and Kinopoisk keys apply at once; the interval and the Telegram
    // token on the next start
    if ('TMDB_PROXY_URL' in changes) applyProxyToBot(req.app.get('bot'));
    invalidateHealth();
    const saved = Object.keys(changes);
    log.info(`[Admin] Settings saved: ${saved.join(', ')}`);
    res.json({ saved, settings: currentSettings(req.app.get('bot')) });
});

router.post('/api/restart', (req, res) => {
    const blocked = restartBlock();
    if (blocked) return res.status(409).json({ error: 'An update check is due or running', blocked });
    res.json({ restarting: true });
    restartSoon('asked for in Settings');
});

module.exports = router;
module.exports.currentSettings = currentSettings;
