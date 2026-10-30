/**
 * The bot's first word with Telegram at start: the token checked (getMe) and an old webhook
 * removed, tried again until Telegram answers. Telegram can be out of reach for hours (the
 * network, a block) and a token can be revoked; the panel doesn't need Telegram, so it starts
 * before this and the process never exits over it. What does need Telegram (polling, the update
 * check, the start alert, chat names) waits for `telegramReady`.
 */
const { setTimeout: sleep } = require('node:timers/promises');
const { log } = require('./log');

const PAUSE_MS = 30 * 1000;
// One try's deadline: Telegraf's own is 500 s, so a silent proxy would hold a try that long
const TRY_MS = 10 * 1000;
// The first tries are logged, then one in this many: a long outage doesn't flood the log
const LOG_FIRST = 3;
const LOG_EVERY = 10;

let ready = false;
let markReady;
/** Settles once, at Telegram's first answer: then the update check may send. */
const telegramReady = new Promise((resolve) => {
    markReady = resolve;
});
const isTelegramReady = () => ready;

/** Telegram's answer to a token it doesn't know (revoked, mistyped, empty): no network fixes it. */
const tokenRejected = (err) => [401, 404].includes(err && err.response && err.response.error_code);

/** The bot token out of a message: Telegraf hides it in network errors, not in every other one. */
const redact = (text) => String(text).replace(/bot\d+:[\w-]+/g, 'bot<token>');

/** Why a try failed, in words: an abort is our own deadline, not Telegram's answer. */
function reasonOf(err, tryMs) {
    if (tokenRejected(err)) {
        return `Telegram rejected the bot token (${redact(err.message)}): set a new one in Settings and restart`;
    }
    const what = err.name === 'AbortError' ? `no answer in ${tryMs / 1000} s` : redact(err.message);
    return `Not reachable: ${what}. The panel works`;
}

/**
 * @param {{ telegram: { callApi: (method: string, payload: object, options: object) => Promise<any> } }} bot
 * @param {{ pause?: number, tryMs?: number, dropPending?: boolean, quiet?: boolean }} [options]
 *   dropPending: the updates queued while the bot was down go with the webhook; quiet: no info lines
 * @returns {Promise<any>} getMe's answer
 */
async function waitForTelegram(bot, { pause = PAUSE_MS, tryMs = TRY_MS, dropPending = false, quiet = false } = {}) {
    if (!quiet) log.info('Verifying bot token...');
    for (let attempt = 1; ; attempt += 1) {
        try {
            const botInfo = await bot.telegram.callApi('getMe', {}, { signal: AbortSignal.timeout(tryMs) });
            await bot.telegram.callApi('deleteWebhook', dropPending ? { drop_pending_updates: true } : {}, {
                signal: AbortSignal.timeout(tryMs)
            });
            if (!quiet) log.info(`Bot verified: @${botInfo.username}`);
            ready = true;
            markReady();
            return botInfo;
        } catch (err) {
            if (attempt <= LOG_FIRST || attempt % LOG_EVERY === 0) {
                log.error(`[Telegram] ${reasonOf(err, tryMs)} (try ${attempt}); trying again every ${pause / 1000} s`);
            }
            await sleep(pause);
        }
    }
}

module.exports = { waitForTelegram, telegramReady, isTelegramReady };
