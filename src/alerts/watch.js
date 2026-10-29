/**
 * Where the alerts come from (index.js sends them): the end of each update check, a look every
 * minute at the services, the server's memory and whether the check ran on time, and the bot's
 * own start (was the last run stopped, or did it crash?). The texts are here too, in Russian like
 * every message of the bot.
 */
const fs = require('fs');
const path = require('path');
const alerts = require('./index');
const { AlertRecipient } = require('../db');
const catalog = require('./catalog');
const { escapeHtml } = require('../constants');
const cronStatus = require('../cron/status');
const { log } = require('../log');

const { duration } = alerts;
const MINUTE_MS = 60 * 1000;
// A check that hasn't started this long after its time didn't run
const LATE_MS = 10 * MINUTE_MS;
// A run started this shortly before the time counts for it: the scheduled one was skipped as
// a duplicate of a check run from the panel just then (one still going at the time counts too)
const EARLY_MS = 5 * MINUTE_MS;
// Kinopoisk counts requests per day: its key is looked at less often than the rest
const KINOPOISK_EVERY = 5;
// Below this much free memory the server is short; above the second figure it's fine again
const LOW_MEMORY_MB = 150;
const MEMORY_OK_MB = 200;

// Written on a stop the bot chose (the panel's restart, Docker's SIGTERM): no file at the next
// start means the last run crashed. Next to .cron-status.json, which a deploy leaves alone too
const SHUTDOWN_FILE = process.env.SHUTDOWN_FILE || path.join(__dirname, '..', '..', '.shutdown.json');

const code = (text) => `<code>${escapeHtml(String(text).slice(0, 300))}</code>`;

// --- The update check ---------------------------------------------------------------------------

// The unsent queue's size after each of the last checks, newest last
let queueSizes = [];

/**
 * After every update check: did it fail, end with errors, lose messages; is the unsent queue
 * growing.
 * @param {object} run the check's lastRun (src/cron/status.js)
 * @param {number} queued messages left in the queue for the next check
 */
async function afterCheck(run, queued, now = new Date()) {
    const started = new Date(run.startedAt);
    await alerts.resolve(
        'check_late',
        (t) => `🟢 <b>Проверка обновлений снова запускается</b>\nПоследняя в ${t(started)}.`
    );

    if (run.fatal) {
        await alerts.raise(
            'check_failed',
            (t) =>
                `🔴 <b>Проверка обновлений упала</b>\nНачалась в ${t(started)}, оборвалась через ${duration(run.durationMs)}.\n` +
                `${code(run.fatal)}\nСледующая в ${t(cronStatus.getCronStatus().nextRunAt)}.`,
            { now }
        );
    } else {
        await alerts.resolve(
            'check_failed',
            (t, since) => `🟢 <b>Проверка обновлений снова проходит</b>\nПадала с ${t(since)}.`
        );
    }

    if (!run.fatal && run.errors > 0) {
        await alerts.raise(
            'check_errors',
            (t) =>
                `🟠 <b>Проверка прошла с ошибками</b>\n${t(started)}: ошибок ${run.errors}. Подробности — в Логах панели.`,
            { now }
        );
    } else if (!run.fatal) {
        await alerts.resolve('check_errors', () => '🟢 <b>Проверка снова проходит без ошибок</b>');
    }

    const sent = run.sent || 0;
    // Chats that blocked the bot are no sign of trouble
    const failed = (run.failed || 0) - (run.gone || 0);
    if (catalog.sendingBad(sent, failed)) {
        const reason = topReason(run.reasons);
        await alerts.raise(
            'sending_failed',
            (t) =>
                `🔴 <b>Сообщения не уходят</b>\nПроверка ${t(started)}: ${failed} из ${sent + failed} не отправлены` +
                `${queued ? `, в очереди ${queued}` : ''}.` +
                (reason ? `\n${code(reason.text)}${reason.count > 1 ? ` × ${reason.count}` : ''}` : ''),
            { now }
        );
    } else if (sent > 0) {
        await alerts.resolve(
            'sending_failed',
            (t) => `🟢 <b>Сообщения снова уходят</b>\nПроверка ${t(started)}: отправлено ${sent}.`
        );
    }

    queueSizes = [...queueSizes, queued].slice(-3);
    const [a, b, c] = queueSizes;
    if (queueSizes.length === 3 && a < b && b < c) {
        await alerts.raise(
            'queue_growing',
            () =>
                `🟠 <b>Очередь неотправленных растёт</b>\n${a} → ${b} → ${c} за три последние проверки. ` +
                'Сообщения ждут, пока Telegram их примет.',
            { now }
        );
    } else if (queued === 0 || (queueSizes.length > 1 && queued < queueSizes[queueSizes.length - 2])) {
        await alerts.resolve(
            'queue_growing',
            () => `🟢 <b>Очередь неотправленных разбирается</b>\nСейчас в ней ${queued}.`
        );
    }
}

