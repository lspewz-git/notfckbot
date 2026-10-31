/**
 * Panel access (src/admin/routes/access.js): a role is saved in the database for a person who wrote
 * to the bot; nobody changes their own; "No access" ends their sessions and removes their password;
 * sign-up and the system account's password go to .env and process.env at once; an admin removes
 * someone's password. The database is stubbed, .env a temporary file. Run: npm run test:unit
 */
const { test, describe, mock, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { Op } = require('sequelize');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-access-'));
const KEYS = ['OPEN_SIGNUP', 'SYSTEM_LOGIN', 'SYSTEM_PASSWORD_HASH', 'ENV_FILE'];
const savedEnv = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
process.env.ENV_FILE = path.join(DIR, '.env');

const { Chat, AccountSession, AccountPassword, PanelRole } = require('../../src/db');
const { matches } = require('../../src/account/password');

const CHATS = ['1', '7', '9'];
// userId → role
const panelRoles = new Map();
// What AccountSession.destroy was asked: [userId, the session kept or null]
const destroyed = [];
const passwords = new Set();
const notices = [];
const stubs = [
    mock.method(Chat, 'findOne', async ({ where }) => (CHATS.includes(where.id) ? { id: where.id } : null)),
    mock.method(PanelRole, 'findByPk', async (id) =>
        panelRoles.has(String(id)) ? { role: panelRoles.get(String(id)) } : null
    ),
    mock.method(PanelRole, 'findAll', async () => [...panelRoles].map(([userId, role]) => ({ userId, role }))),
    mock.method(PanelRole, 'upsert', async (row) => panelRoles.set(String(row.userId), row.role)),
    mock.method(AccountSession, 'destroy', async ({ where }) => {
        destroyed.push([String(where.userId), where.id ? where.id[Op.ne] : null]);
    }),
    mock.method(AccountPassword, 'destroy', async ({ where }) => Number(passwords.delete(String(where.userId))))
];

after(() => {
    stubs.forEach((s) => s.mock.restore());
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(DIR, { recursive: true, force: true });
});

describe('/api/access', () => {
    let server;
    let base;
    // The signed-in admin, as the guard sets it
    let user;
    before(async () => {
        const app = express();
        app.use(express.json());
        app.use((req, res, next) => {
            req.user = user;
            next();
        });
        app.set('bot', { telegram: { sendMessage: async (chatId, text) => notices.push({ chatId, text }) } });
        app.use(require('../../src/admin/routes/access'));
        await new Promise((resolve) => {
            server = app.listen(0, resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => server.close());

    beforeEach(() => {
        fs.writeFileSync(process.env.ENV_FILE, 'BOT_TOKEN=x\n');
        for (const k of ['OPEN_SIGNUP', 'SYSTEM_LOGIN', 'SYSTEM_PASSWORD_HASH']) delete process.env[k];
        panelRoles.clear();
        panelRoles.set('1', 'admin');
        user = { id: 'session-1', userId: '1', role: 'admin', system: false };
        destroyed.length = 0;
        passwords.clear();
        notices.length = 0;
    });

    const call = async (method, body, route = '/api/access') => {
        const res = await fetch(`${base}${route}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body && JSON.stringify(body)
        });
        return { status: res.status, body: await res.json() };
    };
    const envFile = () => fs.readFileSync(process.env.ENV_FILE, 'utf8');

    test('a role is saved in the database; "No access" signs them out and removes their password', async () => {
        let res = await call('POST', { userId: '7', role: 'admin' });
        assert.deepEqual([res.status, res.body], [200, { userId: '7', role: 'admin' }]);
        assert.equal(panelRoles.get('7'), 'admin');
        assert.deepEqual(destroyed, [], 'a role change keeps the sessions');

        passwords.add('7');
        res = await call('POST', { userId: 7, role: 'none' });
        assert.deepEqual(res.body, { userId: '7', role: 'none' });
        assert.deepEqual(destroyed, [['7', null]], 'signed out everywhere');
        assert.equal(passwords.has('7'), false);
        assert.equal(envFile(), 'BOT_TOKEN=x\n', '.env untouched');
    });

    test('refused: your own role, someone who never wrote to the bot, a bad role or id, a non-admin', async () => {
        assert.equal((await call('POST', { userId: '1', role: 'user' })).status, 400);
        const stranger = await call('POST', { userId: '555', role: 'admin' });
        assert.deepEqual([stranger.status, stranger.body.error], [400, "This person hasn't written to the bot yet"]);
        assert.equal((await call('POST', { userId: '7', role: 'owner' })).status, 400);
        assert.equal((await call('POST', { userId: '-100', role: 'user' })).status, 400);
        // "007" would be a second row that never matches the 7 Telegram sends
        assert.equal((await call('POST', { userId: '007', role: 'user' })).body.error, 'Bad user id');
        // Taken off by another admin meanwhile: the guard let the request in, the handler doesn't
        panelRoles.set('1', 'user');
        assert.equal((await call('POST', { userId: '7', role: 'none' })).status, 403);
        assert.deepEqual([...panelRoles.keys()], ['1']);
    });

    test('sign-up: written to .env and applied at once; the settings say how things stand', async () => {
        assert.deepEqual((await call('GET')).body, {
            openSignup: false,
            system: { login: 'admin', passwordSet: false }
        });
        const res = await call('PUT', { open: true }, '/api/access/signup');
        assert.equal(res.body.openSignup, true);
        assert.equal(process.env.OPEN_SIGNUP, 'true');
        assert.match(envFile(), /^OPEN_SIGNUP=true$/m);
        assert.equal((await call('PUT', { open: 'yes' }, '/api/access/signup')).status, 400);
    });

    test('the system account password: a hash in .env without "$", its other sessions end', async () => {
        assert.equal((await call('PUT', { password: 'short' }, '/api/access/system-password')).status, 400);
        const res = await call('PUT', { password: 'system-pass' }, '/api/access/system-password');
        assert.equal(res.body.system.passwordSet, true);
        const hash = /^SYSTEM_PASSWORD_HASH=(.+)$/m.exec(envFile())[1];
        assert.equal(hash.includes('$'), false, 'Compose would read "$" as a variable');
        assert.equal(await matches('system-pass', hash), true);
        assert.equal(process.env.SYSTEM_PASSWORD_HASH, hash);
        assert.deepEqual(destroyed, [['0', null]]);

        // Changed by the system account itself: its own session stays
        destroyed.length = 0;
        user = { id: 'session-0', userId: '0', role: 'admin', system: true };
        await call('PUT', { password: 'system-pass-2' }, '/api/access/system-password');
        assert.deepEqual(destroyed, [['0', 'session-0']]);
    });

    test("an admin removes someone's password: their sessions end, the bot tells them, the role stays", async () => {
        panelRoles.set('7', 'user');
        passwords.add('7');
        const res = await call('DELETE', undefined, '/api/access/7/password');
        assert.deepEqual([res.status, res.body], [200, { userId: '7', hasPassword: false }]);
        assert.equal(passwords.has('7'), false);
        assert.equal(panelRoles.get('7'), 'user');
        assert.deepEqual(destroyed, [['7', null]]);
        for (let i = 0; i < 100 && !notices.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(String(notices[0].chatId), '7');
        assert.match(notices[0].text, /Администратор панели удалил ваш пароль/);
        assert.equal((await call('DELETE', undefined, '/api/access/abc/password')).status, 400);
    });
});
