/**
 * Alerts to the people who run the bot (src/alerts/): who hears what, the first alert and its
 * repeats, "fixed" only after an alert, a service down only past its minutes, Telegram's own outage
 * told when it's back, how the last run ended, and the panel's API refusing bad input. The
 * database is stubbed, .env and the shutdown mark are temporary files. Run: npm run test:unit
 */
const { test, describe, mock, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-'));
const RULE_KEYS = ['ALERT_DOWN_MINUTES', 'ALERT_SEND_SHARE', 'ALERT_REPEAT_HOURS', 'ALERT_FIXED'];
const savedEnv = Object.fromEntries([...RULE_KEYS, 'ENV_FILE', 'SHUTDOWN_FILE'].map((k) => [k, process.env[k]]));
process.env.ENV_FILE = path.join(DIR, '.env');
process.env.SHUTDOWN_FILE = path.join(DIR, '.shutdown.json');

const { AlertRecipient, AlertLog, Chat } = require('../../src/db');
const catalog = require('../../src/alerts/catalog');
const alerts = require('../../src/alerts');
const watch = require('../../src/alerts/watch');
const cronStatus = require('../../src/cron/status');
const { fakeBot } = require('./fakes');

after(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(DIR, { recursive: true, force: true });
});

// Recipients as rows, the chats behind them, what was logged
let rows = [];
let chats = [];
let logged = [];
let bot;
const recipient = (chatId, preset, events = null) => ({
    chatId: String(chatId),
    preset,
    events: events && JSON.stringify(events),
    update: async () => {}
});
const person = (id, fields = {}) => ({
    id,
    username: `chat${id}`,
    timezone: 'Europe/Moscow',
    bot_status: 'active',
    ...fields
});

beforeEach(() => {
    for (const k of RULE_KEYS) delete process.env[k];
    rows = [recipient(1, 'all'), recipient(2, 'critical')];
    chats = [person(1), person(2)];
    logged = [];
    bot = fakeBot();
    alerts.useBot(bot);
    alerts.reset();
    watch.resetWatch();
    mock.method(AlertRecipient, 'findAll', async ({ where } = {}) =>
        rows.filter((r) => !where || where.chatId === undefined || r.chatId === where.chatId)
    );
    mock.method(Chat, 'findAll', async () => chats);
    mock.method(AlertLog, 'create', async (row) => logged.push(row));
    mock.method(AlertLog, 'findOne', async () => null);
});
afterEach(() => mock.restoreAll());

const to = (chatId) => bot.sent.filter((m) => String(m.chatId) === String(chatId));
const at = (iso) => new Date(iso);

describe('who hears what', () => {
    test('everything, critical only, or the events picked', () => {
        assert.equal(catalog.wants({ preset: 'all' }, 'low_memory'), true);
        assert.equal(catalog.wants({ preset: 'critical' }, 'check_failed'), true);
        assert.equal(catalog.wants({ preset: 'critical' }, 'tmdb_down'), false);
        const custom = { preset: 'custom', events: JSON.stringify(['tmdb_down', 'nonsense']) };
        assert.equal(catalog.wants(custom, 'tmdb_down'), true);
        assert.equal(catalog.wants(custom, 'check_failed'), false);
        assert.deepEqual(catalog.eventsOf(custom), ['tmdb_down']);
        assert.deepEqual(catalog.eventsOf({ events: '{broken' }), []);
    });

    test('an alert goes to those who want it; a chat that left the bot is skipped and counted', async () => {
        rows.push(recipient(3, 'all'));
        chats.push(person(3, { bot_status: 'stopped' }));
        await alerts.raise('tmdb_down', () => 'TMDB down');
        assert.equal(to(1).length, 1);
        // Critical only: TMDB isn't
        assert.equal(to(2).length, 0);
        assert.equal(to(3).length, 0);
        assert.deepEqual(
            { event: logged[0].event, kind: logged[0].kind, sent: logged[0].sent, failed: logged[0].failed },
            { event: 'tmdb_down', kind: 'alert', sent: 1, failed: 1 }
        );
        assert.equal(logged[0].sentTo, 'chat1');
    });

    test("the time in the text is the recipient's own zone", async () => {
        chats = [person(1, { timezone: 'Asia/Vladivostok' }), person(2)];
        await alerts.raise('check_failed', (t) => t(at('2026-10-29T12:00:00Z')));
        assert.equal(to(1)[0].text, '22:00');
        assert.equal(to(2)[0].text, '15:00');
    });
});

