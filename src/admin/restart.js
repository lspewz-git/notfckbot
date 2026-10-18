/**
 * Restarting the bot from the panel: the process exits and docker-compose's restart policy
 * ("restart: always") starts it again with the current .env. Never around an update check:
 * a restart then would skip it, and the subscribers would hear about new episodes hours late.
 */
const { getCronStatus } = require('../cron/status');
const { flushStats } = require('../stats-log');
const { log } = require('../log');

// No restart this close before a scheduled check. After it: not until that check has finished
// (and a moment more), or, if it never ran (node-cron late, or skipped), until AFTER_MS past
// its time. The check takes seconds, so the bot can usually restart a minute after hh:00.
const BEFORE_MS = 5 * 60 * 1000;
const AFTER_MS = 6 * 60 * 1000;
const SETTLE_MS = 30 * 1000;

/**
 * @returns {{ reason: 'running' | 'due' | 'started', checkAt: string, until: string } | null}
 *   null when a restart is fine now; otherwise why not, the check's time, and from when it is
 */
function restartBlock(now = new Date(), status = getCronStatus()) {
    const t = now.getTime();
    const next = new Date(status.nextRunAt).getTime();
    const previous = next - status.intervalHours * 60 * 60 * 1000;
    const iso = (ms) => new Date(ms).toISOString();
    if (status.running) {
        const started = status.startedAt ? new Date(status.startedAt).getTime() : t;
        return { reason: 'running', checkAt: iso(started), until: iso(t + 60 * 1000) };
    }
    if (next - t < BEFORE_MS) return { reason: 'due', checkAt: iso(next), until: iso(next + AFTER_MS) };
    if (t - previous < AFTER_MS) {
        const run = status.lastRun;
        // The run that finished is this check's, not an earlier one (a manual run just before)
        const done =
            run && run.finishedAt && new Date(run.startedAt).getTime() >= previous - 1000
                ? new Date(run.finishedAt).getTime()
                : null;
        if (done === null) return { reason: 'started', checkAt: iso(previous), until: iso(previous + AFTER_MS) };
        if (t < done + SETTLE_MS) return { reason: 'started', checkAt: iso(previous), until: iso(done + SETTLE_MS) };
    }
    return null;
}

/** Exits shortly, so the answer to the request that asked for it gets out first. */
function restartSoon(why) {
    log.info(`[Admin] Restarting the bot: ${why}`);
    // The day counts kept in memory go to the database first
    setTimeout(async () => {
        await flushStats().catch(() => {});
        process.exit(0);
    }, 800);
}

module.exports = { restartBlock, restartSoon };
