/**
 * The update check's interval (UPDATE_INTERVAL_HOURS in .env, src/constants.js) and what follows
 * from it. Run: npm run test:unit
 */
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { parseIntervalHours, INTERVAL_CHOICES } = require('../../src/constants');
const { nextRunAt } = require('../../src/cron/status');

const { log } = require('../../src/log');

const errors = mock.method(log, 'error', () => {});

test('not set: every 3 hours', () => {
    assert.equal(parseIntervalHours(undefined), 3);
    assert.equal(parseIntervalHours(''), 3);
    assert.equal(errors.mock.callCount(), 0, 'nothing to report');
});

test('any divisor of 24 is taken as it is', () => {
    for (const hours of INTERVAL_CHOICES) assert.equal(parseIntervalHours(String(hours)), hours);
    assert.equal(parseIntervalHours(' 6 '), 6);
});

test('anything else: reported, and the default used rather than a schedule with uneven gaps', () => {
    for (const value of ['5', '0', '-3', '1.5', 'often', '48']) {
        errors.mock.resetCalls();
        assert.equal(parseIntervalHours(value), 3, value);
        assert.equal(errors.mock.callCount(), 1, value);
        assert.match(errors.mock.calls[0].arguments[0], /not one of 1, 2, 3, 4, 6, 8, 12, 24/);
    }
});

test('the next check follows the interval', () => {
    const at = (h, m) => new Date(2026, 9, 13, h, m);
    assert.equal(nextRunAt(at(19, 20), 6).getHours(), 0, 'after 18:00 comes midnight');
    assert.equal(nextRunAt(at(19, 20), 2).getHours(), 20);
    assert.equal(nextRunAt(at(19, 20), 1).getHours(), 20);
    assert.equal(nextRunAt(at(19, 20), 24).getDate(), 14, 'once a day: tomorrow at midnight');
});

test('quiet: the panel reading it on every refresh logs nothing', () => {
    errors.mock.resetCalls();
    assert.equal(parseIntervalHours('5', { quiet: true }), 3);
    assert.equal(errors.mock.callCount(), 0);
});
