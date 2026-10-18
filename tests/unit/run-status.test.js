/**
 * The update check's run status: one run at a time, its counters, and the last run kept on
 * disk so the dashboard survives a restart. Run: npm run test:unit
 */
const { test, describe, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-status-'));
const STATUS_PATH = require.resolve('../../src/cron/status');

/** status.js with its file at `file`, loaded afresh, as on a server start. */
function loadStatus(file) {
    process.env.CRON_STATUS_FILE = file;
    delete require.cache[STATUS_PATH];
    return require(STATUS_PATH);
}

const { log } = require('../../src/log');

const errors = mock.method(log, 'error', () => {});

after(() => {
    delete process.env.CRON_STATUS_FILE;
    delete require.cache[STATUS_PATH];
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('a run', () => {
    let file;
    let status;
    beforeEach(() => {
        file = path.join(dir, `status-${Math.random().toString(36).slice(2)}.json`);
        status = loadStatus(file);
    });

    test('nothing has run on a fresh install', () => {
        const s = status.getCronStatus();
        assert.equal(s.running, false);
        assert.equal(s.startedAt, null);
        assert.equal(s.lastRun, null);
    });

    test('a second run does not start while one is in progress', () => {
        assert.equal(status.beginRun(), true);
        assert.equal(status.getCronStatus().running, true);
        assert.ok(status.getCronStatus().startedAt);
        assert.equal(status.beginRun(), false);

        status.endRun(null);
        assert.equal(status.getCronStatus().running, false);
        assert.equal(status.getCronStatus().startedAt, null);
        assert.equal(status.beginRun(), true, 'free again once the run has ended');
    });

    test('counts what the run did, and keeps it as the last run', () => {
        status.beginRun();
        status.tally('series');
        status.tally('series');
        status.tally('films');
        status.tally('sent');
        status.tally('errors');
        status.endRun(null);

        const { lastRun } = status.getCronStatus();
        assert.deepEqual(
            { series: lastRun.series, films: lastRun.films, sent: lastRun.sent, failed: lastRun.failed },
            { series: 2, films: 1, sent: 1, failed: 0 }
        );
        assert.equal(lastRun.errors, 1);
        assert.equal(lastRun.fatal, null);
        assert.ok(lastRun.durationMs >= 0);
        assert.ok(new Date(lastRun.finishedAt) >= new Date(lastRun.startedAt));
    });

    test('counts nothing between runs, so they do not leak into the next one', () => {
        status.tally('sent');
        status.beginRun();
        status.endRun(null);
        status.tally('sent');
        assert.equal(status.getCronStatus().lastRun.sent, 0);
    });

    test('keeps what stopped a run', () => {
        status.beginRun();
        status.endRun('Connection refused');
        assert.equal(status.getCronStatus().lastRun.fatal, 'Connection refused');
    });
});

describe('the status file', () => {
    test('the last run is written to disk, and read back on the next start', () => {
        const file = path.join(dir, 'restart.json');
        const before = loadStatus(file);
        before.beginRun();
        before.tally('sent');
        before.endRun(null);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before.getCronStatus().lastRun);

        const restarted = loadStatus(file);
        assert.deepEqual(restarted.getCronStatus().lastRun, before.getCronStatus().lastRun);
        assert.equal(restarted.getCronStatus().running, false);
    });

    test('a damaged file counts as no last run', () => {
        const file = path.join(dir, 'damaged.json');
        fs.writeFileSync(file, '{"startedAt": ');
        assert.equal(loadStatus(file).getCronStatus().lastRun, null);
    });

    test('a file that cannot be written still ends the run, and is reported', () => {
        errors.mock.resetCalls();
        const status = loadStatus(path.join(dir, 'no-such-dir', 'status.json'));
        status.beginRun();
        status.endRun(null);

        assert.equal(status.getCronStatus().running, false);
        assert.ok(status.getCronStatus().lastRun, 'the dashboard still shows it until a restart');
        assert.equal(status.beginRun(), true, 'the next run is not blocked');
        assert.match(String(errors.mock.calls[0].arguments[0]), /Could not save run status/);
    });
});

test('the dashboard is told when the next run is due and how often runs happen', () => {
    const status = loadStatus(path.join(dir, 'next.json'));
    const s = status.getCronStatus();
    assert.ok(new Date(s.nextRunAt) > new Date());
    assert.equal(typeof s.intervalHours, 'number');
});