/** The error most of a check's failed sends had: { text, count }, or null. */
function topReason(reasons) {
    const top = Object.entries(reasons || {}).sort((x, y) => y[1] - x[1])[0];
    return top ? { text: top[0], count: top[1] } : null;
}

/**
 * A check that should have started by now and hasn't, the bot down at its time included (a crash
 * around hh:00). Not before the first check ever: there is nothing to go by.
 */
async function checkLate(now = new Date()) {
    const status = cronStatus.getCronStatus();
    const run = status.lastRun;
    // Nothing to go by: no check ever, or the last one ran on another interval (changed in Settings)
    if (status.running || !run || run.intervalHours !== status.intervalHours) return;
    const slot = cronStatus.lastSlotAt(now, status.intervalHours).getTime();
    if (now.getTime() - slot < LATE_MS) return;
    // The bot was stopped on purpose at that time (a deploy, maintenance): not a fault
    if (stoppedAt !== null && slot >= stoppedAt && slot <= processStart.getTime()) return;
    // Started for it, or still going at its time: the scheduled one was skipped as a duplicate
    if (new Date(run.startedAt).getTime() >= slot - EARLY_MS) return;
    if (run.finishedAt && new Date(run.finishedAt).getTime() >= slot) return;
    await alerts.raise(
        'check_late',
        (t) =>
            `🔴 <b>Проверка обновлений не запустилась</b>\nДолжна была в ${t(slot)}. ` +
            'Бот работает, но новые серии и фильмы не проверяются.',
        { now, since: new Date(slot) }
    );
}

// --- Services and memory ------------------------------------------------------------------------

const SERVICES = {
    telegram: { key: 'telegram_down', name: 'Telegram', what: 'Сообщения не уходят.' },
    tmdb: { key: 'tmdb_down', name: 'TMDB', what: 'Новые серии и фильмы не проверяются.' },
    proxy: { key: 'proxy_down', name: 'Прокси', what: 'Запросы через него не проходят.' },
    kinopoisk: { key: 'kinopoisk_down', name: 'Кинопоиск', what: 'Ссылки на Кинопоиск не находятся.' }
};

// service -> when it was first seen failing, while it still fails
let downSince = {};
let lowSince = null;
let tick = 0;

/**
 * One look at a service, as the dashboard's badge sees it (the same check, the same cache).
 * @param {string} name telegram, tmdb, proxy, kinopoisk
 * @param {object} value what checkHealth() answered
 */