describe('repeats and "fixed"', () => {
    test('raised again: nothing until the repeat time has passed', async () => {
        process.env.ALERT_REPEAT_HOURS = '3';
        await alerts.raise('check_failed', () => 'down', { now: at('2026-10-29T10:00:00Z') });
        await alerts.raise('check_failed', () => 'down', { now: at('2026-10-29T12:59:00Z') });
        assert.equal(to(1).length, 1);
        await alerts.raise('check_failed', () => 'down', { now: at('2026-10-29T13:00:00Z') });
        assert.equal(to(1).length, 2);
    });

    test('repeat "never": one alert however long it lasts', async () => {
        process.env.ALERT_REPEAT_HOURS = '0';
        await alerts.raise('check_failed', () => 'down', { now: at('2026-10-29T10:00:00Z') });
        await alerts.raise('check_failed', () => 'down', { now: at('2026-10-30T10:00:00Z') });
        assert.equal(to(1).length, 1);
    });

    test('"fixed" follows an alert, with when it started; never without one', async () => {
        await alerts.resolve('check_failed', () => 'fixed');
        assert.equal(bot.sent.length, 0);
        await alerts.raise('check_failed', () => 'down', { now: at('2026-10-29T10:00:00Z') });
        await alerts.resolve('check_failed', (t, since) => `fixed since ${t(since)}`);
        assert.equal(to(1)[1].text, 'fixed since 13:00');
        assert.equal(logged[1].kind, 'fixed');
        // Once: it is no longer raised
        await alerts.resolve('check_failed', () => 'fixed');
        assert.equal(to(1).length, 2);
    });

    test('"fixed" switched off: the alert alone', async () => {
        process.env.ALERT_FIXED = 'off';
        await alerts.raise('check_failed', () => 'down');
        await alerts.resolve('check_failed', () => 'fixed');
        assert.deepEqual(
            to(1).map((m) => m.text),
            ['down']
        );
    });

    test('a one-off goes out once an hour at most', async () => {
        await alerts.once('recap_failed', () => 'a', { now: at('2026-10-29T10:00:00Z') });
        await alerts.once('recap_failed', () => 'b', { now: at('2026-10-29T10:30:00Z') });
        await alerts.once('recap_failed', () => 'c', { now: at('2026-10-29T11:00:00Z') });
        assert.deepEqual(
            to(1).map((m) => m.text),
            ['a', 'c']
        );
    });

    test('a one-off about another chat is news of its own; one that reached no one goes out next time', async () => {
        const now = at('2026-10-29T10:00:00Z');
        await alerts.once('recap_failed', () => 'chat 5', { now, id: 5 });
        await alerts.once('recap_failed', () => 'chat 6', { now, id: 6 });
        await alerts.once('recap_failed', () => 'chat 5 again', { now, id: 5 });
        assert.deepEqual(
            to(1).map((m) => m.text),
            ['chat 5', 'chat 6']
        );
        // A recipient whose chat the bot can't find yet: wanted, not reached
        rows = [recipient(9, 'all')];
        assert.deepEqual(await alerts.once('restart', () => 'lost', { now }), {
            sent: 0,
            failed: 1,
            wanted: 1,
            unreachable: 1
        });
        chats.push(person(9));
        await alerts.once('restart', () => 'again', { now });
        assert.deepEqual(
            to(9).map((m) => m.text),
            ['again']
        );
    });

    test("an alert the database didn't let out is due again at the next look", async () => {
        const findAll = AlertRecipient.findAll;
        mock.method(AlertRecipient, 'findAll', async () => {
            throw new Error('Connection lost');
        });
        await alerts.raise('check_failed', () => 'down', { now: at('2026-10-29T10:00:00Z') });
        mock.method(AlertRecipient, 'findAll', findAll);
        await alerts.raise('check_failed', () => 'down', { now: at('2026-10-29T10:01:00Z') });
        assert.deepEqual(
            to(1).map((m) => m.text),
            ['down']
        );
    });

    test('"fixed" waits for the alert still going out: with fixed messages off, none after a delivered alert', async () => {
        process.env.ALERT_FIXED = 'off';
        const raising = alerts.raise('check_late', () => 'late');
        await alerts.resolve('check_late', () => 'fixed');
        await raising;
        assert.deepEqual(
            to(1).map((m) => m.text),
            ['late']
        );
    });

    test('nobody wants it yet: whoever turns it on hears at the next look, not after the repeat time', async () => {
        rows = [recipient(2, 'critical')];
        await alerts.raise('tmdb_down', () => 'TMDB down', { now: at('2026-10-29T10:00:00Z') });
        assert.equal(bot.sent.length, 0);
        rows = [recipient(2, 'custom', ['tmdb_down'])];
        await alerts.raise('tmdb_down', () => 'TMDB down', { now: at('2026-10-29T10:01:00Z') });
        assert.equal(to(2).length, 1);
        // And "fixed" when it ends
        await alerts.resolve('tmdb_down', () => 'fixed');
        assert.equal(to(2).length, 2);
    });

    test('a test goes to everyone, or to one, whatever they chose', async () => {
        const all = await alerts.sendTest();
        assert.deepEqual({ sent: all.sent, failed: all.failed }, { sent: 2, failed: 0 });
        assert.match(to(2)[0].text, /только критичные/);
        await alerts.sendTest('1');
        assert.equal(to(1).length, 2);
        assert.equal(to(2).length, 1);
    });
});

