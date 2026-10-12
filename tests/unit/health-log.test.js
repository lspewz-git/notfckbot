/**
 * The service checks' log lines: why a service fails, said once when it breaks and once when
 * it heals, not on every poll. Run: npm run test:unit
 */
const { test, describe, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { TelegramError } = require('telegraf');
const { reasonOf, logChange } = require('../../src/admin/routes/health');

const logs = [];
mock.method(console, 'log', (line) => logs.push(line));
mock.method(console, 'error', (line) => logs.push(line));
beforeEach(() => (logs.length = 0));

describe('reasonOf', () => {
    test('an HTTP answer gives its status', () => {
        assert.equal(reasonOf({ response: { status: 401 }, message: 'Request failed' }), 'HTTP 401');
    });

    test('Telegram\'s errors keep their own message, not "HTTP undefined"', () => {
        const err = new TelegramError({ ok: false, error_code: 401, description: 'Unauthorized' });
        assert.equal(reasonOf(err), '401: Unauthorized');
    });

    test('no answer at all gives the error message', () => {
        assert.equal(reasonOf(new Error('timeout of 5000ms exceeded')), 'timeout of 5000ms exceeded');
    });
});

describe('logChange', () => {
    test('says nothing when the first check finds the service fine', () => {
        logChange('tmdb', { tmdb: true });
        assert.deepEqual(logs, []);
    });

    test('one line when it breaks, none while it stays broken, one when it heals', () => {
        logChange('kinopoisk', { kinopoisk: 'ok' });
        logChange('kinopoisk', { kinopoisk: 'error', reason: 'HTTP 401' });
        logChange('kinopoisk', { kinopoisk: 'error', reason: 'HTTP 401' });
        logChange('kinopoisk', { kinopoisk: 'ok' });
        assert.deepEqual(logs, ['[Health] KP: error (HTTP 401)', '[Health] KP: ok again']);
    });

    test('a failing service reported on the first check after a start', () => {
        logChange('telegram', { telegram: false, reason: '401: Unauthorized' });
        assert.deepEqual(logs, ['[Health] TG: error (401: Unauthorized)']);
    });

    test('a failing proxy that is then switched off is "off", not "ok again"', () => {
        logChange('proxy', { proxy: 'error', reason: 'connect ECONNREFUSED' });
        logChange('proxy', { proxy: 'off' });
        assert.deepEqual(logs, ['[Health] Proxy: error (connect ECONNREFUSED)', '[Health] Proxy: off']);
    });
});