async function serviceSeen(name, value, now = new Date()) {
    const { key, name: label, what } = SERVICES[name];
    const failing = value[name] === false || value[name] === 'error';
    if (!failing) {
        delete downSince[name];
        await alerts.resolve(
            key,
            (t, since, at) =>
                `🟢 <b>${label} снова отвечает</b>\nНе было ${duration(at.getTime() - since.getTime())}, ${t(since)}–${t(at)}.`,
            { now }
        );
    } else {
        const since = downSince[name] || (downSince[name] = now);
        if (now.getTime() - since.getTime() >= catalog.ruleValue('downMinutes') * MINUTE_MS) {
            await alerts.raise(
                key,
                (t) =>
                    `${name === 'telegram' ? '🔴' : '🟠'} <b>${label} не отвечает уже ${duration(now.getTime() - since.getTime())}</b>\n` +
                    `С ${t(since)}. ${what}` +
                    (value.reason ? `\n${code(value.reason)}` : ''),
                // Nothing goes out while Telegram is what's down: "it's back" will say how long it wasn't
                { now, since, unsendable: name === 'telegram' }
            );
        }
    }
    // Answering, or not set up any more (the key removed): then the quota is no news either
    if (name === 'kinopoisk' && !failing) {
        const quota = value.kinopoiskQuota || {};
        const used = Number(quota.used);
        const limit = Number(quota.limit);
        if (value.kinopoisk === 'ok' && limit > 0 && used >= limit) {
            await alerts.raise(
                'kinopoisk_quota',
                () =>
                    `🟠 <b>Дневной лимит Кинопоиска исчерпан</b>\nИспользовано ${used} из ${limit}. ` +
                    'До сброса ссылки на Кинопоиск ищутся только через Wikidata.',
                { now }
            );
        } else {
            await alerts.resolve('kinopoisk_quota', () => '🟢 <b>Лимит Кинопоиска снова доступен</b>', { now });
        }
    }
}

/** MemAvailable from /proc/meminfo, in MB; null where there is none (not Linux). */
function freeMemoryMb() {
    try {
        const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
        return m ? Math.round(Number(m[1]) / 1024) : null;
    } catch {
        return null;
    }
}

async function memorySeen(mb, now = new Date()) {
    if (mb === null) return;
    if (mb < LOW_MEMORY_MB) {
        lowSince = lowSince || now;
        if (now.getTime() - lowSince.getTime() >= catalog.ruleValue('downMinutes') * MINUTE_MS) {
            const since = lowSince;
            await alerts.raise(
                'low_memory',
                () =>
                    `🟠 <b>На сервере мало памяти</b>\nСвободно ${mb} МБ уже ${duration(now.getTime() - since.getTime())}. ` +
                    'Бот или база могут упасть.',
                { now, since }
            );
        }
    } else if (mb > MEMORY_OK_MB) {
        lowSince = null;
        await alerts.resolve('low_memory', () => `🟢 <b>Память на сервере в норме</b>\nСвободно ${mb} МБ.`, { now });
    }
}

/** The minute's look: the services, memory, the check's schedule. */
async function look(bot, now = new Date()) {
    // No one to tell: no requests to the services every minute; outages count from the first look,
    // and a recipient added later hears of one still going on
    if (!(await AlertRecipient.count())) {
        resetWatch();
        alerts.reset();
        return;
    }
    const { checkHealth } = require('../admin/routes/health');
    tick += 1;
    const names = Object.keys(SERVICES).filter((name) => name !== 'kinopoisk' || tick % KINOPOISK_EVERY === 1);
    // All at once: a service down takes its full timeout, one after another they'd take the minute
    const values = await Promise.all(names.map((name) => checkHealth(name, bot).catch((err) => err)));
    for (const [i, name] of names.entries()) {
        try {
            if (values[i] instanceof Error) throw values[i];
            await serviceSeen(name, values[i], now);
        } catch (err) {
            log.error(`[Alerts] Looking at ${name} failed: ${err.message}`);
        }
    }
    await memorySeen(freeMemoryMb(), now);
    await checkLate(now);
}

// --- Start and stop -----------------------------------------------------------------------------

const processStart = new Date();
// When the last run was stopped on purpose (the panel's restart, Docker's SIGTERM); null after a crash
let stoppedAt = null;

/**
 * Before a stop the bot chose: why, for the next start to tell. Never throws.
 * @param {{ keep?: boolean }} [options] keep: leave a mark already written (the panel's, before its SIGTERM-less exit)
 */
