/**
 * Alerts to the people who run the bot: a message to each recipient (Settings → Alerts) when
 * something breaks, again while it stays broken (ALERT_REPEAT_HOURS), and when it is fixed
 * (ALERT_FIXED). Each recipient hears only the events it chose (catalog.js). Quiet hours don't
 * apply; a chat that blocked the bot or took it out is skipped, like any broadcast.
 *
 * Two shapes of event. A condition (a service down, checks failing) is raised on every look
 * while it holds and resolved once it doesn't: raise() sends the first time and then only each
 * repeat; resolve() sends "fixed" if an alert went out. A one-off (a restart, a recap that
 * didn't arrive) goes through once(), at most once an hour per event.
 * The state is in memory: after a restart a condition that still holds is alerted again.
 */
const { Op } = require('sequelize');
const { AlertRecipient, AlertLog, Chat } = require('../db');
const { deliver } = require('../delivery');
const { isLeft } = require('../bot-status');
const { zoneOf } = require('../quiet');
const catalog = require('./catalog');
const { log } = require('../log');

const HOUR_MS = 60 * 60 * 1000;
const ONCE_GAP_MS = HOUR_MS;
const LOG_DAYS = 7;

let bot = null;
// event key -> { since, sentAt, delivered, sending } for a condition that holds now; sending:
// the alert still going out
let active = {};
// event key (with its id) -> when once() last sent it
let lastOnce = {};

/** The bot the alerts go out through; set once at start (src/index.js), and by tests. */
function useBot(instance) {
    bot = instance;
}

/** Forgets every condition and one-off: for tests. */
function reset() {
    active = {};
    lastOnce = {};
}

/**
 * "14:20" in a chat's time zone (the container's clock is UTC).
 * @returns {(date: Date | string | number) => string}
 */
function clockIn(zoneId) {
    const format = new Intl.DateTimeFormat('ru-RU', {
        timeZone: zoneOf(zoneId).id,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    });
    return (date) => format.format(new Date(date));
}

/** "12 с", "35 мин", "2 ч 10 мин". */
function duration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} с`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} мин`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h} ч ${m % 60} мин` : `${h} ч`;
}

/**
 * Sends a message to every recipient who wants this event (all of them for a test) and logs it.
 * @param {string} key event key
 * @param {'alert' | 'fixed' | 'test'} kind
 * @param {(time: (date: any) => string, row: any) => string} text HTML, given a clock in the recipient's
 *   zone and the recipient's row
 * @param {{ only?: string | number }} [options] only: one recipient's chat id (a test to one person)
 * @returns {Promise<{ sent: number, failed: number, wanted: number, unreachable: number }>} wanted:
 *   recipients who want it; unreachable: of the failed, chats the bot has lost (no request made)
 */
async function send(key, kind, text, { only } = {}) {
    const where = only === undefined ? {} : { chatId: String(only) };
    const rows = (await AlertRecipient.findAll({ where })).filter((r) => kind === 'test' || catalog.wants(r, key));
    if (!rows.length || !bot) return { sent: 0, failed: 0, wanted: rows.length, unreachable: 0 };
    const chats = await Chat.findAll({ where: { id: rows.map((r) => r.chatId) } });
    const byId = new Map(chats.map((c) => [String(c.id), c]));
    const names = [];
    let failed = 0;
    let unreachable = 0;
    for (const row of rows) {
        const chat = byId.get(String(row.chatId));
        if (!chat || isLeft(chat)) {
            failed += 1;
            unreachable += 1;
            continue;
        }
        const result = await deliver(bot, row.chatId, text(clockIn(chat.timezone), row));
        if (result.status === 'sent') {
            names.push(chat.username || String(chat.id));
            await row.update({ last_alert_at: new Date() }).catch(() => {});
        } else {
            failed += 1;
            log.error(`[Alerts] ${key} to chat ${row.chatId} not sent (${result.status}): ${result.error}`);
        }
    }
    const sent = names.length;
    log.info(`[Alerts] ${kind} ${key}: sent to ${sent}${failed ? `, ${failed} not reached` : ''}`);
    await AlertLog.create({ event: key, kind, sent, failed, sentTo: sent === 1 ? names[0].slice(0, 255) : null }).catch(
        (err) => log.error(`[Alerts] Couldn't log ${key}: ${err.message}`)
    );
    return { sent, failed, wanted: rows.length, unreachable };
}