describe('services', () => {
    const t0 = Date.parse('2026-10-29T10:00:00Z');
    const minute = (n) => new Date(t0 + n * 60 * 1000);

    test("down for the rule's minutes before an alert; back: how long it was out", async () => {
        process.env.ALERT_DOWN_MINUTES = '10';
        await watch.serviceSeen('tmdb', { tmdb: false, reason: 'timeout' }, minute(0));
        await watch.serviceSeen('tmdb', { tmdb: false, reason: 'timeout' }, minute(9));
        assert.equal(bot.sent.length, 0);
        await watch.serviceSeen('tmdb', { tmdb: false, reason: 'timeout' }, minute(10));
        assert.match(to(1)[0].text, /TMDB не отвечает уже 10 мин/);
        assert.match(to(1)[0].text, /<code>timeout<\/code>/);
        await watch.serviceSeen('tmdb', { tmdb: true }, minute(35));
        assert.match(to(1)[1].text, /TMDB снова отвечает[\s\S]*Не было 35 мин, 13:00–13:35/);
    });

    test('a short blip: no alert, and no "back" either', async () => {
        await watch.serviceSeen('tmdb', { tmdb: false }, minute(0));
        await watch.serviceSeen('tmdb', { tmdb: true }, minute(3));
        assert.equal(bot.sent.length, 0);
    });

    test('Telegram down: nothing tried while it is; when back, the outage, even with "fixed" off', async () => {
        process.env.ALERT_FIXED = 'off';
        await watch.serviceSeen('telegram', { telegram: false }, minute(0));
        await watch.serviceSeen('telegram', { telegram: false }, minute(15));
        assert.equal(bot.sent.length, 0);
        await watch.serviceSeen('telegram', { telegram: true }, minute(40));
        assert.match(to(2)[0].text, /Telegram снова отвечает[\s\S]*Не было 40 мин/);
    });

    test('a proxy or a key that is off is not down', async () => {
        await watch.serviceSeen('proxy', { proxy: 'off' }, minute(0));
        await watch.serviceSeen('proxy', { proxy: 'off' }, minute(60));
        await watch.serviceSeen('kinopoisk', { kinopoisk: 'off' }, minute(60));
        assert.equal(bot.sent.length, 0);
    });

    test("Kinopoisk's quota used up: told once, and when it is back", async () => {
        const full = { kinopoisk: 'ok', kinopoiskQuota: { used: 500, limit: 500 } };
        await watch.serviceSeen('kinopoisk', full, minute(0));
        await watch.serviceSeen('kinopoisk', full, minute(5));
        await watch.serviceSeen('kinopoisk', { kinopoisk: 'ok', kinopoiskQuota: { used: 0, limit: 500 } }, minute(600));
        assert.deepEqual(
            to(1).map((m) => /Лимит|лимит/.test(m.text)),
            [true, true]
        );
        assert.equal(to(1).length, 2);
    });

    test('low memory past the minutes; fine again only well above the line', async () => {
        await watch.memorySeen(100, minute(0));
        await watch.memorySeen(120, minute(10));
        assert.match(to(1)[0].text, /мало памяти[\s\S]*Свободно 120 МБ/);
        await watch.memorySeen(170, minute(20));
        assert.equal(to(1).length, 1);
        await watch.memorySeen(400, minute(30));
        assert.match(to(1)[1].text, /Память на сервере в норме/);
    });
});

