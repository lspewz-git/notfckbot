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
 * @returns {{ kind: 'gone' | 'rejected' | 'flood' | 'temporary', retryAfter?: number }}
 */
function classify(err) {
    const code = err && err.response ? err.response.error_code : undefined;
    const text = (err && (err.description || err.message)) || '';
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
        timer = setTimeout(() => reject(new Error(`No answer from Telegram in ${ms / 1000} s`)), ms);
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
    for (let attempt = 1; ; attempt += 1) {
        try {
            await withTimeout(sendOnce(bot, chatId, text, photo, extra), TRY_TIMEOUT_MS);
            return { status: 'sent' };
        } catch (err) {
            const { kind, retryAfter } = classify(err);
            if (kind === 'gone' || kind === 'rejected') return { status: kind, error: err.message };
            if (attempt >= TRIES || (kind === 'flood' && retryAfter > MAX_FLOOD_WAIT_S)) {
                return { status: 'failed', error: err.message };
            }
            await wait(kind === 'flood' ? retryAfter * 1000 : attempt * 2000);
        }
    }
}

module.exports = { deliver, classify };
