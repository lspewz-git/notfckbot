/** Run status for the admin dashboard: running or not, the last run's counters, the next run. */
const fs = require('fs');
const path = require('path');
const { UPDATE_INTERVAL_HOURS } = require('../constants');
const { log } = require('../log');

// Guard to prevent parallel cron runs (avoids duplicate notifications)
let isRunning = false;

// The last run is kept in a file next to the code (a bind mount in Docker), so a restart or a deploy
// doesn't blank the dashboard until the next check. CRON_STATUS_FILE moves it (tests/unit use a temp file).
const STATUS_FILE = process.env.CRON_STATUS_FILE || path.join(__dirname, '..', '..', '.cron-status.json');

function loadLastRun() {
    try {
        return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    } catch {
        return null;
    }
}

let lastRun = loadLastRun();
// Counters of the run in progress; null between runs
let current = null;

/** Counts one event of the current run: series, films, sent, failed, errors. */
const tally = (key) => {
    if (current) current[key] += 1;
};

/** Why a send of the current run failed, counted by the error's text: the alert names the commonest. */
const noteFailure = (error) => {
    if (!current) return;
    const text = String(error || 'unknown').slice(0, 120);
    current.reasons[text] = (current.reasons[text] || 0) + 1;
};

/**
 * When node-cron fires next: minute 0 of the next hour divisible by the interval. "*\/N"
 * restarts at midnight, so after the day's last slot comes 00:00, not last slot + N
 * (they differ when N doesn't divide 24).
 */
function nextRunAt(now = new Date(), interval = UPDATE_INTERVAL_HOURS) {
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    const hour = Math.floor(now.getHours() / interval) * interval + interval;
    // setHours(24) rolls over to 00:00 of the next day
    next.setHours(Math.min(hour, 24));
    return next;
}

/** When node-cron last fired, at or before `now`: minute 0 of the last hour divisible by the interval. */
function lastSlotAt(now = new Date(), interval = UPDATE_INTERVAL_HOURS) {
    const slot = new Date(now);
    slot.setMinutes(0, 0, 0);
    slot.setHours(Math.floor(now.getHours() / interval) * interval);
    return slot;
}

const getCronStatus = () => ({
    running: isRunning,
    startedAt: current ? current.startedAt : null,
    lastRun,
    nextRunAt: nextRunAt().toISOString(),
    intervalHours: UPDATE_INTERVAL_HOURS
});

/** Marks a run as started; false when one is already in progress (no parallel runs). */
function beginRun() {
    if (isRunning) return false;
    isRunning = true;
    current = {
        startedAt: new Date().toISOString(),
        // The schedule it ran on: a run from an older interval says nothing about the new one's times
        intervalHours: UPDATE_INTERVAL_HOURS,
        series: 0,
        films: 0,
        sent: 0,
        failed: 0,
        // of the failed, chats that blocked the bot or are gone: not Telegram's fault
        gone: 0,
        errors: 0,
        reasons: {}
    };
    return true;
}

/** Closes the run and keeps its counters as the last run, on disk too. `fatal`: what stopped it, if anything. */
function endRun(fatal) {
    const finishedAt = new Date();
    lastRun = {
        ...current,
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - new Date(current.startedAt).getTime(),
        fatal
    };
    current = null;
    isRunning = false;
    try {
        fs.writeFileSync(STATUS_FILE, JSON.stringify(lastRun));
    } catch (err) {
        log.error(`[Cron] Could not save run status: ${err.message}`);
    }
}

module.exports = { tally, noteFailure, nextRunAt, lastSlotAt, getCronStatus, beginRun, endRun };