describe('after an update check', () => {
    const run = (fields) => ({
        startedAt: '2026-10-29T12:00:00Z',
        durationMs: 12000,
        sent: 0,
        failed: 0,
        errors: 0,
        fatal: null,
        reasons: {},
        ...fields
    });

    test('a failed check: the error and the next check; the next good one says it passes again', async () => {
        await watch.afterCheck(run({ fatal: 'connect ETIMEDOUT' }), 0);
        assert.match(to(2)[0].text, /Проверка обновлений упала[\s\S]*через 12 с[\s\S]*ETIMEDOUT/);
        await watch.afterCheck(run({ startedAt: '2026-10-29T15:00:00Z', sent: 3 }), 0);
        assert.match(to(2)[1].text, /снова проходит/);
    });

    test("messages lost by the rule's share, with the commonest error", async () => {
        process.env.ALERT_SEND_SHARE = 'half';
        await watch.afterCheck(run({ sent: 5, failed: 4 }), 4);
        assert.equal(to(2).length, 0);
        await watch.afterCheck(run({ sent: 2, failed: 7, reasons: { '429: Too Many Requests': 6, other: 1 } }), 7);
        assert.match(to(2)[0].text, /7 из 9 не отправлены, в очереди 7[\s\S]*429: Too Many Requests<\/code> × 6/);
        // A check with nothing to send says nothing about sending
        await watch.afterCheck(run({}), 7);
        assert.equal(to(2).length, 1);
        await watch.afterCheck(run({ sent: 4 }), 0);
        assert.match(to(2)[1].text, /Сообщения снова уходят/);
    });

    test('the share rule: any, a quarter, half, all', () => {
        assert.equal(catalog.sendingBad(9, 1, 'any'), true);
        assert.equal(catalog.sendingBad(6, 2, 'quarter'), true);
        assert.equal(catalog.sendingBad(2, 2, 'half'), true);
        // One lost of two is no outage; the only one lost is
        assert.equal(catalog.sendingBad(1, 1, 'half'), false);
        assert.equal(catalog.sendingBad(0, 1, 'half'), true);
        assert.equal(catalog.sendingBad(1, 0, 'any'), false);
        assert.equal(catalog.sendingBad(1, 5, 'all'), false);
        assert.equal(catalog.sendingBad(0, 5, 'all'), true);
    });

    test('the unsent queue growing three checks running; a stuck one is not "draining"', async () => {
        await watch.afterCheck(run({}), 2);
        await watch.afterCheck(run({}), 5);
        assert.equal(to(1).length, 0);
        await watch.afterCheck(run({}), 9);
        assert.match(to(1)[0].text, /2 → 5 → 9/);
        await watch.afterCheck(run({}), 9);
        assert.equal(to(1).length, 1);
        await watch.afterCheck(run({}), 4);
        assert.match(to(1)[1].text, /разбирается[\s\S]*Сейчас в ней 4/);
    });

    test('chats that blocked the bot are no sign that messages fail', async () => {
        await watch.afterCheck(run({ sent: 0, failed: 2, gone: 2 }), 0);
        assert.equal(to(2).length, 0);
        await watch.afterCheck(run({ sent: 0, failed: 3, gone: 1 }), 2);
        assert.match(to(2)[0].text, /2 из 2 не отправлены/);
    });

    test("a check that didn't start on time", async () => {
        const status = {
            running: false,
            intervalHours: 3,
            lastRun: { startedAt: '2026-10-29T09:00:00Z', finishedAt: '2026-10-29T09:02:00Z', intervalHours: 3 }
        };
        mock.method(cronStatus, 'getCronStatus', () => status);
        mock.method(cronStatus, 'lastSlotAt', () => at('2026-10-29T12:00:00Z'));
        await watch.checkLate(at('2026-10-29T12:05:00Z'));
        assert.equal(bot.sent.length, 0);
        // The bot down at 12:00 (a crash, a restart) counts too: no check since 09:00
        await watch.checkLate(at('2026-10-29T12:10:00Z'));
        assert.match(to(2)[0].text, /не запустилась[\s\S]*в 15:00/);
        alerts.reset();
        // A check run from the panel at 11:58 took the 12:00 one's place
        status.lastRun = { startedAt: '2026-10-29T11:58:00Z', finishedAt: '2026-10-29T11:59:00Z', intervalHours: 3 };
        await watch.checkLate(at('2026-10-29T12:20:00Z'));
        // One from the panel at 11:40 still going at 12:00: the scheduled one was skipped for it
        status.lastRun = { startedAt: '2026-10-29T11:40:00Z', finishedAt: '2026-10-29T12:03:00Z', intervalHours: 3 };
        await watch.checkLate(at('2026-10-29T12:20:00Z'));
        // No check ever: nothing to go by
        status.lastRun = null;
        await watch.checkLate(at('2026-10-29T12:20:00Z'));
        // The last one ran every 6 hours, the interval is 3 now: its times say nothing yet
        status.lastRun = { startedAt: '2026-10-29T06:00:00Z', finishedAt: '2026-10-29T06:02:00Z', intervalHours: 6 };
        await watch.checkLate(at('2026-10-29T12:20:00Z'));
        assert.equal(to(2).length, 1);
    });

    test('a check missed while the bot was stopped on purpose is no fault; after a crash it is', async () => {
        const status = {
            running: false,
            intervalHours: 3,
            lastRun: { startedAt: '2026-10-29T09:00:00Z', finishedAt: '2026-10-29T09:02:00Z', intervalHours: 3 }
        };
        mock.method(cronStatus, 'getCronStatus', () => status);
        mock.method(cronStatus, 'lastSlotAt', () => at('2026-10-29T12:00:00Z'));
        // Stopped at 11:58 (a deploy); this process started after 12:00
        watch.noteStop({ reason: 'signal', at: '2026-10-29T11:58:00Z' });
        await watch.checkLate(at('2099-01-01T00:00:00Z'));
        assert.equal(bot.sent.length, 0);
        watch.noteStop({ reason: 'crash' });
        await watch.checkLate(at('2099-01-01T00:00:00Z'));
        assert.equal(to(2).length, 1);
    });

    test('the last time the check was due, when the interval does not divide the day', () => {
        const local = (h, m) => new Date(2026, 9, 29, h, m);
        // Every 5 hours: 00, 05, 10, 15, 20, then 00 again
        assert.equal(cronStatus.lastSlotAt(local(20, 30), 5).getTime(), local(20, 0).getTime());
        assert.equal(cronStatus.lastSlotAt(local(23, 59), 5).getTime(), local(20, 0).getTime());
        assert.equal(cronStatus.lastSlotAt(local(0, 10), 5).getTime(), local(0, 0).getTime());
        assert.equal(cronStatus.lastSlotAt(local(14, 0), 3).getTime(), local(12, 0).getTime());
    });
});

