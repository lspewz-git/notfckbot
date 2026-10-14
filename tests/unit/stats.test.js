/**
 * The dashboard's figures: notifications counted by day (src/stats-log.js) and the numbers and
 * charts built from them (src/admin/routes/stats.js). The database is stubbed.
 * Run: npm run test:unit
 */
const { test, describe, mock, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { DailyStat, Subscription, Chat, Series, Watchlist } = require('../../src/db');
const stats = require('../../src/stats-log');

mock.method(console, 'log', () => {});
mock.method(console, 'error', () => {});

describe('counting by day', () => {
    beforeEach(async () => {
        // Whatever an earlier test left counted
        mock.method(DailyStat, 'findOrCreate', async () => {});
        mock.method(DailyStat, 'increment', async () => {});
        await stats.flushStats();
    });

    test("counted by Moscow's day; written in one go per day, only the fields that moved", async () => {
        stats.count('sent', 2, new Date('2026-10-14T20:30:00Z')); // 23:30 in Moscow
        stats.count('sent', 1, new Date('2026-10-14T21:30:00Z')); // 00:30 the next day there
        stats.count('failed', 1, new Date('2026-10-14T21:40:00Z'));
        stats.count('nonsense', 5);
        assert.deepEqual(Object.fromEntries(stats.unwritten()), {
            '2026-10-14': { sent: 2, failed: 0, checks: 0, check_errors: 0 },
            '2026-10-15': { sent: 1, failed: 1, checks: 0, check_errors: 0 }
        });

        const increments = [];
        mock.method(DailyStat, 'increment', async (by, { where }) => increments.push([where.day, by]));
        await stats.flushStats();
        assert.deepEqual(increments, [
            ['2026-10-14', { sent: 2 }],
            ['2026-10-15', { sent: 1, failed: 1 }]
        ]);
        assert.equal(stats.unwritten().size, 0);
    });

    test('a failed write keeps the counts for the next one', async () => {
        stats.count('checks', 1, new Date('2026-10-14T12:00:00Z'));
        mock.method(DailyStat, 'findOrCreate', async () => {
            throw new Error('database down');
        });
        await stats.flushStats();
        assert.deepEqual(stats.unwritten().get('2026-10-14'), { sent: 0, failed: 0, checks: 1, check_errors: 0 });
    });
});

describe('the API', () => {
    let base;
    let server;

    before(async () => {
        const app = express();
        app.use(require('../../src/admin/routes/stats'));
        await new Promise((resolve) => {
            server = app.listen(0, resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => server.close());

    beforeEach(async () => {
        mock.method(DailyStat, 'findOrCreate', async () => {});
        mock.method(DailyStat, 'increment', async () => {});
        await stats.flushStats();
    });

    const get = (path) => fetch(`${base}${path}`).then((r) => r.json());

    test('charts: subscriptions by Monday-to-Sunday week and by month; days with the counts not yet written', async () => {
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
        const daysAgo = (n) => new Date(Date.now() - n * 86400000);
        mock.method(Subscription, 'findAll', async () => [
            { createdAt: daysAgo(0) },
            { createdAt: daysAgo(0) },
            { createdAt: daysAgo(400) } // outside both
        ]);
        mock.method(DailyStat, 'findAll', async () => [{ day: today, sent: 4, failed: 1, checks: 2, check_errors: 0 }]);
        mock.method(DailyStat, 'min', async () => today);
        stats.count('sent', 3);

        const res = await get('/api/stats/charts');
        assert.equal(res.weeks.length, 12);
        assert.equal(res.months.length, 12);
        assert.equal(res.weeks.at(-1).count, 2, 'this week');
        assert.equal(res.months.at(-1).count, 2, 'this month');
        assert.equal(new Date(`${res.weeks[0].start}T00:00:00Z`).getUTCDay(), 1, 'weeks start on Monday');
        assert.equal(res.days.length, 30);
        assert.deepEqual(res.days.at(-1), { day: today, sent: 7, failed: 1 });
        assert.equal(res.countingSince, today);
    });

    test('the cards: last 7 days against the 7 before, from the day counts', async () => {
        const fmt = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
        const day = (n) => fmt(new Date(Date.now() - n * 86400000));
        mock.method(DailyStat, 'findAll', async () => [
            { day: day(1), sent: 10, failed: 1, checks: 8, check_errors: 0 },
            { day: day(9), sent: 4, failed: 3, checks: 8, check_errors: 1 }
        ]);
        for (const model of [Chat, Series, Subscription, Watchlist]) mock.method(model, 'count', async () => 1);
        const created = new Date(Date.now() - 5 * 86400000);
        const films = [
            { notified: false, premiere_digital: '2099-01-01', createdAt: created }, // waiting
            { notified: true, premiere_digital: day(2), createdAt: created }, // waited, came out since
            { notified: true, premiere_digital: '2020-05-01', createdAt: created }, // added long out
            // Out three days ago, added yesterday: never waited, neither added nor released
            { notified: true, premiere_digital: day(3), createdAt: new Date(Date.now() - 86400000) }
        ];
        // The released query asks for notified films out in the last 30 days
        mock.method(Watchlist, 'findAll', async ({ where }) =>
            where.notified ? films.filter((f) => f.notified && f.premiere_digital >= day(29)) : films
        );
        const res = await get('/api/stats');
        assert.equal(res.filmsAdded30, 2, 'a film added already out never waited');
        // The release side too: only films that were waiting
        assert.equal(res.filmsReleased30, 1);
        assert.deepEqual([res.sent7, res.sentPrev7, res.failed7, res.failedPrev7], [10, 4, 1, 3]);
        assert.equal(res.chatsNew30, 1);
    });
});

describe('what counts as not delivered', () => {
    const { notify, flushPending } = require('../../src/cron/outbox');
    const { PendingMessage } = require('../../src/db');

    beforeEach(async () => {
        mock.method(DailyStat, 'findOrCreate', async () => {});
        mock.method(DailyStat, 'increment', async () => {});
        await stats.flushStats();
        mock.method(Chat, 'findByPk', async () => null);
        mock.method(PendingMessage, 'create', async () => {});
    });

    const failedToday = () => [...stats.unwritten().values()].reduce((n, c) => n + c.failed, 0);
    const telegramError = (code, description) =>
        Object.assign(new Error(description), { description, response: { error_code: code, description } });

    test('a blocked chat: at once; a message queued for a retry: not yet', async () => {
        await notify(
            {
                telegram: {
                    sendMessage: async () =>
                        Promise.reject(telegramError(403, 'Forbidden: bot was blocked by the user'))
                }
            },
            1,
            'x'
        );
        assert.equal(failedToday(), 1);

        // Telegram down: queued, so it may still go out
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const down = { telegram: { sendMessage: async () => Promise.reject(new Error('ETIMEDOUT')) } };
            const sending = notify(down, 2, 'y');
            for (let i = 0; i < 10; i++) {
                for (let j = 0; j < 50; j++) await Promise.resolve();
                mock.timers.tick(10000);
            }
            await sending;
        } finally {
            mock.timers.reset();
        }
        assert.equal(failedToday(), 1, 'the queued one is not counted');
    });

    test('a queued message given up on, or refused when retried: counted then', async () => {
        const row = (fields) => ({
            chatId: 3,
            text: 't',
            photo: null,
            attempts: 0,
            createdAt: new Date(),
            async destroy() {},
            async update() {},
            ...fields
        });
        mock.method(PendingMessage, 'findAll', async () => [
            row({ id: 1, createdAt: new Date(Date.now() - 3 * 86400000) }),
            row({ id: 2 })
        ]);
        await flushPending({
            telegram: { sendMessage: async () => Promise.reject(telegramError(400, 'Bad Request: chat not found')) }
        });
        assert.equal(failedToday(), 2);
    });
});