function markShutdown(reason, { keep = false } = {}) {
    try {
        if (keep && fs.existsSync(SHUTDOWN_FILE)) return;
        fs.writeFileSync(SHUTDOWN_FILE, JSON.stringify({ reason, at: new Date().toISOString() }));
    } catch (err) {
        log.error(`[Alerts] Couldn't write the shutdown mark: ${err.message}`);
    }
}

/**
 * How the last run ended: { reason: 'panel' | 'signal' } for a stop it chose, 'crash' when it
 * didn't say, null on the very first start (no update check has ever run). Clears the mark.
 */
function lastShutdown() {
    let mark = null;
    try {
        mark = JSON.parse(fs.readFileSync(SHUTDOWN_FILE, 'utf8'));
    } catch {
        // none, or unreadable: as if none
    }
    try {
        fs.rmSync(SHUTDOWN_FILE, { force: true });
    } catch {
        // a mark left behind only makes the next crash look like a restart
    }
    if (mark && mark.reason) return { reason: mark.reason, at: mark.at };
    return cronStatus.getCronStatus().lastRun ? { reason: 'crash' } : null;
}

const START_TRIES = 5;

/**
 * At start: tells how the last run ended. Once an hour, by the log: a crash loop restarts the
 * process every minute. Tried again for a few minutes when it reached no one (the network that
 * brought the bot down may not be back yet).
 * @param {string | null} version
 * @param {{ reason: string } | null} how lastShutdown(), read at the very start
 */
async function startupAlert(version, how, { pause = MINUTE_MS } = {}) {
    if (!how) return;
    const v = version ? ` Версия ${code(version)}.` : '';
    const crash = how.reason === 'crash';
    const key = crash ? 'restart_crash' : 'restart';
    if (await alerts.sentLately(key)) return;
    const why = how.reason === 'panel' ? 'Из панели.' : 'Контейнер перезапустили: обновление или сервер.';
    const text = crash
        ? (t) => `🔴 <b>Бот перезапущен после сбоя</b>\n${t(processStart)}: прошлый запуск не завершился сам.${v}`
        : (t) => `⚪️ <b>Бот перезапущен</b>\n${t(processStart)}. ${why}${v}`;
    for (let i = 1; i <= START_TRIES; i += 1) {
        const result = await alerts.once(key, text);
        if (!result || result.sent || result.failed <= result.unreachable || i === START_TRIES) return;
        await new Promise((resolve) => setTimeout(resolve, pause));
    }
}

/**
 * Starts the minute's look and the log's daily sweep, and tells how the last run ended.
 * @param {{ version?: string | null, ended?: { reason: string } | null }} [options] ended:
 *   lastShutdown(), read at the very start, before anything that can fail
 */
function startAlerts(bot, { version = null, ended = null } = {}) {
    alerts.useBot(bot);
    noteStop(ended);
    startupAlert(version, ended).catch((err) => log.error(`[Alerts] Start alert failed: ${err.message}`));
    let busy = false;
    setInterval(async () => {
        // A slow look (Telegram's retries) mustn't overlap the next
        if (busy) return;
        busy = true;
        await look(bot).catch((err) => log.error(`[Alerts] Look failed: ${err.message}`));
        busy = false;
    }, MINUTE_MS).unref();
    const sweep = () => alerts.sweepLog().catch((err) => log.error(`[Alerts] Log sweep failed: ${err.message}`));
    sweep();
    setInterval(sweep, 24 * 60 * MINUTE_MS).unref();
}

/** Remembers a stop the bot chose, for checkLate: a slot missed during it isn't a fault. */
function noteStop(ended) {
    const at = ended && ended.reason !== 'crash' && ended.at ? new Date(ended.at).getTime() : NaN;
    stoppedAt = Number.isNaN(at) ? null : at;
}

/** Forgets what was seen: for tests. */
function resetWatch() {
    queueSizes = [];
    downSince = {};
    lowSince = null;
    tick = 0;
    stoppedAt = null;
}

module.exports = {
    afterCheck,
    checkLate,
    serviceSeen,
    memorySeen,
    markShutdown,
    lastShutdown,
    startupAlert,
    startAlerts,
    resetWatch,
    look,
    noteStop
};