describe('how the last run ended', () => {
    const file = () => process.env.SHUTDOWN_FILE;

    test('a mark from the panel or a signal; none means a crash; the mark is used once', async () => {
        watch.markShutdown('panel');
        // Docker's SIGTERM after the panel's exit keeps the panel's word
        watch.markShutdown('signal', { keep: true });
        assert.equal(watch.lastShutdown().reason, 'panel');
        assert.equal(fs.existsSync(file()), false);
        mock.method(cronStatus, 'getCronStatus', () => ({ lastRun: { startedAt: 'x' } }));
        assert.equal(watch.lastShutdown().reason, 'crash');
    });

    test('the very first start says nothing', () => {
        mock.method(cronStatus, 'getCronStatus', () => ({ lastRun: null }));
        assert.equal(watch.lastShutdown(), null);
    });

    test('a crash is critical, a restart is not', async () => {
        await watch.startupAlert('abc1234', { reason: 'crash' });
        assert.match(to(2)[0].text, /после сбоя[\s\S]*abc1234/);
        await watch.startupAlert('abc1234', { reason: 'signal' });
        assert.equal(to(2).length, 1);
        assert.match(to(1)[1].text, /Бот перезапущен<\/b>[\s\S]*Контейнер перезапустили/);
    });

    test('a crash loop: once an hour by the log, which outlives the process', async () => {
        mock.method(AlertLog, 'findOne', async ({ where }) => (where.event === 'restart_crash' ? { id: 1 } : null));
        await watch.startupAlert('abc1234', { reason: 'crash' });
        assert.equal(bot.sent.length, 0);
    });

    test('a start alert that reached no one is tried again', async () => {
        rows = [recipient(1, 'all')];
        let tries = 0;
        mock.method(alerts, 'once', async () => {
            tries += 1;
            return tries < 3
                ? { sent: 0, failed: 1, wanted: 1, unreachable: 0 }
                : { sent: 1, failed: 0, wanted: 1, unreachable: 0 };
        });
        await watch.startupAlert('abc1234', { reason: 'crash' }, { pause: 0 });
        assert.equal(tries, 3);
        // Only chats the bot has lost want it: trying again won't reach them
        tries = 0;
        mock.method(alerts, 'once', async () => {
            tries += 1;
            return { sent: 0, failed: 1, wanted: 1, unreachable: 1 };
        });
        await watch.startupAlert('abc1234', { reason: 'crash' }, { pause: 0 });
        assert.equal(tries, 1);
    });

    test("the start alert waits for Telegram's first answer: an outage outlasts its tries", async () => {
        mock.method(alerts, 'sweepLog', async () => 0);
        mock.method(alerts, 'sentLately', async () => false);
        const sent = [];
        mock.method(alerts, 'once', async (key) => {
            sent.push(key);
            return { sent: 1, failed: 0, wanted: 1, unreachable: 0 };
        });
        let answer;
        const ready = new Promise((resolve) => {
            answer = resolve;
        });
        watch.startAlerts({}, { version: 'abc1234', ended: { reason: 'crash' }, ready });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(sent, []);
        answer();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(sent, ['restart_crash']);
    });
});

