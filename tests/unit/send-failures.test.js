/**
 * What didn't go out, kept for the dashboard (src/send-failures.js): counted at once, the row
 * written in the background with its fields cut to size, the old rows cleared once a day.
 * Run: npm run test:unit
 */
const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { SendFailure } = require('../../src/db');
const stats = require('../../src/stats-log');
const { log } = require('../../src/log');
const { recordFailure, flushFailures, KEEP_DAYS } = require('../../src/send-failures');

afterEach(() => mock.restoreAll());

test("counted on Moscow's day at once; the row cut to its columns; old rows cleared once a day", async () => {
    const rows = [];
    const cleared = [];
    mock.method(SendFailure, 'create', async (fields) => rows.push(fields));
    mock.method(SendFailure, 'destroy', async ({ where }) => cleared.push(where.day[Op.lt]));
    const counted = [];
    mock.method(stats, 'count', (field, n, now) => counted.push([field, n, now.toISOString()]));

    // 00:30 on the 14th in Moscow
    const now = new Date('2026-10-13T21:30:00Z');
    await recordFailure(
        { chatId: -100, about: 'A'.repeat(300), status: 'gone', error: 'x'.repeat(600), count: 2 },
        now
    );
    assert.deepEqual(counted, [['failed', 2, now.toISOString()]]);
    assert.equal(rows[0].day, '2026-10-14');
    assert.deepEqual([rows[0].about.length, rows[0].error.length, rows[0].count], [255, 500, 2]);
    assert.deepEqual(cleared, ['2026-09-04']);
    assert.equal(KEEP_DAYS, 40);

    // The same day again: no second clearing; the next day: one
    await recordFailure({ chatId: -100, status: 'gone' }, now);
    await recordFailure({ chatId: -100, status: 'gone' }, new Date('2026-10-14T21:30:00Z'));
    assert.deepEqual(cleared, ['2026-09-04', '2026-09-05']);
});

test('a clearing that failed is tried again with the next row; a stop waits for rows being written', async () => {
    let fail = true;
    const cleared = [];
    mock.method(stats, 'count', () => {});
    mock.method(log, 'error', () => {});
    let release;
    const slow = new Promise((resolve) => {
        release = resolve;
    });
    const rows = [];
    mock.method(SendFailure, 'create', async (fields) => {
        rows.push(fields);
        if (fields.chatId === 3) await slow;
    });
    mock.method(SendFailure, 'destroy', async ({ where }) => {
        if (fail) throw new Error('lock wait timeout');
        cleared.push(where.day[Op.lt]);
    });
    const day = new Date('2026-11-20T12:00:00Z');
    await recordFailure({ chatId: 1, status: 'gone' }, day);
    fail = false;
    await recordFailure({ chatId: 2, status: 'gone' }, day);
    assert.deepEqual(cleared, ['2026-10-11']);

    // Not awaited by the caller, as in the send loops: the stop waits for it
    recordFailure({ chatId: 3, status: 'gone' }, day);
    let flushed = false;
    const flushing = flushFailures().then(() => {
        flushed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(flushed, false);
    release();
    await flushing;
    assert.equal(flushed, true);
});

test("a row that can't be written is only logged: the count stands, nothing throws", async () => {
    mock.method(SendFailure, 'create', async () => {
        throw new Error('database down');
    });
    const lines = [];
    mock.method(log, 'error', (msg) => lines.push(msg));
    const counted = [];
    mock.method(stats, 'count', (field) => counted.push(field));
    await recordFailure({ chatId: 7, status: 'rejected' });
    assert.deepEqual(counted, ['failed']);
    assert.match(lines[0], /Keeping a failed send for chat 7 failed: database down/);
});
