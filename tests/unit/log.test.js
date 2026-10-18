/**
 * The logger (src/log.js): a JSON line per entry on stdout, and the last entries in memory for
 * the panel's Logs page, with an error's message beside the text. Run: npm run test:unit
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Quiet under node --test by default; this file is about what it writes
process.env.LOG_LEVEL = 'info';
const lines = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
    // The logger's lines are kept here; the test runner's own output goes through
    if (typeof chunk === 'string' && chunk.startsWith('{"level"')) {
        lines.push(JSON.parse(chunk));
        return true;
    }
    return realWrite(chunk, ...rest);
};
const { log, logBuffer } = require('../../src/log');

beforeEach(() => {
    lines.length = 0;
    logBuffer.length = 0;
});

test('a line on stdout: the level by name, the time, the text', () => {
    log.info('[Cron] Update check complete.');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, 'info');
    assert.equal(lines[0].msg, '[Cron] Update check complete.');
    assert.match(lines[0].time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test('the Logs page gets the text and its kind', () => {
    log.info('Bot verified: @notfckbot');
    log.warn('[Admin] Refused GET /api/stats');
    log.error('[Cron] Chat 1 not notified');
    assert.deepEqual(
        logBuffer.map((e) => [e.type, e.text]),
        [
            ['log', 'Bot verified: @notfckbot'],
            ['error', '[Admin] Refused GET /api/stats'],
            ['error', '[Cron] Chat 1 not notified']
        ]
    );
    assert.equal(typeof logBuffer[0].time, 'string');
});

test('an error logged along: its message on the Logs page, its stack on stdout', () => {
    log.error({ err: new Error('connection reset') }, '[Bot] Search error');
    assert.equal(logBuffer[0].text, '[Bot] Search error: connection reset');
    assert.equal(lines[0].err.message, 'connection reset');
    assert.match(lines[0].err.stack, /connection reset\n\s+at /);
});

test("an HTTP client's error: no request and no API keys in the log, its status kept", () => {
    const err = Object.assign(new Error('Request failed with status code 401'), {
        code: 'ERR_BAD_REQUEST',
        config: { headers: { Authorization: 'Bearer SECRET-TMDB', 'X-API-KEY': 'SECRET-KP' } },
        request: { _header: 'GET / HTTP/1.1\r\nAuthorization: Bearer SECRET-TMDB' },
        response: { status: 401, config: { headers: { Authorization: 'Bearer SECRET-TMDB' } } }
    });
    log.error({ err }, '[Bot] Card error');
    assert.doesNotMatch(JSON.stringify(lines[0]), /SECRET/);
    assert.deepEqual(Object.keys(lines[0].err).sort(), ['code', 'message', 'stack', 'status', 'type']);
    assert.equal(lines[0].err.status, 401);
    assert.doesNotMatch(JSON.stringify(logBuffer), /SECRET/);
});

test('the Logs page keeps the last 200', () => {
    for (let i = 0; i < 205; i++) log.info(`line ${i}`);
    assert.equal(logBuffer.length, 200);
    assert.equal(logBuffer[0].text, 'line 5');
    assert.equal(logBuffer[199].text, 'line 204');
});