describe('rules in .env', () => {
    test('defaults, and a value that is not one of the choices', () => {
        assert.deepEqual(catalog.readRules({}), { downMinutes: 10, sendShare: 'half', repeatHours: 6, fixed: true });
        assert.deepEqual(
            catalog.readRules({
                ALERT_DOWN_MINUTES: '7',
                ALERT_SEND_SHARE: 'all',
                ALERT_REPEAT_HOURS: '0',
                ALERT_FIXED: 'off'
            }),
            { downMinutes: 10, sendShare: 'all', repeatHours: 0, fixed: false }
        );
    });

    test('saved to .env and to this process', () => {
        catalog.saveRules({ downMinutes: 30, sendShare: 'any', repeatHours: 12, fixed: false });
        assert.match(
            fs.readFileSync(process.env.ENV_FILE, 'utf8'),
            /ALERT_DOWN_MINUTES=30\nALERT_SEND_SHARE=any\nALERT_REPEAT_HOURS=12\nALERT_FIXED=off/
        );
        assert.equal(catalog.ruleValue('repeatHours'), 12);
    });
});

describe("the minute's look", () => {
    test('no recipients: no requests to the services at all', async () => {
        mock.method(AlertRecipient, 'count', async () => 0);
        const asked = [];
        const spy = { telegram: { callApi: async (method) => asked.push(method) } };
        await watch.look(spy, at('2026-10-29T10:00:00Z'));
        assert.deepEqual(asked, []);
    });

    test('services asked together, Kinopoisk every fifth look; one that throws leaves the rest', async () => {
        mock.method(AlertRecipient, 'count', async () => 1);
        mock.method(cronStatus, 'getCronStatus', () => ({ running: true }));
        const health = require('../../src/admin/routes/health');
        const asked = [];
        mock.method(health, 'checkHealth', async (name) => {
            asked.push(name);
            if (name === 'tmdb') throw new Error('boom');
            return { [name]: 'ok' };
        });
        for (let i = 0; i < 6; i += 1) await watch.look({}, at('2026-10-29T10:00:00Z'));
        assert.equal(asked.filter((n) => n === 'kinopoisk').length, 2);
        assert.equal(asked.filter((n) => n === 'proxy').length, 6);
    });

    test('the Kinopoisk quota: numbers only, and no longer news once the key is gone', async () => {
        const now = at('2026-10-29T10:00:00Z');
        await watch.serviceSeen('kinopoisk', { kinopoisk: 'ok', kinopoiskQuota: { used: '<b>', limit: 5 } }, now);
        assert.equal(to(1).length, 0);
        await watch.serviceSeen('kinopoisk', { kinopoisk: 'ok', kinopoiskQuota: { used: 5, limit: 5 } }, now);
        assert.match(to(1)[0].text, /лимит Кинопоиска исчерпан[\s\S]*5 из 5/);
        await watch.serviceSeen('kinopoisk', { kinopoisk: null }, now);
        assert.match(to(1)[1].text, /Лимит Кинопоиска снова доступен/);
    });
});

