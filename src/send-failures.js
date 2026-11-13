/**
 * Notifications that went out, and those that didn't for good: counted for the chart
 * (src/stats-log.js) and kept, one row each, so a day of the dashboard's chart can say which ones
 * and, for a failure, why (SentNotification, SendFailure). The count is in memory at once; the row
 * is written in the background: sending never waits on the database for it, and a failed write is
 * only logged.
 */
const { Op } = require('sequelize');
const { SendFailure, SentNotification } = require('./db');
const stats = require('./stats-log');
const { todayIn, addDays } = require('./calendar');
const { DEFAULT_ZONE } = require('./quiet');
const { log } = require('./log');

// A little past the chart's 30 days
const KEEP_DAYS = 40;
// Each table's day its old rows were last cleared: once a day is enough
const prunedOn = new Map();
// Rows being written: a stop waits for them (flushFailures), as for the day counts
const writing = new Set();

const clip = (text, n) => (text ? String(text).slice(0, n) : null);

function write(model, row, what) {
    const done = keep(model, row, what);
    writing.add(done);
    done.finally(() => writing.delete(done));
    return done;
}

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
    const row = { day, chatId, about: clip(about, 255), status, error: clip(error, 500), count, tries, since };
    return write(SendFailure, row, 'a failed send');
}

/**
 * @param {{ chatId: number | string, about?: string | null, kind?: string | null,
 *   season?: number | null, episode?: number | null, count?: number }} sent
 * @returns {Promise<void>} the row's write, for tests: callers don't wait for it
 */
function recordSent({ chatId, about = null, kind = null, season = null, episode = null, count = 1 }, now = new Date()) {
    stats.count('sent', count, now);
    const day = todayIn(DEFAULT_ZONE, now);
    const row = {
        day,
        chatId,
        about: clip(about, 255),
        kind: clip(kind, 20),
        season: Number.isInteger(season) ? season : null,
        episode: Number.isInteger(episode) ? episode : null,
        count
    };
    return write(SentNotification, row, 'a sent notification');
}

/** Waits for the rows still being written: before the process stops. */
async function flushFailures() {
    await Promise.all([...writing]);
}

async function keep(model, row, what) {
    try {
        await model.create(row);
        if (prunedOn.get(model) !== row.day) {
            await model.destroy({ where: { day: { [Op.lt]: addDays(row.day, -KEEP_DAYS) } } });
            // Only once done: a clearing that failed is tried again with the next row
            prunedOn.set(model, row.day);
        }
    } catch (err) {
        log.error(`[Stats] Keeping ${what} for chat ${row.chatId} failed: ${err.message}`);
    }
}

module.exports = { recordFailure, recordSent, flushFailures, KEEP_DAYS };
