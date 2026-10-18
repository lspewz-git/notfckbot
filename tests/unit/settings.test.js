/**
 * Settings on the server: .env written all at once with a backup (src/admin/env.js), every value
 * checked before anything is written (src/admin/routes/settings.js), and no restart around an
 * update check (src/admin/restart.js). Run: npm run test:unit
 */
const { test, describe, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-'));
const ENV_FILE = path.join(dir, '.env');
process.env.ENV_FILE = ENV_FILE;

const express = require('express');
const { writeEnv } = require('../../src/admin/env');
const { restartBlock } = require('../../src/admin/restart');
const services = require('../../src/admin/routes/services');

mock.method(console, 'log', () => {});
mock.method(console, 'error', () => {});

const ORIGINAL = '# Tokens\nBOT_TOKEN=123:old\nTMDB_PROXY_URL=\n\nDB_PASSWORD=secret\n';

after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('writeEnv', () => {
    beforeEach(() => fs.writeFileSync(ENV_FILE, ORIGINAL));

    test('changes the given keys, adds new ones, keeps everything else; the old file stays as .env.bak', () => {
        writeEnv({ TMDB_PROXY_URL: 'socks5h://10.0.0.5:1080', UPDATE_INTERVAL_HOURS: '6' });
        assert.equal(
            fs.readFileSync(ENV_FILE, 'utf8'),
            '# Tokens\nBOT_TOKEN=123:old\nTMDB_PROXY_URL=socks5h://10.0.0.5:1080\n\nDB_PASSWORD=secret\nUPDATE_INTERVAL_HOURS=6\n'
        );
        assert.equal(fs.readFileSync(`${ENV_FILE}.bak`, 'utf8'), ORIGINAL);
        assert.equal(fs.existsSync(`${ENV_FILE}.tmp`), false, 'no temp file left behind');
    });

    test('one unsafe value and nothing is written', () => {
        assert.throws(() => writeEnv({ TMDB_PROXY_URL: 'ok', BOT_TOKEN: 'a\nEVIL=1' }), /unsafe value/);
        assert.throws(() => writeEnv({ 'bad key': 'x' }), /key/);
        assert.equal(fs.readFileSync(ENV_FILE, 'utf8'), ORIGINAL);
    });

    test("the new file and the backup keep the old file's permissions", { skip: process.platform === 'win32' }, () => {
        fs.chmodSync(ENV_FILE, 0o600);
        writeEnv({ BOT_TOKEN: '123:new' });
        assert.equal(fs.statSync(ENV_FILE).mode & 0o777, 0o600);
        assert.equal(fs.statSync(`${ENV_FILE}.bak`).mode & 0o777, 0o600);
    });

    test('a "$" in a value is written as it is', () => {
        writeEnv({ BOT_TOKEN: '123:a$&b' });
        assert.match(fs.readFileSync(ENV_FILE, 'utf8'), /^BOT_TOKEN=123:a\$&b$/m);
    });
});

describe('restartBlock', () => {
    const status = (nextRunAt, extra = {}) => ({ running: false, nextRunAt, intervalHours: 3, ...extra });
    const at = (iso) => new Date(iso);

    test('mid-interval: fine', () => {
        assert.equal(restartBlock(at('2026-10-14T19:30:00Z'), status('2026-10-14T21:00:00Z')), null);
    });

    test('five minutes or less before a check: refused until six minutes after it', () => {
        const blocked = restartBlock(at('2026-10-14T20:56:00Z'), status('2026-10-14T21:00:00Z'));
        assert.equal(blocked.reason, 'due');
        assert.equal(blocked.until, '2026-10-14T21:06:00.000Z');
    });

    test('the check due at 18:00 never ran (node-cron late or skipped): refused until 18:06', () => {
        const blocked = restartBlock(at('2026-10-14T18:03:00Z'), status('2026-10-14T21:00:00Z'));
        assert.equal(blocked.reason, 'started');
        assert.equal(blocked.checkAt, '2026-10-14T18:00:00.000Z');
        assert.equal(blocked.until, '2026-10-14T18:06:00.000Z');
        assert.equal(restartBlock(at('2026-10-14T18:07:00Z'), status('2026-10-14T21:00:00Z')), null);
    });

    // The 18:00 check, finished in 16 s
    const ran = { lastRun: { startedAt: '2026-10-14T18:00:00.032Z', finishedAt: '2026-10-14T18:00:16.019Z' } };

    test('the check has finished: refused only for 30 s more, then fine long before 18:06', () => {
        const settling = restartBlock(at('2026-10-14T18:00:30Z'), status('2026-10-14T21:00:00Z', ran));
        assert.equal(settling.reason, 'started');
        assert.equal(settling.until, '2026-10-14T18:00:46.019Z');
        assert.equal(restartBlock(at('2026-10-14T18:00:47Z'), status('2026-10-14T21:00:00Z', ran)), null);
    });

    test("an earlier run (a manual one at 17:58) doesn't count as the 18:00 check", () => {
        const manual = { lastRun: { startedAt: '2026-10-14T17:58:00Z', finishedAt: '2026-10-14T17:58:15Z' } };
        const blocked = restartBlock(at('2026-10-14T18:02:00Z'), status('2026-10-14T21:00:00Z', manual));
        assert.equal(blocked.until, '2026-10-14T18:06:00.000Z');
    });

    test('before the check nothing changes: refused, whatever the last run was', () => {
        const blocked = restartBlock(at('2026-10-14T20:57:00Z'), status('2026-10-14T21:00:00Z', ran));
        assert.equal(blocked.reason, 'due');
    });

    test('a check still running: refused whatever the clock says', () => {
        const blocked = restartBlock(at('2026-10-14T19:30:00Z'), status('2026-10-14T21:00:00Z', { running: true }));
        assert.equal(blocked.reason, 'running');
    });
});

describe('POST /api/settings', () => {
    let base;
    let server;
    const bot = { telegram: { token: '123:old', options: {} } };

    before(async () => {
        const app = express();
        app.use(express.json());
        app.set('bot', bot);
        app.use(require('../../src/admin/routes/settings'));
        await new Promise((resolve) => {
            server = app.listen(0, resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => server.close());

    beforeEach(() => {
        fs.writeFileSync(ENV_FILE, ORIGINAL);
        process.env.BOT_TOKEN = '123:old';
        process.env.TMDB_PROXY_URL = '';
        delete process.env.UPDATE_INTERVAL_HOURS;
        // The services answer from here, not over the network
        mock.method(services.SERVICES.tmdb, 'check', async (token) => {
            if (token !== 'eyJgood.token.here')
                throw Object.assign(new Error('401'), { response: { status: 401, statusText: 'Unauthorized' } });
            return {};
        });
    });

    const post = (body) =>
        fetch(`${base}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(async (res) => ({ status: res.status, body: await res.json() }));

    test('valid values are written together and applied; the interval waits for a restart', async () => {
        const { status, body } = await post({
            tokens: { tmdb: 'eyJgood.token.here' },
            proxyUrl: 'socks5h://10.0.0.5:1080',
            intervalHours: 6
        });
        assert.equal(status, 200);
        assert.deepEqual(body.saved.sort(), ['TMDB_API_KEY', 'TMDB_PROXY_URL', 'UPDATE_INTERVAL_HOURS']);
        const file = fs.readFileSync(ENV_FILE, 'utf8');
        assert.match(file, /^TMDB_API_KEY=eyJgood\.token\.here$/m);
        assert.match(file, /^UPDATE_INTERVAL_HOURS=6$/m);
        assert.equal(process.env.TMDB_PROXY_URL, 'socks5h://10.0.0.5:1080');
        assert.deepEqual(body.settings.restart.pending, ['interval']);
        assert.equal(body.settings.tokens.tmdb.masked, 'eyJg*****here');
        assert.ok(!JSON.stringify(body).includes('eyJgood.token.here'), 'the new key is not sent back');
    });

    test('one bad value: nothing written, and each problem named by its field', async () => {
        const { status, body } = await post({
            tokens: { tmdb: 'eyJbad.token.here', telegram: 'not a token' },
            proxyUrl: 'http://host:99999',
            intervalHours: 5
        });
        assert.equal(status, 400);
        assert.deepEqual(Object.keys(body.fields).sort(), ['interval', 'proxy', 'telegram', 'tmdb']);
        assert.match(body.fields.tmdb, /rejected it: 401/);
        assert.equal(fs.readFileSync(ENV_FILE, 'utf8'), ORIGINAL);
        assert.equal(process.env.TMDB_PROXY_URL, '');
    });

    test('an empty proxy password keeps the saved one', async () => {
        process.env.TMDB_PROXY_URL = 'socks5://bob:secret@10.0.0.5:1080';
        await post({ proxyUrl: 'socks5h://bob@10.0.0.5:1080' });
        assert.equal(process.env.TMDB_PROXY_URL, 'socks5h://bob:secret@10.0.0.5:1080');
    });

    test('nothing different from what is saved: nothing written', async () => {
        const { body } = await post({ intervalHours: 3, proxyUrl: '' });
        assert.deepEqual(body.saved, []);
        assert.equal(fs.readFileSync(ENV_FILE, 'utf8'), ORIGINAL);
    });

    test('the database password and the Telegram token never reach the page', async () => {
        const res = await fetch(`${base}/api/settings`).then((r) => r.json());
        const text = JSON.stringify(res);
        assert.ok(!text.includes('secret'));
        assert.ok(!text.includes('123:old'));
    });
});
