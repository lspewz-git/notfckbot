/**
 * The update check's sending: each notification through deliver() (retries included), and what
 * still didn't go out kept in PendingMessage for the next check, which sends it first.
 */
const { PendingMessage, HeldNotification, Chat } = require('../db');
const { deliver } = require('../delivery');
const { isQuietNow } = require('../quiet');
const stats = require('../stats-log');
const { recordFailure } = require('../send-failures');
const events = require('../chat-events');
const { isLeft } = require('../bot-status');
const { tally, noteFailure } = require('./status');
const { UPDATE_INTERVAL_HOURS } = require('../constants');
const { log } = require('../log');

// A day of checks, however often they run, or two days on the calendar: past that the news is stale
const MAX_ATTEMPTS = Math.ceil(24 / UPDATE_INTERVAL_HOURS);
const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

// Set once a send fails for want of Telegram or the network (not a chat's own problem, which
// deliver() reports as gone or rejected). For the rest of the check every message goes straight
// to the queue: no waiting through three tries per message for a Telegram that isn't there, and
// no newer message slipping out ahead of an older queued one. Each check starts afresh.
let unreachable = false;
// Sends that failed this check while Telegram itself answered: that message's trouble (a poster
// it can't fetch), so the next one still goes. The MAX_LONE-th such failure says the sends
// themselves are stuck (a proxy that lets getMe through), and each would cost its 90 s of tries:
// the rest go to the queue
let lone = 0;
const MAX_LONE = 2;
// Each chat's settings, read once per check: a chat with ten new episodes is one query
let chats = new Map();

async function chatSettings(chatId) {
    if (!chats.has(String(chatId)))
        chats.set(
            String(chatId),
            Chat.findByPk(chatId).catch(() => null)
        );
    return chats.get(String(chatId));
}
const QUEUED = { status: 'failed', error: 'Telegram was unreachable earlier in this check' };
// How long Telegram may take to say it is there, after a send failed
const PROBE_MS = 5000;

/**
 * Whether Telegram itself answers: a send that failed while it does was that message's trouble
 * (a poster it can't fetch), not Telegram's, so the rest of the check still goes out. On 29.10 one
 * queued message timing out marked every check of the day unreachable.
 */
async function telegramAnswers(bot) {
    try {
        await bot.telegram.callApi('getMe', {}, { signal: AbortSignal.timeout(PROBE_MS) });
        return true;
    } catch {
        return false;
    }
}

/** After a send failed: true when the rest of the check should wait for the next one. */
async function stopSending(bot, result) {
    // A long flood wait is Telegram's word to stop for everyone
    if (result.retryAfter || lone + 1 >= MAX_LONE || !(await telegramAnswers(bot))) return true;
    lone += 1;
    return false;
}

const clip = (text, n) => (text ? String(text).slice(0, n) : null);

/**
 * Sends one notification; a temporary failure is queued for the next check. In the chat's quiet
 * hours it is held instead, for the list that goes out when they end (src/cron/held.js).
 * Returns deliver()'s outcome, held, or left for a chat the bot has lost (not tried).
 * @param {{ photo?: string | null, about?: string, line?: string, label?: string, event?: object | null }} [options]
 *   about: the title, for the log and the dashboard's list of what didn't go out; line and label: its line and button in that list; event: what it
 *   was, for the chat's statistics (src/chat-events.js: detail, tmdb_id, title, season, episode)
 */
async function notify(bot, chatId, text, { photo = null, about = '', line = '', label = '', event = null } = {}) {
    // A chat that blocked the bot or took it out (src/bot-status.js) isn't tried: it would only
    // fail. Its subscriptions stay, and news goes out again once it is back
    if (isLeft(await chatSettings(chatId))) return { status: 'left' };
    const result = await send(bot, chatId, text, { photo, about, line, label });
    if (event) events.record(chatId, { kind: 'notified', ...event, outcome: outcomeOf(result) });
    return result;
}

/** sent, held, queued (for the next check) or failed (for good). */
function outcomeOf(result) {
    if (result.status === 'sent' || result.status === 'held') return result.status;
    return result.status === 'failed' ? 'queued' : 'failed';
}

