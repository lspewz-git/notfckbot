/**
 * The service checks' log lines: why a service fails, said once when it breaks and once when
 * it heals, not on every poll. Run: npm run test:unit
 */
const { test, describe, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { TelegramError } = require('telegraf');
const {
    reasonOf,
    logChange,
    plainReason,
    track,
    resetProblems,
    runCheck,
    HEALTH_CHECKS,
    checkHealth,
    invalidateHealth
} = require('../../src/admin/routes/health');
const { log } = require('../../src/log');

const logs = [];
mock.method(log, 'info', (line) => logs.push(line));
mock.method(log, 'error', (line) => logs.push(line));
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

    test('TVmaze logs under its own name', () => {
        logChange('tvmaze', { tvmaze: false, reason: 'timeout of 5000ms exceeded' });
        logChange('tvmaze', { tvmaze: true });
        assert.deepEqual(logs, ['[Health] TVmaze: error (timeout of 5000ms exceeded)', '[Health] TVmaze: ok again']);
    });

    test("TVmaze's check asks a public show through the proxy setting, no key", async (t) => {
        const axios = require('axios');
        const asked = [];
        t.mock.method(axios, 'get', async (url, config) => {
            asked.push({ url, proxy: config.proxy, key: config.headers });
            return { status: 200 };
        });
        assert.deepEqual(await HEALTH_CHECKS.tvmaze(), { tvmaze: true });
        assert.deepEqual(asked, [{ url: 'https://api.tvmaze.com/shows/1', proxy: false, key: undefined }]);
        t.mock.method(axios, 'get', async () => {
            throw Object.assign(new Error('x'), { response: { status: 503 } });
        });
        assert.deepEqual(await HEALTH_CHECKS.tvmaze(), { tvmaze: false, reason: 'HTTP 503' });
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

describe('plainReason', () => {
    test('network failures in short words', () => {
        assert.equal(plainReason('timeout of 5000ms exceeded'), 'timeout');
        assert.equal(
            plainReason(
                'request to https://api.telegram.org/bot123456:AAbb_cc-dd/getMe failed, reason: read ECONNRESET'
            ),
            'connection reset'
        );
        assert.equal(plainReason('connect ECONNREFUSED 127.0.0.1:443'), 'connection refused');
        assert.equal(plainReason(undefined), 'no details');
    });

    test('never the bot token', () => {
        assert.equal(
            plainReason('request to https://api.telegram.org/bot123456:AAbb_cc-dd/getMe failed, reason: odd'),
            'request to https://api.telegram.org/bot…/getMe failed, reason: odd'
        );
    });
});

describe('track', () => {
    beforeEach(resetProblems);

    test('a failure opens a problem, more failures count, the next success moves it to recent', () => {
        let v = track('telegram', { telegram: false, reason: 'read ECONNRESET' }, 1000);
        assert.deepEqual(v.problem, { since: 1000, reason: 'connection reset', checks: 1 });
        v = track('telegram', { telegram: false, reason: 'timeout' }, 61_000);
        assert.deepEqual(v.problem, { since: 1000, reason: 'timeout', checks: 2 });
        v = track('telegram', { telegram: true }, 121_000);
        assert.equal(v.problem, null);
        assert.deepEqual(v.recent, [{ since: 1000, until: 121_000, reason: 'timeout' }]);
    });

    test('keeps the last three, newest first; other services apart', () => {
        for (let i = 1; i <= 4; i++) {
            track('proxy', { proxy: 'error', reason: 'timeout' }, i * 100);
            track('proxy', { proxy: 'ok' }, i * 100 + 50);
        }
        const v = track('proxy', { proxy: 'ok' }, 1000);
        assert.deepEqual(
            v.recent.map((p) => p.since),
            [400, 300, 200]
        );
        assert.deepEqual(track('tmdb', { tmdb: true }).recent, []);
    });

    test('a proxy switched off ends its problem', () => {
        track('proxy', { proxy: 'error', reason: 'timeout' }, 100);
        const v = track('proxy', { proxy: 'off' }, 200);
        assert.equal(v.problem, null);
        assert.equal(v.recent.length, 1);
    });
});

describe('runCheck', () => {
    test('a single failure is asked again, and the second answer counts', async () => {
        let calls = 0;
        mock.method(HEALTH_CHECKS, 'tmdb', async () => (++calls === 1 ? { tmdb: false, reason: 'x' } : { tmdb: true }));
        assert.deepEqual(await runCheck('tmdb'), { tmdb: true });
        assert.equal(calls, 2);
    });

    test('a working service is asked once', async () => {
        let calls = 0;
        mock.method(HEALTH_CHECKS, 'kinopoisk', async () => (calls++, { kinopoisk: 'ok' }));
        await runCheck('kinopoisk');
        assert.equal(calls, 1);
    });
});

describe('checkHealth', () => {
    beforeEach(() => {
        resetProblems();
        invalidateHealth();
    });

    test('a fresh check joins one already running instead of counting twice', async () => {
        let calls = 0;
        mock.method(HEALTH_CHECKS, 'tmdb', async () => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { tmdb: true };
        });
        const [a, b] = await Promise.all([checkHealth('tmdb'), checkHealth('tmdb', null, true)]);
        assert.equal(calls, 1);
        assert.equal(a.tmdb, true);
        assert.equal(b.tmdb, true);
    });

    test('a fresh check asks again once the cached answer is in', async () => {
        let calls = 0;
        mock.method(HEALTH_CHECKS, 'tmdb', async () => (calls++, { tmdb: true }));
        await checkHealth('tmdb');
        await checkHealth('tmdb');
        await checkHealth('tmdb', null, true);
        assert.equal(calls, 2);
    });
});
