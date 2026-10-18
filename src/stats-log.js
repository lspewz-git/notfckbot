/**
 * Counts what the bot does, by day, for the dashboard (DailyStat). Counted in memory and written
 * at the end of each update check and every ten minutes (src/cron/index.js): sending a message
 * never waits on the database for it. A restart loses at most what came since the last write.
 */
const { DailyStat } = require('./db');
const { todayIn } = require('./calendar');
const { DEFAULT_ZONE } = require('./quiet');
const { log } = require('./log');

const FIELDS = ['sent', 'failed', 'checks', 'check_errors'];
// "2026-10-14" -> { sent: 3, failed: 0, ... }, not yet written
let pending = new Map();

/** Adds `n` to today's `field` (sent, failed, checks, check_errors). */
function count(field, n = 1, now = new Date()) {
    if (!FIELDS.includes(field) || !n) return;
    const day = todayIn(DEFAULT_ZONE, now);
    if (!pending.has(day)) pending.set(day, Object.fromEntries(FIELDS.map((f) => [f, 0])));
    pending.get(day)[field] += n;
}

/** The counts not yet written, for the dashboard to add to the table's. */
const unwritten = () => new Map([...pending].map(([day, counts]) => [day, { ...counts }]));

/** Writes what was counted; on a failure keeps it for the next time. */
async function flushStats() {
    if (!pending.size) return;
    const batch = pending;
    pending = new Map();
    for (const [day, counts] of batch) {
        try {
            await DailyStat.findOrCreate({ where: { day }, defaults: { day } });
            const by = Object.fromEntries(Object.entries(counts).filter(([, n]) => n));
            if (Object.keys(by).length) await DailyStat.increment(by, { where: { day } });
        } catch (err) {
            log.error(`[Stats] Writing the day counts failed: ${err.message}`);
            for (const [field, n] of Object.entries(counts)) count(field, n, new Date(`${day}T12:00:00Z`));
        }
    }
}

module.exports = { count, flushStats, unwritten, FIELDS };
