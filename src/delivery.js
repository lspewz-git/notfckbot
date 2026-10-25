/**
 * Sends one message to one chat, the way every notification goes out: as a photo with a caption
 * when there is a poster (as text if Telegram can't use the poster), and again after a pause when
 * Telegram or the network fails for a moment. Used by the update check, the panel's test alerts,
 * broadcasts and messages.
 */
const { log } = require('./log');

// Telegram's flood limit asks to wait this many seconds at most; more would hold up the check
const MAX_FLOOD_WAIT_S = 60;
const TRIES = 3;
// Telegraf waits up to 500 s for an answer: a proxy that hangs would hold the update check for
// half an hour over three tries. Past this, a try counts as failed. (Telegram may still have got
// it, so a retry can duplicate a message: rarer, and less harm, than a check stuck that long.)
const TRY_TIMEOUT_MS = 30000;

/** The chat can't receive messages from the bot any more: blocked, kicked, deleted. */
const GONE =
    /chat not found|bot was blocked|bot was kicked|user is deactivated|group chat was (upgraded|deactivated)|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|PEER_ID_INVALID/i;

/**
 * What a failed send means.
 * @returns {{ kind: 'gone' | 'rejected' | 'flood' | 'temporary' | 'moved', retryAfter?: number, to?: string }}
 *   moved: the group became a supergroup, `to` its new id
 */
function classify(err) {
    const code = err && err.response ? err.response.error_code : undefined;
    const text = (err && (err.description || err.message)) || '';
    const to = err && err.response && err.response.parameters && err.response.parameters.migrate_to_chat_id;
    if (to) return { kind: 'moved', to: String(to) };
    if (code === 429) {
        const retryAfter = Number(err.response.parameters && err.response.parameters.retry_after) || 5;
        return { kind: 'flood', retryAfter };
    }
    if (code === 403 || (code !== undefined && GONE.test(text))) return { kind: 'gone' };
    // Telegram refused this very message (bad markup, a poster it can't fetch): sending it
    // again won't help
    if (typeof code === 'number' && code >= 400 && code < 500) return { kind: 'rejected' };
    // No answer, a reset connection, a 5xx: worth another try
    return { kind: 'temporary' };
}

async function sendOnce(bot, chatId, text, photo, extra) {
    if (photo) {
        try {
            return await bot.telegram.sendPhoto(chatId, photo, { caption: text, parse_mode: 'HTML', ...extra });
        } catch (err) {
            // Only a poster problem falls back to text; a blocked chat or a timeout stays an error
            if (classify(err).kind !== 'rejected') throw err;
            log.error(`[Delivery] Poster refused for chat ${chatId} (${err.message}); sending text`);
        }
    }
    return bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The send, or a timeout error once it has taken too long. */
function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        // Marked: Telegram may still have got it (see deliverAlbum)
        const err = Object.assign(new Error(`No answer from Telegram in ${ms / 1000} s`), { noAnswer: true });
        timer = setTimeout(() => reject(err), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} bot Telegraf instance
 * @param {number | string} chatId
 * @param {string} text HTML
 * @param {{ photo?: string | null, extra?: object, wait?: (ms: number) => Promise<void> }} [options]
 *   extra: more of Telegram's send options, e.g. a keyboard (Markup.inlineKeyboard(…))
 * @returns {Promise<{ status: 'sent' | 'gone' | 'rejected' | 'failed', error?: string }>}
 *   gone: the chat is unreachable; rejected: Telegram refused the message; failed: Telegram or
 *   the network didn't answer after a few tries, so a later attempt may still work
 */
async function deliver(bot, chatId, text, { photo = null, extra = {}, wait = sleep } = {}) {
    return followingMove(chatId, (id) => withRetries(() => sendOnce(bot, id, text, photo, extra), wait));
}

/**
 * A send to a group that became a supergroup the bot didn't hear about: its data moves to the new
 * id (src/chat-migration.js) and the send goes there, once.
 */
async function followingMove(chatId, send) {
    const result = await send(chatId);
    if (result.status !== 'moved') return noted(chatId, result);
    try {
        await require('./chat-migration').migrateChat(chatId, result.to);
    } catch (err) {
        log.error(`[Delivery] Moving group ${chatId} to supergroup ${result.to} failed: ${err.message}`);
    }
    const again = await send(result.to);
    return again.status === 'moved' ? { status: 'gone', error: again.error } : noted(result.to, again);
}

/** A chat that blocked the bot or took it out is marked so (src/bot-status.js): later sends skip it. */
function noted(chatId, result) {
    if (result.status === 'gone') require('./bot-status').noteSendFailed(chatId, result.error);
    return result;
}

/**
 * Several pictures as one message, an album (the year's recap): the caption, HTML, goes under the
 * first. Retried like deliver(), except after no answer at all: the album may have arrived, and a
 * once-a-year message twice is worse than once missing. No fallback to text either.
 * @param {object} bot Telegraf instance
 * @param {number | string} chatId
 * @param {Buffer[]} images PNG, 2 to 10
 * @param {string} caption HTML
 * @param {{ wait?: (ms: number) => Promise<void>, timeout?: number }} [options] timeout: ms a try may take
 * @returns {Promise<{ status: 'sent' | 'gone' | 'rejected' | 'failed', error?: string, uncertain?: boolean }>}
 *   as deliver(); uncertain: Telegram never answered, so it may have been sent
 */
// Pictures take longer to upload than a message: twice the time a try may take
async function deliverAlbum(bot, chatId, images, caption, { wait = sleep, timeout = TRY_TIMEOUT_MS * 2 } = {}) {
    const media = images.map((image, i) => ({
        type: 'photo',
        media: { source: image },
        ...(i === 0 ? { caption, parse_mode: 'HTML' } : {})
    }));
    return followingMove(chatId, (id) =>
        withRetries(() => bot.telegram.sendMediaGroup(id, media), wait, timeout, { retryNoAnswer: false })
    );
}

/** One send, tried again after a short failure or a flood wait; the outcome as deliver() gives it. */
async function withRetries(send, wait, timeout = TRY_TIMEOUT_MS, { retryNoAnswer = true } = {}) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            await withTimeout(send(), timeout);
            return { status: 'sent' };
        } catch (err) {
            if (err.noAnswer && !retryNoAnswer) return { status: 'failed', error: err.message, uncertain: true };
            const { kind, retryAfter, to } = classify(err);
            if (kind === 'moved') return { status: 'moved', to, error: err.message };
            if (kind === 'gone' || kind === 'rejected') return { status: kind, error: err.message };
            // A long flood wait: the caller is told how long, to hold off rather than try the next chat
            if (kind === 'flood' && retryAfter > MAX_FLOOD_WAIT_S) {
                return { status: 'failed', error: err.message, retryAfter };
            }
            if (attempt >= TRIES) return { status: 'failed', error: err.message };
            await wait(kind === 'flood' ? retryAfter * 1000 : attempt * 2000);
        }
    }
}

module.exports = { deliver, deliverAlbum, classify };
