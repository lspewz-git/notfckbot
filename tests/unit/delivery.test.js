/**
 * Sending notifications reliably: a short failure is retried, a flood limit is waited out, a
 * poster Telegram can't use falls back to text (src/delivery.js), and what still doesn't go out
 * waits for the next update check (src/cron/outbox.js).
 * Run: npm run test:unit
 */
const { test, describe, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// The run's status file (src/cron/status.js) in a temporary place, not the project's
process.env.CRON_STATUS_FILE = require('path').join(require('os').tmpdir(), `delivery-test-${process.pid}.json`);
const { PendingMessage, Chat } = require('../../src/db');
const { deliver } = require('../../src/delivery');
const { notify, flushPending, MAX_ATTEMPTS } = require('../../src/cron/outbox');
const { notifyNewEpisodes } = require('../../src/cron');
const runStatus = require('../../src/cron/status');
const { fakeSeries, ep, tmdbSeries } = require('./fakes');

// A chat's settings (quiet hours) come from the database: none here, so none set
mock.method(Chat, 'findByPk', async () => null);

/** A Telegram error as Telegraf throws it. */
const telegramError = (code, description, parameters) =>
    Object.assign(new Error(`${code}: ${description}`), {
        description,
        response: { error_code: code, description, parameters }
    });
const networkError = () => Object.assign(new Error('connect ETIMEDOUT 149.154.167.220:443'), { code: 'ETIMEDOUT' });

/**
 * A bot whose sends answer from a script: each call takes the next outcome (an error to throw,
 * or nothing for success); once the script runs out, every send succeeds.
 */
function scriptedBot(script = []) {
    const calls = [];
    const send = (kind) => async (chatId, payload, opts) => {
        calls.push({ kind, chatId, text: kind === 'photo' ? opts.caption : payload });
        const outcome = script.shift();
        if (outcome) throw outcome;
    };
    return { calls, telegram: { sendMessage: send('text'), sendPhoto: send('photo') } };
}

/** With mocked timers: lets the sends run and skips each pause between tries. */
async function runPauses() {
    for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 50; j++) await Promise.resolve();
        mock.timers.tick(10000);
    }
}

let waits;
const wait = async (ms) => {
    waits.push(ms);
};

beforeEach(() => {
    waits = [];
});

describe('deliver', () => {
    test('a network hiccup is retried after a pause', async () => {
        const bot = scriptedBot([networkError()]);
        const result = await deliver(bot, 1, 'hi', { wait });
        assert.equal(result.status, 'sent');
        assert.equal(bot.calls.length, 2);
        assert.deepEqual(waits, [2000]);
    });

    test('a send that hangs counts as failed after 30 seconds and is tried again', async () => {
        let calls = 0;
        const bot = {
            telegram: {
                sendMessage: () => {
                    calls += 1;
                    // The first try never answers, the second does
                    return calls === 1 ? new Promise(() => {}) : Promise.resolve();
                }
            }
        };
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const sending = deliver(bot, 1, 'hi', { wait });
            await runPauses();
            assert.equal((await sending).status, 'sent');
        } finally {
            mock.timers.reset();
        }
        assert.equal(calls, 2);
    });

    test("Telegram's flood limit: waits as long as it asks, then sends", async () => {
        const bot = scriptedBot([telegramError(429, 'Too Many Requests: retry after 7', { retry_after: 7 })]);
        assert.equal((await deliver(bot, 1, 'hi', { wait })).status, 'sent');
        assert.deepEqual(waits, [7000]);
    });

    test('a flood wait too long to sit out, or three failures in a row: "failed", for a later try', async () => {
        const long = scriptedBot([telegramError(429, 'Too Many Requests', { retry_after: 600 })]);
        assert.equal((await deliver(long, 1, 'hi', { wait })).status, 'failed');
        assert.deepEqual(waits, [], 'no ten-minute pause in the middle of a check');

        const down = scriptedBot([networkError(), networkError(), networkError()]);
        const result = await deliver(down, 1, 'hi', { wait });
        assert.equal(result.status, 'failed');
        assert.match(result.error, /ETIMEDOUT/);
        assert.equal(down.calls.length, 3);
    });

    test('a chat that blocked or removed the bot: "gone" at once, no retries', async () => {
        const blocked = scriptedBot([telegramError(403, 'Forbidden: bot was blocked by the user')]);
        assert.equal((await deliver(blocked, 1, 'hi', { wait })).status, 'gone');
        const missing = scriptedBot([telegramError(400, 'Bad Request: chat not found')]);
        assert.equal((await deliver(missing, 1, 'hi', { wait })).status, 'gone');
        assert.equal(blocked.calls.length + missing.calls.length, 2);
    });

    test('a poster Telegram cannot fetch: the same text goes out without it', async () => {
        const bot = scriptedBot([telegramError(400, 'Bad Request: wrong file identifier/HTTP URL specified')]);
        const result = await deliver(bot, 1, '<b>New</b>', { photo: 'https://image.tmdb.org/x.jpg', wait });
        assert.equal(result.status, 'sent');
        assert.deepEqual(
            bot.calls.map((c) => `${c.kind}:${c.text}`),
            ['photo:<b>New</b>', 'text:<b>New</b>']
        );
    });

    test('a message Telegram refuses (bad markup) is not retried', async () => {
        const bot = scriptedBot([telegramError(400, "Bad Request: can't parse entities")]);
        assert.equal((await deliver(bot, 1, '<b>', { wait })).status, 'rejected');
        assert.equal(bot.calls.length, 1);
    });
});

