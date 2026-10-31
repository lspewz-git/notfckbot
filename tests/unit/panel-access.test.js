/**
 * Panel access from Settings (src/admin/routes/access.js): roles go to ADMIN_USERS / ACCOUNT_USERS
 * in .env and into process.env at once; nobody changes their own role; a new person must have
 * written to the bot; taking access away ends their sessions. The database is stubbed, .env a
 * temporary file. Run: npm run test:unit
 */
const { test, describe, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-access-'));
const KEYS = ['ADMIN_USERS', 'ACCOUNT_USERS', 'ENV_FILE'];
const savedEnv = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
process.env.ENV_FILE = path.join(DIR, '.env');

const { Chat, AccountSession } = require('../../src/db');

const CHATS = [
    { id: 1, username: '@me' },
    { id: 7, username: '@kirill' },
    { id: 9, username: null }
];
const destroyed = [];
const stubs = [
    mock.method(Chat, 'findAll', async () => CHATS),
    mock.method(Chat, 'findOne', async ({ where }) => CHATS.find((c) => String(c.id) === where.id) || null),
    mock.method(AccountSession, 'destroy', async ({ where }) => destroyed.push(where.userId))
];

after(() => {
    stubs.forEach((s) => s.mock.restore());
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(DIR, { recursive: true, force: true });
});

describe('POST /api/access', () => {
    let server;
    let base;
    before(async () => {
        const app = express();
        app.use(express.json());
        // The guard's work: the signed-in admin
        app.use((req, res, next) => {
            req.user = { userId: '1', role: 'admin' };
            next();
        });
        app.use(require('../../src/admin/routes/access'));
        await new Promise((resolve) => {
            server = app.listen(0, resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => server.close());

    beforeEach(() => {
        fs.writeFileSync(process.env.ENV_FILE, 'BOT_TOKEN=x\nADMIN_USERS=1\nACCOUNT_USERS=\n');
        process.env.ADMIN_USERS = '1';
        process.env.ACCOUNT_USERS = '';
        destroyed.length = 0;
    });

    const call = async (method, body) => {
        const res = await fetch(`${base}/api/access`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body && JSON.stringify(body)
        });
        return { status: res.status, body: await res.json() };
    };
    const envFile = () => fs.readFileSync(process.env.ENV_FILE, 'utf8');

    test('the list: people with a role, you marked; the private chats without one to add', async () => {
        process.env.ACCOUNT_USERS = '7';
        const { body } = await call('GET');
        assert.deepEqual(body.people, [
            { id: '1', role: 'admin', name: '@me', you: true },
            { id: '7', role: 'user', name: '@kirill', you: false }
        ]);
        assert.deepEqual(body.candidates, [{ id: '9', name: null }]);
    });

    test('added, promoted, removed: .env and the running process change together', async () => {
        let res = await call('POST', { userId: '7', role: 'user' });
        assert.equal(res.status, 200);
        assert.equal(process.env.ACCOUNT_USERS, '7');
        assert.match(envFile(), /^ACCOUNT_USERS=7$/m);

        res = await call('POST', { userId: 7, role: 'admin' });
        assert.equal(res.status, 200);
        assert.equal(process.env.ADMIN_USERS, '1,7');
        assert.equal(process.env.ACCOUNT_USERS, '');
        assert.match(envFile(), /^ADMIN_USERS=1,7$/m);
        assert.match(envFile(), /^BOT_TOKEN=x$/m, 'other keys stay');
        assert.deepEqual(destroyed, [], 'a role change keeps the sessions');

        res = await call('POST', { userId: '7', role: 'none' });
        assert.equal(res.status, 200);
        assert.equal(process.env.ADMIN_USERS, '1');
        assert.deepEqual(destroyed, ['7'], 'taken off: signed out');
        assert.deepEqual(
            res.body.people.map((p) => p.id),
            ['1']
        );
    });

    test('refused: your own role, someone who never wrote to the bot, a bad role or id', async () => {
        const before = envFile();
        assert.equal((await call('POST', { userId: '1', role: 'none' })).status, 400);
        assert.equal((await call('POST', { userId: '1', role: 'user' })).status, 400);
        const stranger = await call('POST', { userId: '555', role: 'admin' });
        assert.equal(stranger.status, 400);
        assert.match(stranger.body.error, /written to the bot/);
        assert.equal((await call('POST', { userId: '7', role: 'owner' })).status, 400);
        assert.equal((await call('POST', { userId: '-100', role: 'user' })).status, 400);
        // "007" would be a second entry that never matches the 7 Telegram sends
        assert.equal((await call('POST', { userId: '007', role: 'user' })).body.error, 'Bad user id');
        // Taken off by another admin meanwhile: the guard let the request in, the handler doesn't
        process.env.ADMIN_USERS = '7';
        assert.equal((await call('POST', { userId: '7', role: 'none' })).status, 403);
        process.env.ADMIN_USERS = '1';
        assert.equal(envFile(), before, 'nothing written');
        assert.equal(process.env.ADMIN_USERS, '1');
    });
});
