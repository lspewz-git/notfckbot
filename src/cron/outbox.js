/**
 * The update check's sending: each notification through deliver() (retries included), and what
 * still didn't go out kept in PendingMessage for the next check, which sends it first.
 */
const { PendingMessage } = require('../db');
const { deliver } = require('../delivery');
const { tally } = require('./status');

// A day of checks (every 3 hours), or two days on the calendar: past that the news is stale
const MAX_ATTEMPTS = 8;
const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

// Set once a send fails for want of Telegram or the network (not a chat's own problem, which
// deliver() reports as gone or rejected). For the rest of the check every message goes straight
// to the queue: no waiting through three tries per message for a Telegram that isn't there, and
// no newer message slipping out ahead of an older queued one. Each check starts afresh.
let unreachable = false;
const QUEUED = { status: 'failed', error: 'Telegram was unreachable earlier in this check' };

/**
 * Sends one notification; a temporary failure is queued for the next check.
 * @param {{ photo?: string | null, about?: string }} [options] about: for the log
 */
async function notify(bot, chatId, text, { photo = null, about = '' } = {}) {
    const result = unreachable ? QUEUED : await deliver(bot, chatId, text, { photo });
    if (result.status === 'failed') unreachable = true;
    if (result.status === 'sent') {
        tally('sent');
        return result;
    }
    tally('failed');
    const what = about ? ` about "${about}"` : '';
    if (result.status !== 'failed') {
        console.error(`[Cron] Chat ${chatId} not notified${what} (${result.status}): ${result.error}`);
        return result;
    }
    try {
        await PendingMessage.create({ chatId, text, photo });
        console.error(`[Cron] Chat ${chatId} not notified${what}: ${result.error}. Will retry on the next check`);
    } catch (err) {
        console.error(`[Cron] Chat ${chatId} not notified${what}: ${result.error}; queueing failed:`, err.message);
    }
    return result;
}

/** Starts a check: sends what earlier checks couldn't, oldest first, before the check's own news. */
async function flushPending(bot, now = new Date()) {
    unreachable = false;
    const pending = await PendingMessage.findAll({ order: [['id', 'ASC']] });
    if (!pending.length) return;
    let sent = 0;
    for (const message of pending) {
        const age = now.getTime() - new Date(message.createdAt).getTime();
        if (message.attempts >= MAX_ATTEMPTS || age > MAX_AGE_MS) {
            console.error(`[Cron] Gave up on a message to chat ${message.chatId} after ${message.attempts} retries`);
            await message.destroy();
            continue;
        }
        // Telegram down: the rest wait for the next check, untried (their age still runs out)
        if (unreachable) break;
        const result = await deliver(bot, message.chatId, message.text, { photo: message.photo });
        if (result.status === 'failed') {
            unreachable = true;
            await message.update({ attempts: message.attempts + 1 });
            continue;
        }
        if (result.status === 'sent') {
            tally('sent');
            sent += 1;
        } else {
            console.error(
                `[Cron] Queued message to chat ${message.chatId} dropped (${result.status}): ${result.error}`
            );
        }
        await message.destroy();
    }
    console.log(`[Cron] Queued messages: ${sent} of ${pending.length} sent`);
}

module.exports = { notify, flushPending, MAX_ATTEMPTS };