describe('the outbox', () => {
    let queued;

    /** A queued row as Sequelize would return it. */
    const row = (fields) => ({
        attempts: 0,
        photo: null,
        createdAt: new Date(),
        destroyed: false,
        async destroy() {
            this.destroyed = true;
        },
        async update(changes) {
            Object.assign(this, changes);
        },
        ...fields
    });

    beforeEach(async () => {
        queued = [];
        mock.method(PendingMessage, 'create', async (fields) => queued.push(fields));
        // Each test starts like a new check: nothing queued, Telegram presumed reachable
        mock.method(PendingMessage, 'findAll', async () => []);
        await flushPending(scriptedBot());
    });

    /** notify() against a bot that never answers, skipping the pauses between its tries. */
    async function notifyWhileDown(bot, chatId, text, options) {
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const sending = notify(bot, chatId, text, options);
            await runPauses();
            return await sending;
        } finally {
            mock.timers.reset();
        }
    }

    test('a message that did not go out is queued; a blocked chat is not', async () => {
        // Real pauses would slow the test: the network fails at once on every try
        const down = scriptedBot([networkError(), networkError(), networkError()]);
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const sending = notify(down, 10, 'S2E4', { photo: 'p.jpg' });
            await runPauses();
            assert.equal((await sending).status, 'failed');
        } finally {
            mock.timers.reset();
        }
        assert.deepEqual(queued, [{ chatId: 10, text: 'S2E4', photo: 'p.jpg' }]);

        await flushPending(scriptedBot()); // the next check
        runStatus.beginRun();
        try {
            await notify(scriptedBot([telegramError(403, 'Forbidden: bot was blocked by the user')]), 11, 'x');
        } finally {
            runStatus.endRun(null);
        }
        assert.equal(queued.length, 1);
        // Failed, but the chat's own doing: the alert doesn't count it as Telegram's trouble
        const { lastRun } = runStatus.getCronStatus();
        assert.deepEqual([lastRun.failed, lastRun.gone, lastRun.reasons], [1, 1, {}]);
    });

    test("the next check sends the queue first; what still fails stays, counting tries; what's too old is dropped", async () => {
        const now = new Date('2026-10-13T21:00:00Z');
        const rows = [
            row({ id: 1, chatId: 10, text: 'old news', createdAt: new Date('2026-10-10T00:00:00Z') }),
            row({ id: 2, chatId: 11, text: 'tried enough', attempts: MAX_ATTEMPTS }),
            row({ id: 3, chatId: 12, text: 'S2E4', photo: 'p.jpg' }),
            row({ id: 4, chatId: 13, text: 'still down' })
        ];
        mock.method(PendingMessage, 'findAll', async () => rows);
        const sent = [];
        const bot = {
            telegram: {
                sendPhoto: async (chatId, photo, opts) => sent.push(`${chatId}:${opts.caption}`),
                sendMessage: async (chatId) => {
                    throw networkError(chatId);
                }
            }
        };
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const flushing = flushPending(bot, now);
            await runPauses();
            await flushing;
        } finally {
            mock.timers.reset();
        }

        assert.deepEqual(sent, ['12:S2E4']);
        assert.deepEqual(
            rows.map((r) => [r.id, r.destroyed, r.attempts]),
            [
                [1, true, 0],
                [2, true, MAX_ATTEMPTS],
                [3, true, 0],
                [4, false, 1]
            ]
        );
    });

    test('Telegram down: after the first failure the rest of the check queues without trying', async () => {
        const down = scriptedBot([networkError(), networkError(), networkError()]);
        // A run's counters: the alerts quote the error that stopped it (src/alerts/watch.js)
        runStatus.beginRun();
        try {
            await notifyWhileDown(down, 10, 'first');
            assert.equal(down.calls.length, 3);

            // The next one goes straight to the queue: no three more tries, no waiting
            const result = await notify(down, 11, 'second');
            assert.equal(result.status, 'failed');
            assert.equal(down.calls.length, 3);
        } finally {
            runStatus.endRun(null);
        }
        // Only the real error: the one queued untried says nothing new
        assert.deepEqual(runStatus.getCronStatus().lastRun.reasons, { 'connect ETIMEDOUT 149.154.167.220:443': 1 });
        assert.deepEqual(
            queued.map((q) => q.text),
            ['first', 'second']
        );

        // The next check tries again; queued messages stop at the first one Telegram doesn't take
        const rows = [10, 11, 12].map((chatId) => row({ id: chatId, chatId, text: `queued ${chatId}` }));
        mock.method(PendingMessage, 'findAll', async () => rows);
        const stillDown = scriptedBot([networkError(), networkError(), networkError()]);
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const flushing = flushPending(stillDown);
            await runPauses();
            await flushing;
        } finally {
            mock.timers.reset();
        }
        assert.equal(stillDown.calls.length, 3, 'only the first queued message was tried');
        assert.deepEqual(
            rows.map((r) => r.attempts),
            [1, 0, 0]
        );
    });

    test('an episode is recorded as announced even when a chat could not be reached: the message waits in the queue', async () => {
        const down = scriptedBot([networkError(), networkError(), networkError()]);
        const show = fakeSeries({ last_season: 2, last_episode: 3, completed_season: 1 }, [[10, 'episode']]);
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const checking = notifyNewEpisodes(down, show, tmdbSeries({ last: ep(2, 4), seasons: { 2: 8 } }));
            await runPauses();
            await checking;
        } finally {
            mock.timers.reset();
        }
        assert.equal(show.last_episode, 4, 'not announced twice on the next check');
        assert.equal(queued.length, 1);
        assert.match(queued[0].text, /Серия 4/);
    });
});
