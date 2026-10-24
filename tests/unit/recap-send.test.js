/**
 * Sending the year's recap (src/recap/send.js, src/admin/routes/recap.js): by hand, whatever the
 * Settings switch says; a chat gets its year once, quiet hours wait, Telegram's answers end up on
 * the row. The database, the cards and Telegram are stand-ins.
 * Run: npm run test:unit
 */
const { test, describe, mock, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const render = require('../../src/recap/render');
const STATS = { episodes: { count: 87, minutes: 4700 }, films: { released: [{}, {}], minutes: 1680 } };
mock.method(render, 'recapImages', async () => ({
    images: [1, 2, 3, 4, 5, 6].map((n) => Buffer.from([n])),
    stats: STATS
}));

const { Chat, Subscription, Watchlist, RecapSend } = require('../../src/db');
const recap = require('../../src/recap/send');

// Database stand-ins last one test: a test that forgets one reaches the real database (and
// waits 60 s for it) instead of quietly borrowing the one an earlier test left behind
const stubs = [];
const stub = (object, name, impl) => {
    const m = mock.method(object, name, impl);
    stubs.push(m);
    return m;
};
afterEach(() => {
    // Newest first: a stub over a stub gives back the one under it, then the real method
    for (const m of stubs.splice(0).reverse()) m.mock.restore();
});

/** Runs fn with RECAP_SCHEDULE set to each value the Settings switch can leave, then restores it. */
async function withEachSchedule(fn) {
    const saved = process.env.RECAP_SCHEDULE;
    try {
        for (const value of ['on', 'off', undefined]) {
            if (value === undefined) delete process.env.RECAP_SCHEDULE;
            else process.env.RECAP_SCHEDULE = value;
            await fn(value);
        }
    } finally {
        if (saved === undefined) delete process.env.RECAP_SCHEDULE;
        else process.env.RECAP_SCHEDULE = saved;
    }
}

/** A RecapSend row whose update() keeps the changes. */
function row(fields) {
    return {
        id: fields.chatId,
        attempts: 0,
        status: 'queued',
        ...fields,
        async update(changes) {
            Object.assign(this, changes);
        }
    };
}

/** A bot whose albums answer from a script: an error to throw, or nothing for success. */
function albumBot(script = []) {
    const sent = [];
    return {
        sent,
        telegram: {
            sendMediaGroup: async (chatId, media) => {
                sent.push({ chatId, media });
                const outcome = script.shift();
                if (outcome) throw outcome;
            }
        }
    };
}
const telegramError = (code, description) =>
    Object.assign(new Error(description), { description, response: { error_code: code, description } });

describe('the caption', () => {
    test('what came out, in Russian, with the year, then one playful line', () => {
        const first = () => 0;
        assert.equal(
            recap.caption(2026, STATS, first),
            '🎬 <b>Ваш 2026 в сериалах и фильмах</b>\n87 серий, 2 фильма и 106 часов премьер.\n\nЕсли смотреть всё подряд — это 4,4 суток без перерыва. Запасайтесь пледом.'
        );
        // Nothing to joke about: the heading alone
        const quiet = { episodes: { count: 0, minutes: 0 }, films: { released: [], minutes: 0 } };
        assert.equal(recap.caption(2026, quiet), '🎬 <b>Ваш 2026 в сериалах и фильмах</b>');
    });

    test('the jokes: only those the chat has figures for, none saying anything was watched', () => {
        const full = {
            episodes: { count: 87, minutes: 4700, busiestMonth: { month: '2026-09', count: 25 } },
            films: { released: [], minutes: 1680, longestWait: { title: 'Мы & <Они>', waited: 189 } }
        };
        assert.deepEqual(recap.jokes(full, 106), [
            'Если смотреть всё подряд — это 4,4 суток без перерыва. Запасайтесь пледом.',
            'Чтобы посмотреть всё, понадобится примерно 53 ведра попкорна 🍿',
            'Сентябрь выдался жарким: 25 новых серий. Надеемся, вы всё успели.',
            '«Мы &amp; &lt;Они&gt;» вы ждали 189 дней. Терпение — ваша суперсила.'
        ]);
        for (const line of recap.jokes(full, 106)) assert.doesNotMatch(line, /посмотрел|смотрели|просмотр/);
        // A whole number of days, a short wait, a quiet month: those lines change or stay out
        const small = {
            episodes: { count: 3, minutes: 0, busiestMonth: { month: '2026-01', count: 3 } },
            films: { released: [], minutes: 0, longestWait: { title: 'X', waited: 10 } }
        };
        assert.deepEqual(recap.jokes(small, 48), [
            'Если смотреть всё подряд — это 2 суток без перерыва. Запасайтесь пледом.',
            'Чтобы посмотреть всё, понадобится примерно 24 ведра попкорна 🍿'
        ]);
        assert.deepEqual(recap.jokes(small, 1), []);
    });

    test('the line is picked at random among those that fit', () => {
        const picks = new Set([0, 0.3, 0.6, 0.99].map((r) => recap.caption(2026, STATS, () => r).split('\n\n')[1]));
        assert.equal(picks.size, 2);
    });

    test('only this year and the last can be sent', () => {
        const now = new Date('2026-12-31T12:00:00Z');
        assert.equal(recap.sendableYear(2026, now), true);
        assert.equal(recap.sendableYear(2025, now), true);
        assert.equal(recap.sendableYear(2027, now), false);
        assert.equal(recap.sendableYear(2020, now), false);
    });
});

describe('the queue', () => {
    let rows;
    let chats;
    beforeEach(() => {
        chats = {
            1: { id: 1, username: 'one', quiet_start: null, quiet_end: null, timezone: 'Europe/Moscow' },
            2: { id: 2, username: 'two', quiet_start: null, quiet_end: null, timezone: 'Europe/Moscow' }
        };
        rows = [row({ chatId: 1, year: 2026 }), row({ chatId: 2, year: 2026 })];
        stub(Chat, 'findByPk', async (id) => chats[id] || null);
        stub(RecapSend, 'findAll', async () => rows.filter((r) => r.status === 'queued'));
        // The "taken" update: only a row still queued is taken
        stub(RecapSend, 'update', async (changes, { where }) => {
            if (!where.id) return [0];
            const target = rows.find((r) => r.id === where.id && r.status === where.status);
            if (!target) return [0];
            Object.assign(target, changes);
            return [1];
        });
    });

    test('the Settings switch (the schedule, in development) has no say: what was queued by hand goes', async () => {
        await withEachSchedule(async (value) => {
            for (const r of rows) r.status = 'queued';
            const bot = albumBot();
            await recap.processQueue(bot, { pause: 0 });
            assert.equal(bot.sent.length, 2, `RECAP_SCHEDULE=${value}`);
        });
    });

    test('each chat gets one album of six with the caption under the first; the row says sent', async () => {
        const bot = albumBot();
        await recap.processQueue(bot, { pause: 0 });
        assert.deepEqual(
            bot.sent.map((s) => s.chatId),
            [1, 2]
        );
        const media = bot.sent[0].media;
        assert.equal(media.length, 6);
        assert.match(media[0].caption, /Ваш 2026/);
        assert.equal(media[0].parse_mode, 'HTML');
        assert.equal(media[1].caption, undefined);
        assert.deepEqual(
            rows.map((r) => r.status),
            ['sent', 'sent']
        );
        assert.ok(rows[0].sentAt instanceof Date);

        // A second run finds nothing queued: nobody gets it twice
        await recap.processQueue(bot, { pause: 0 });
        assert.equal(bot.sent.length, 2);
    });

    test('a chat in its quiet hours waits in the queue; a blocked bot fails for good', async () => {
        // 03:30 in Moscow, inside its 01–08 quiet hours
        chats[1] = { ...chats[1], quiet_start: 1, quiet_end: 8 };
        const bot = albumBot([telegramError(403, 'Forbidden: bot was blocked by the user')]);
        await recap.processQueue(bot, { pause: 0, now: () => new Date('2026-12-31T00:30:00Z') });
        assert.deepEqual(
            bot.sent.map((s) => s.chatId),
            [2]
        );
        assert.equal(rows[0].status, 'queued');
        assert.equal(rows[1].status, 'failed');
        assert.match(rows[1].error, /blocked/);
    });

    test('Telegram down: back to the queue, failed after the third try', async () => {
        rows = [row({ chatId: 1, year: 2026 })];
        const down = () => Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
        for (let run = 1; run <= recap.MAX_ATTEMPTS; run += 1) {
            const bot = albumBot([down(), down(), down()]);
            await recap.processQueue(bot, { pause: 0, wait: async () => {} });
            assert.equal(rows[0].attempts, run);
            assert.equal(rows[0].status, run < recap.MAX_ATTEMPTS ? 'queued' : 'failed');
        }
    });

    test('no answer from Telegram: one try only, and the row says it may have arrived', async () => {
        rows = [row({ chatId: 1, year: 2026 })];
        let tries = 0;
        const silent = {
            telegram: {
                sendMediaGroup: () => {
                    tries += 1;
                    return new Promise(() => {});
                }
            }
        };
        await recap.processQueue(silent, { pause: 0, wait: async () => {}, timeout: 20 });
        assert.equal(tries, 1);
        assert.equal(rows[0].status, 'failed');
        assert.match(rows[0].error, /may have been sent/);
    });

    test('a chat queued while the queue runs goes in the same run, not ten minutes later', async () => {
        rows = [row({ chatId: 1, year: 2026 })];
        const bot = albumBot();
        const send = bot.telegram.sendMediaGroup;
        bot.telegram.sendMediaGroup = async (chatId, media) => {
            // The other button, pressed while chat 1 is being sent
            if (chatId === 1) rows.push(row({ chatId: 2, year: 2026 }));
            return send(chatId, media);
        };
        await recap.processQueue(bot, { pause: 0 });
        assert.deepEqual(
            bot.sent.map((s) => s.chatId),
            [1, 2]
        );
    });

    test('a row taken off the queue meanwhile (Stop) is not sent', async () => {
        // Stop happens between reading the queue and taking the row
        const queued = rows.slice();
        stub(RecapSend, 'findAll', async () => queued);
        rows[0].status = 'gone';
        const bot = albumBot();
        await recap.processQueue(bot, { pause: 0 });
        assert.deepEqual(
            bot.sent.map((s) => s.chatId),
            [2]
        );
    });
});

describe('who gets it', () => {
    test('only chats following something, not blocked, not sent or queued for that year', async () => {
        const future = new Date(Date.now() + 3600e3);
        stub(Chat, 'findAll', async () => [
            { id: 1 }, // follows, eligible
            { id: 2 }, // follows, sent
            { id: 3 }, // nothing followed
            { id: 4, blockedUntil: future }, // blocked
            { id: 5 }, // queued
            { id: 6 } // failed
        ]);
        stub(Subscription, 'findAll', async () => [{ chatId: 1 }, { chatId: 2 }, { chatId: 4 }]);
        stub(Watchlist, 'findAll', async () => [{ chatId: 5 }, { chatId: 6 }]);
        stub(RecapSend, 'findAll', async () => [
            { chatId: 2, status: 'sent' },
            { chatId: 5, status: 'queued' },
            { chatId: 6, status: 'failed' }
        ]);
        assert.deepEqual(await recap.audience(2026), {
            eligible: ['1'],
            sent: 1,
            queued: 1,
            failed: 1,
            nothing: 1,
            blocked: 1
        });
    });
});

describe('the API', () => {
    let base;
    let server;
    before(async () => {
        const app = express();
        app.use(express.json());
        app.set('bot', albumBot());
        app.use(require('../../src/admin/routes/recap'));
        await new Promise((resolve) => {
            server = app.listen(0, resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => server.close());

    const post = (path, body) =>
        fetch(`${base}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    const year = new Date().getFullYear();

    // Everything the routes and the queue they start in the background ask the database: one chat
    // following something, nothing sent yet. Each test changes only what it is about
    let created;
    beforeEach(() => {
        stub(Chat, 'findAll', async () => [{ id: 1 }]);
        stub(Chat, 'findByPk', async () => ({ id: 1 }));
        stub(Subscription, 'findAll', async () => [{ chatId: 1 }]);
        stub(Watchlist, 'findAll', async () => []);
        stub(RecapSend, 'findAll', async () => []);
        stub(RecapSend, 'findOne', async () => null);
        stub(RecapSend, 'update', async () => [0]);
        stub(RecapSend, 'count', async () => 0);
        created = stub(RecapSend, 'bulkCreate', async () => {});
    });

    test('whatever the schedule switch says, both buttons queue', async () => {
        await withEachSchedule(async (value) => {
            created.mock.resetCalls();
            assert.equal((await post('/api/recap/send', { year })).status, 200, `RECAP_SCHEDULE=${value}`);
            assert.equal((await post('/api/chat/1/recap/send', { year })).status, 200, `RECAP_SCHEDULE=${value}`);
            assert.deepEqual(
                created.mock.calls.map((c) => c.arguments[0]),
                [[{ chatId: '1', year }], [{ chatId: '1', year }]]
            );
        });
    });

    test('a year ahead or long past is refused', async () => {
        assert.equal((await post('/api/recap/send', { year: year + 1 })).status, 400);
        assert.equal((await post('/api/recap/send', { year: year - 5 })).status, 400);
    });

    test('one chat: refused when already sent or queued; a failed one may be tried again', async () => {
        stub(RecapSend, 'findOne', async () => ({ status: 'sent' }));
        const sent = await post('/api/chat/1/recap/send', { year });
        assert.equal(sent.status, 409);
        assert.match((await sent.json()).error, /Already sent/);
        assert.equal(created.mock.callCount(), 0);

        let destroyed = false;
        stub(RecapSend, 'findOne', async () => ({
            status: 'failed',
            destroy: async () => {
                destroyed = true;
            }
        }));
        assert.equal((await post('/api/chat/1/recap/send', { year })).status, 200);
        assert.equal(destroyed, true);
        assert.equal(created.mock.callCount(), 1);
    });

    test('"Send again": a sent chat goes once more when asked on purpose; a queued one never twice', async () => {
        let destroyed = false;
        stub(RecapSend, 'findOne', async () => ({
            status: 'sent',
            destroy: async () => {
                destroyed = true;
            }
        }));
        // Only a real true counts: "true" as a string is not asking on purpose
        assert.equal((await post('/api/chat/1/recap/send', { year, again: 'true' })).status, 409);
        assert.equal((await post('/api/chat/1/recap/send', { year, again: true })).status, 200);
        assert.equal(destroyed, true);
        assert.equal(created.mock.callCount(), 1);

        stub(RecapSend, 'findOne', async () => ({ status: 'queued' }));
        const queued = await post('/api/chat/1/recap/send', { year, again: true });
        assert.equal(queued.status, 409);
        assert.match((await queued.json()).error, /Already queued/);
        assert.equal(created.mock.callCount(), 1);
    });
});