async function send(bot, chatId, text, { photo, about, line, label }) {
    if (line && isQuietNow(await chatSettings(chatId))) {
        try {
            await HeldNotification.create({ chatId, line, label: label || about || 'Уведомление', text, photo });
            return { status: 'held' };
        } catch (err) {
            // Better at night than never
            log.error(`[Cron] Couldn't hold a notification for chat ${chatId}, sending it now: ${err.message}`);
        }
    }
    const result = unreachable ? QUEUED : await deliver(bot, chatId, text, { photo });
    if (result !== QUEUED && result.status === 'failed') unreachable = await stopSending(bot, result);
    // Where it went: a group that became a supergroup on the way has its new id
    const to = result.chatId || chatId;
    if (result.status === 'sent') {
        tally('sent');
        stats.count('sent');
        return result;
    }
    tally('failed');
    // A chat that blocked the bot is no sign of trouble for the alert; the queued rest say only
    // that Telegram failed earlier: the alert quotes the real error
    if (result.status === 'gone') tally('gone');
    else if (result !== QUEUED) noteFailure(result.error);
    const what = about ? ` about "${about}"` : '';
    // The day counts take a failure once it is final: a queued message may still go out
    if (result.status !== 'failed') {
        recordFailure({ chatId: to, about, status: result.status, error: result.error });
        log.error(`[Cron] Chat ${chatId} not notified${what} (${result.status}): ${result.error}`);
        return result;
    }
    try {
        // Cut to the columns' size: a longer value would fail the insert and lose the message
        await PendingMessage.create({
            chatId: to,
            text,
            photo,
            about: clip(about, 255),
            error: clip(result.error, 500)
        });
        log.error(`[Cron] Chat ${chatId} not notified${what}: ${result.error}. Will retry on the next check`);
    } catch (err) {
        recordFailure({ chatId: to, about, status: 'not_queued', error: `${result.error}; ${err.message}` });
        log.error(`[Cron] Chat ${chatId} not notified${what}: ${result.error}; queueing failed: ${err.message}`);
    }
    return result;
}

/** Starts a check: sends what earlier checks couldn't, oldest first, before the check's own news. */
async function flushPending(bot, now = new Date()) {
    unreachable = false;
    lone = 0;
    chats = new Map();
    const pending = await PendingMessage.findAll({ order: [['id', 'ASC']] });
    if (!pending.length) return;
    let sent = 0;
    for (const message of pending) {
        const age = now.getTime() - new Date(message.createdAt).getTime();
        if (message.attempts >= MAX_ATTEMPTS || age > MAX_AGE_MS) {
            // Out of tries, or stale news (it waited out quiet hours or outages untried)
            const status = message.attempts >= MAX_ATTEMPTS ? 'gave_up' : 'too_old';
            log.error(`[Cron] Gave up on a message to chat ${message.chatId} after ${message.attempts} retries`);
            recordFailure(
                {
                    chatId: message.chatId,
                    about: message.about,
                    status,
                    error: message.error,
                    tries: message.attempts,
                    since: message.createdAt
                },
                now
            );
            await message.destroy();
            continue;
        }
        // Telegram down: the rest wait for the next check, untried (their age still runs out)
        if (unreachable) break;
        const chat = await chatSettings(message.chatId);
        // Lost to a chat that blocked the bot meanwhile, as a new one would be
        if (isLeft(chat)) {
            recordFailure(
                {
                    chatId: message.chatId,
                    about: message.about,
                    status: 'gone',
                    error: 'The chat blocked or removed the bot while it waited',
                    tries: message.attempts,
                    since: message.createdAt
                },
                now
            );
            await message.destroy();
            continue;
        }
        // A retry is still a notification: not in the chat's quiet hours; a later check sends it
        if (isQuietNow(chat, now)) continue;
        // A retry after a failed one goes as text: the poster may be why it failed (each poster try
        // that gets no answer costs 30 s)
        const photo = message.attempts ? null : message.photo;
        const result = await deliver(bot, message.chatId, message.text, { photo });
        if (result.status === 'failed') {
            unreachable = await stopSending(bot, result);
            await message.update({ attempts: message.attempts + 1, error: clip(result.error, 500) });
            continue;
        }
        if (result.status === 'sent') {
            tally('sent');
            stats.count('sent');
            sent += 1;
        } else {
            recordFailure(
                {
                    chatId: result.chatId || message.chatId,
                    about: message.about,
                    status: result.status,
                    error: result.error,
                    tries: message.attempts,
                    since: message.createdAt
                },
                now
            );
            log.error(`[Cron] Queued message to chat ${message.chatId} dropped (${result.status}): ${result.error}`);
        }
        await message.destroy();
    }
    log.info(`[Cron] Queued messages: ${sent} of ${pending.length} sent`);
}

module.exports = { notify, flushPending, MAX_ATTEMPTS };
