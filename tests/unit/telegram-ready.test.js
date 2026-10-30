/**
 * The start with Telegram out of reach (src/telegram-ready.js): tried again until it answers, no
 * exit, each try cut short, a refused token said as such. Run: npm run test:unit
 */
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { log } = require('../../src/log');
const { waitForTelegram, telegramReady, isTelegramReady } = require('../../src/telegram-ready');

/** A bot whose callApi answers by method, from the given functions; calls are recorded. */
function fakeBot(answers) {
    const calls = [];
    const payloads = [];
    return {
        calls,
        payloads,
        telegram: {
            callApi: async (method, payload, options) => {
                calls.push(method);
                payloads.push(payload);
                return answers[method](options);
            }
        }
    };
}

/** What Telegraf's fetch rejects with when the signal fires. */
const aborted = () => Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });

const telegramError = (code, description) =>
    Object.assign(new Error(`${code}: ${description}`), { response: { error_code: code, description } });

// waitForTelegram never gives up: a broken success path must fail the test, not hang the run
const LIMIT = { timeout: 3000 };

test('Telegram out of reach: tried again until it answers, then the webhook goes', LIMIT, async () => {
    let down = 3;
    const bot = fakeBot({
        getMe: async () => {
            if (down-- > 0) throw new Error('connect ETIMEDOUT 149.154.166.110:443');
            return { id: 1, username: 'notfckbot' };
        },
        deleteWebhook: async () => true
    });
    assert.equal(isTelegramReady(), false);
    const info = await waitForTelegram(bot, { pause: 0 });
    assert.equal(info.username, 'notfckbot');
    assert.deepEqual(bot.calls, ['getMe', 'getMe', 'getMe', 'getMe', 'deleteWebhook']);
    // A relaunch keeps the updates queued meanwhile
    assert.deepEqual(bot.payloads.at(-1), {});
    // What waits for Telegram may go now
    assert.equal(isTelegramReady(), true);
    await telegramReady;
});

test('a webhook that fails to go is tried again with the token', LIMIT, async () => {
    let failed = false;
    const bot = fakeBot({
        getMe: async () => ({ id: 1, username: 'notfckbot' }),
        deleteWebhook: async () => {
            if (!failed) {
                failed = true;
                throw new Error('socket hang up');
            }
            return true;
        }
    });
    await waitForTelegram(bot, { pause: 0, dropPending: true });
    assert.deepEqual(bot.calls, ['getMe', 'deleteWebhook', 'getMe', 'deleteWebhook']);
    // The start drops what came while the bot was down, as launch did
    assert.deepEqual(bot.payloads.at(-1), { drop_pending_updates: true });
});

test('a try that hangs is cut short, said as no answer, and tried again', LIMIT, async (t) => {
    const lines = [];
    t.after(() => mock.restoreAll());
    mock.method(log, 'error', (msg) => lines.push(msg));
    let tries = 0;
    const bot = fakeBot({
        // The first never answers on its own: only its deadline ends it
        getMe: (options) => {
            tries += 1;
            if (tries > 1) return Promise.resolve({ id: 1, username: 'notfckbot' });
            return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(aborted())));
        },
        deleteWebhook: async () => true
    });
    // AbortSignal.timeout's timer doesn't hold the process; the server does, the test needs this
    const hold = setInterval(() => {}, 1000);
    try {
        await waitForTelegram(bot, { pause: 0, tryMs: 20 });
    } finally {
        clearInterval(hold);
    }
    assert.equal(tries, 2);
    assert.match(lines[0], /Not reachable: no answer in 0\.02 s/);
});

test('a refused token is said as such, the token itself never; the log thins out', LIMIT, async (t) => {
    const lines = [];
    t.after(() => mock.restoreAll());
    mock.method(log, 'error', (msg) => lines.push(msg));
    let tries = 0;
    const bot = fakeBot({
        getMe: async () => {
            tries += 1;
            if (tries <= 12) throw telegramError(401, 'Unauthorized (bot123456:AAH-secret_token)');
            return { id: 1, username: 'notfckbot' };
        },
        deleteWebhook: async () => true
    });
    await waitForTelegram(bot, { pause: 0 });
    // Tries 1, 2, 3 and 10 of the twelve that failed
    assert.equal(lines.length, 4);
    assert.match(lines[0], /rejected the bot token.*set a new one in Settings/);
    assert.match(lines[3], /try 10\)/);
    for (const line of lines) assert.doesNotMatch(line, /AAH-secret_token/);
});
