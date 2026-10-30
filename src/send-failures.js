/**
 * Notifications that didn't go out for good: counted for the chart (src/stats-log.js) and kept,
 * one row each, so the dashboard can say which ones and why (SendFailure). The count is in memory
 * at once; the row is written in the background: sending never waits on the database for it, and
 * a failed write is only logged.
 */
const { Op } = require('sequelize');
const { SendFailure } = require('./db');
const stats = require('./stats-log');
const { todayIn, addDays } = require('./calendar');
const { DEFAULT_ZONE } = require('./quiet');
const { log } = require('./log');

// A little past the chart's 30 days
const KEEP_DAYS = 40;
// The day the old rows were last cleared: once a day is enough
let prunedOn = null;
// Rows being written: a stop waits for them (flushFailures), as for the day counts
const writing = new Set();

const clip = (text, n) => (text ? String(text).slice(0, n) : null);

/**
 * @param {{ chatId: number | string, about?: string | null, status: string, error?: string | null,
 *   count?: number, tries?: number, since?: Date | null }} failure
 * @returns {Promise<void>} the row's write, for tests: callers don't wait for it
 */
function recordFailure(
    { chatId, about = null, status, error = null, count = 1, tries = 0, since = null },
    now = new Date()
) {
    stats.count('failed', count, now);
    const day = todayIn(DEFAULT_ZONE, now);
    const write = keep({ day, chatId, about: clip(about, 255), status, error: clip(error, 500), count, tries, since });
    writing.add(write);
    write.finally(() => writing.delete(write));
    return write;
}

/** Waits for the rows still being written: before the process stops. */
async function flushFailures() {
    await Promise.all([...writing]);
}

async function keep(row) {
    try {
        await SendFailure.create(row);
        if (prunedOn !== row.day) {
            await SendFailure.destroy({ where: { day: { [Op.lt]: addDays(row.day, -KEEP_DAYS) } } });
            // Only once done: a clearing that failed is tried again with the next row
            prunedOn = row.day;
        }
    } catch (err) {
        log.error(`[Stats] Keeping a failed send for chat ${row.chatId} failed: ${err.message}`);
    }
}

module.exports = { recordFailure, flushFailures, KEEP_DAYS };