/**
 * A condition holds now. The first call sends, later ones only once the repeat time has passed.
 * @param {string} key
 * @param {(time: (date: any) => string, since: Date) => string} text
 * @param {{ since?: Date, now?: Date, unsendable?: boolean }} [options] since: when it started (else
 *   now); unsendable: the alert can't go out (Telegram is what's down), so it's only marked as due,
 *   and resolve() will say what happened
 */
async function raise(key, text, { since, now = new Date(), unsendable = false } = {}) {
    const state = active[key] || (active[key] = { since: since || now, sentAt: null, delivered: false });
    const repeatMs = catalog.ruleValue('repeatHours') * HOUR_MS;
    if (state.sentAt && (!repeatMs || now.getTime() - state.sentAt.getTime() < repeatMs)) return;
    state.sentAt = now;
    if (unsendable) return;
    state.sending = send(key, 'alert', (time) => text(time, state.since));
    try {
        const { sent, wanted } = await state.sending;
        state.delivered = state.delivered || sent > 0;
        // Nobody wants it yet: still due, so whoever turns it on hears at the next look, not hours later
        if (!wanted) state.sentAt = null;
    } catch (err) {
        // Not sent at all (the database): due again at the next look
        state.sentAt = null;
        log.error(`[Alerts] ${key} failed: ${err.message}`);
    } finally {
        state.sending = null;
    }
}

/**
 * The condition no longer holds. Says so when an alert was due for it, and when "fixed" messages
 * are on, or when the alert itself never got out (then this is the only word of it).
 * @param {string} key
 * @param {(time: (date: any) => string, since: Date, now: Date) => string} text
 */
async function resolve(key, text, { now = new Date() } = {}) {
    const state = active[key];
    if (!state) return;
    delete active[key];
    // An alert still going out (Telegram's retries) decides whether "fixed" is news
    if (state.sending) await state.sending.catch(() => {});
    if (!state.sentAt || (state.delivered && !catalog.ruleValue('fixed'))) return;
    try {
        await send(key, 'fixed', (time) => text(time, state.since, now));
    } catch (err) {
        log.error(`[Alerts] ${key} (fixed) failed: ${err.message}`);
    }
}

/**
 * A one-off event; the same one again within the hour is left out. One that reached nobody who
 * wanted it isn't counted, so the next one goes out.
 * @param {{ now?: Date, id?: string | number }} [options] id: what it is about (a chat), when the
 *   same event about another one is news of its own
 * @returns {Promise<{ sent: number, failed: number, wanted: number, unreachable: number } | null>} null:
 *   left out or not sent
 */
async function once(key, text, { now = new Date(), id } = {}) {
    const slot = id === undefined ? key : `${key}:${id}`;
    if (lastOnce[slot] && now.getTime() - lastOnce[slot] < ONCE_GAP_MS) return null;
    lastOnce[slot] = now.getTime();
    try {
        const result = await send(key, 'alert', (time) => text(time));
        if (result.wanted && !result.sent) delete lastOnce[slot];
        return result;
    } catch (err) {
        delete lastOnce[slot];
        log.error(`[Alerts] ${key} failed: ${err.message}`);
        return null;
    }
}

/** Whether this event reached someone within the hour: a check that survives a restart. */
async function sentLately(key, now = new Date()) {
    const row = await AlertLog.findOne({
        where: {
            event: key,
            kind: 'alert',
            sent: { [Op.gt]: 0 },
            createdAt: { [Op.gte]: new Date(now.getTime() - ONCE_GAP_MS) }
        }
    });
    return Boolean(row);
}

const PRESET_RU = { all: 'все оповещения', critical: 'только критичные', custom: 'выбранные в панели' };

/** A test message, to one recipient or to all of them. */
function sendTest(chatId) {
    return send(
        'test',
        'test',
        (_time, row) =>
            '🧪 <b>Пробное оповещение</b>\nТак бот будет писать, когда что-то сломается и когда починится. ' +
            `Вам приходят: ${PRESET_RU[row.preset] || PRESET_RU.critical}.`,
        chatId === undefined ? {} : { only: chatId }
    );
}

/** Since when the log is kept: the panel shows that much. */
const logSince = (now = new Date()) => new Date(now.getTime() - LOG_DAYS * 24 * HOUR_MS);

/** Drops log rows older than a week. */
async function sweepLog(now = new Date()) {
    return AlertLog.destroy({ where: { createdAt: { [Op.lt]: logSince(now) } } });
}

module.exports = { useBot, reset, raise, resolve, once, sentLately, sendTest, sweepLog, logSince, duration };