describe('rules in the panel', () => {
    test("the page's choices are the server's: a value the server refuses can't be picked", () => {
        const html = fs.readFileSync(path.join(__dirname, '../../admin/index.html'), 'utf8');
        for (const [name, rule] of Object.entries(catalog.RULES)) {
            if (typeof rule.fallback === 'boolean') continue;
            const select = new RegExp(`<select[^>]*data-alert-rule="${name}"[^>]*>([^]*?)</select>`).exec(html);
            assert.ok(select, `select for ${name}`);
            const values = [...select[1].matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
            assert.deepEqual(values, rule.choices.map(String), name);
        }
    });
});

describe("the panel's API", () => {
    let base;
    let server;
    before(async () => {
        const app = express();
        app.use(express.json());
        app.use(require('../../src/admin/routes/alerts'));
        await new Promise((resolve) => {
            server = app.listen(0, resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => server.close());

    const call = (method, url, body) =>
        fetch(`${base}${url}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        }).then(async (res) => ({ status: res.status, body: await res.json() }));

    test('a rule outside its choices is refused, .env untouched', async () => {
        const env = () => (fs.existsSync(process.env.ENV_FILE) ? fs.readFileSync(process.env.ENV_FILE, 'utf8') : null);
        const before = env();
        const good = { downMinutes: 10, sendShare: 'half', repeatHours: 6, fixed: true };
        for (const bad of [{ downMinutes: 7 }, { sendShare: 'most' }, { repeatHours: 2 }, { fixed: 'on' }]) {
            const res = await call('PUT', '/api/alerts/rules', { ...good, ...bad });
            assert.equal(res.status, 400, JSON.stringify(bad));
        }
        assert.equal(env(), before);
    });

    test('a test to a chat that is no longer a recipient: 404, nothing sent', async () => {
        mock.method(AlertRecipient, 'findByPk', async () => null);
        const res = await call('POST', '/api/alerts/test', { chatId: '1' });
        assert.equal(res.status, 404);
        assert.equal(bot.sent.length, 0);
    });

    test('an unknown preset or event, or custom without its events: 400 before the database', async () => {
        const findByPk = mock.method(AlertRecipient, 'findByPk', async () => null);
        assert.equal((await call('PUT', '/api/alerts/recipients/1', { preset: 'some' })).status, 400);
        assert.equal(
            (await call('PUT', '/api/alerts/recipients/1', { preset: 'custom', events: ['nope'] })).status,
            400
        );
        assert.equal((await call('PUT', '/api/alerts/recipients/1', { preset: 'custom' })).status, 400);
        assert.equal((await call('PUT', '/api/alerts/recipients/abc', { preset: 'all' })).status, 400);
        assert.equal(findByPk.mock.callCount(), 0);
    });

    test('a recipient the bot lost moments ago (not written yet) shows as lost, not "active"', async () => {
        rows = [recipient(77, 'all')];
        chats = [person(77, { bot_status: 'active' })];
        mock.method(AlertRecipient, 'findAll', async () => rows);
        mock.method(AlertLog, 'findAll', async () => []);
        const status = require('../../src/bot-status');
        status.noteTelegram(77, 'stopped', { detail: 'stopped' });
        try {
            const res = await call('GET', '/api/alerts');
            assert.equal(res.body.recipients[0].unreachable, 'left');
        } finally {
            status.noteTelegram(77, 'active', { detail: 'returned' });
        }
    });

    test('a chat the bot has lost or never knew is not added', async () => {
        const create = mock.method(AlertRecipient, 'findOrCreate', async () => [{}, true]);
        mock.method(Chat, 'findByPk', async (id) => (id === '5' ? person(5, { bot_status: 'removed' }) : null));
        assert.equal((await call('POST', '/api/alerts/recipients', { chatId: '5' })).status, 400);
        assert.equal((await call('POST', '/api/alerts/recipients', { chatId: '6' })).status, 404);
        assert.equal(create.mock.callCount(), 0);
    });
});
