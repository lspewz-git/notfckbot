/**
 * Signing in to the panel and the users' own chats (src/account/): who may sign in and as what,
 * the one-time links, the codes the bot confirms, sessions, which API a role may call, and who may
 * open and change which chat. The database and Telegram are stubbed.
 * Run: node --test tests/unit/account.test.js
 */
const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHmac } = require('node:crypto');
const express = require('express');
const sequelize = require('../../src/database');
const { Op, UniqueConstraintError } = require('sequelize');
const {
    AccountSession,
    AccountDevice,
    LoginLink,
    MiniAppLaunch,
    AccountPassword,
    PanelRole,
    HiddenChat,
    Chat,
    Watchlist,
    Subscription
} = require('../../src/db');
const auth = require('../../src/account/auth');
const roles = require('../../src/account/roles');
const password = require('../../src/account/password');
const members = require('../../src/account/members');
const devices = require('../../src/account/devices');
const { guard } = require('../../src/account/guard');
const { panelOnly } = require('../../src/admin/panel-only');

const ENV = ['ADMIN_USERS', 'ACCOUNT_USERS', 'PANEL_URL', 'OPEN_SIGNUP', 'SYSTEM_LOGIN', 'SYSTEM_PASSWORD_HASH'];
let savedEnv;
let sessions;
let links;
let passwords;
// PanelRole's rows: userId → role
let panelRoles;
// AccountDevice's rows
let deviceRows;

/** AccountDevice's where: the fields the code asks by, with Op.ne / Op.lte / Op.lt. */
function deviceMatch(row, where) {
    for (const [key, want] of Object.entries(where)) {
        const value = row[key];
        if (want && typeof want === 'object' && !(want instanceof Date)) {
            if (Op.ne in want && String(value) === String(want[Op.ne])) return false;
            if (Op.lte in want && !(new Date(value) <= want[Op.lte])) return false;
            if (Op.lt in want && !(new Date(value) < want[Op.lt])) return false;
        } else if (String(value) !== String(want)) return false;
    }
    return true;
}

beforeEach(() => {
    mock.method(sequelize, 'transaction', async (options, run = options) => run({ LOCK: { UPDATE: 'UPDATE' } }));
    mock.method(require('../../src/api/kinopoisk'), 'knownKinopoiskId', () => null);
    savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    process.env.PANEL_URL = 'https://box/';
    panelRoles = new Map([
        ['42', 'admin'],
        ['7', 'user'],
        ['8', 'user']
    ]);
    mock.method(PanelRole, 'findByPk', async (id) =>
        panelRoles.has(String(id)) ? { role: panelRoles.get(String(id)) } : null
    );
    mock.method(PanelRole, 'findAll', async ({ where }) =>
        where.userId[Op.in]
            .filter((id) => panelRoles.has(String(id)))
            .map((id) => ({ userId: id, role: panelRoles.get(String(id)) }))
    );
    mock.method(PanelRole, 'upsert', async (row) => panelRoles.set(String(row.userId), row.role));
    sessions = new Map();
    links = new Map();
    passwords = new Map();
    mock.method(HiddenChat, 'findAll', async () => []);
    mock.method(AccountPassword, 'findByPk', async (id) =>
        passwords.has(String(id)) ? passwords.get(String(id)) : null
    );
    // MariaDB stamps updatedAt on every upsert
    mock.method(AccountPassword, 'upsert', async (row) =>
        passwords.set(String(row.userId), { ...row, updatedAt: new Date('2026-11-02T10:00:00Z') })
    );
    mock.method(AccountPassword, 'destroy', async ({ where }) => Number(passwords.delete(String(where.userId))));
    const table = (rows) => ({
        create: async (row) => {
            rows.set(row.id, row);
            return row;
        },
        findByPk: async (id) => rows.get(id) || null,
        update: async (values, { where }) => {
            let count = 0;
            for (const row of rows.values()) {
                if (where.id && row.id !== where.id) continue;
                if (where.userId && String(row.userId) !== String(where.userId)) continue;
                const expiry = new Date(row.expiresAt).getTime();
                if (where.expiresAt?.[Op.gt] && expiry <= Number(where.expiresAt[Op.gt])) continue;
                if (where.expiresAt?.[Op.lt] && expiry >= Number(where.expiresAt[Op.lt])) continue;
                Object.assign(row, values);
                count += 1;
            }
            return [count];
        },
        destroy: async ({ where }) => {
            if (typeof where.id === 'string') return rows.delete(where.id) ? 1 : 0;
            // A user's sessions, but the one kept (where.id[Op.ne])
            const keep = where.id && where.id[Op.ne];
            const gone = [...rows.values()].filter((r) => String(r.userId) === String(where.userId) && r.id !== keep);
            gone.forEach((r) => rows.delete(r.id));
            return gone.length;
        }
    });
    for (const [model, rows] of [
        [AccountSession, sessions],
        [LoginLink, links]
    ]) {
        const fake = table(rows);
        for (const method of ['create', 'findByPk', 'destroy', 'update']) mock.method(model, method, fake[method]);
    }
    members.forget();
    deviceRows = [];
    devices.resetDevices();
    const matching = (where) => deviceRows.filter((row) => deviceMatch(row, where));
    mock.method(AccountDevice, 'findAll', async ({ where }) => matching(where).map((row) => ({ ...row })));
    mock.method(AccountDevice, 'findOne', async ({ where }) => {
        const row = matching(where)[0];
        return row ? { ...row } : null;
    });
    mock.method(AccountDevice, 'count', async ({ where }) => matching(where).length);
    mock.method(AccountDevice, 'create', async (row) => deviceRows.push({ ...row }));
    mock.method(AccountDevice, 'update', async (values, { where }) => {
        matching(where).forEach((row) => Object.assign(row, values));
    });
    mock.method(AccountDevice, 'destroy', async ({ where }) => {
        const gone = matching(where);
        deviceRows = deviceRows.filter((row) => !gone.includes(row));
        return gone.length;
    });
});

afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    mock.restoreAll();
});

const tokenOf = (link) => link.split('/login/')[1];

test('roles: from the database; open sign-up lets in whoever started the bot; "none" stays out', async (t) => {
    t.mock.method(Chat, 'findOne', async ({ where }) => (['99', '5'].includes(where.id) ? { id: where.id } : null));
    assert.equal(await roles.roleOf(42), 'admin');
    assert.equal(await roles.roleOf('8'), 'user');
    assert.equal(await roles.roleOf(99), null, 'sign-up closed');
    panelRoles.set('5', 'none');
    process.env.OPEN_SIGNUP = 'true';
    assert.equal(await roles.roleOf(99), 'user', 'started the bot');
    assert.equal(await roles.roleOf(100), null, 'never started the bot');
    assert.equal(await roles.roleOf(5), null, 'taken away by an admin');
    assert.equal(await roles.roleOf('-100'), null, 'a group is nobody');
    const list = await roles.rolesOf(['42', '5', '99']);
    assert.deepEqual([...list.values()], ['admin', 'none', 'user']);
    process.env.OPEN_SIGNUP = 'false';
    assert.deepEqual([...(await roles.rolesOf(['99'])).values()], [null]);
});

test('the system account: id 0, an admin only while it has a password; its login and password sign in', async (t) => {
    t.mock.method(Chat, 'findAll', async () => []);
    assert.equal(await roles.roleOf(0), null);
    process.env.SYSTEM_PASSWORD_HASH = await password.hashPassword('system-pass');
    assert.equal(await roles.roleOf('0'), 'admin');
    assert.equal(await password.signInWithPassword('admin', 'wrong-pass'), null);
    const { token } = await password.signInWithPassword(' Admin ', 'system-pass');
    const session = await auth.sessionOf({ headers: { cookie: `nfb_session=${token}` } });
    assert.deepEqual([session.userId, session.role, session.system, session.userName], ['0', 'admin', true, 'admin']);
    process.env.SYSTEM_LOGIN = 'root';
    assert.equal(await password.signInWithPassword('admin', 'system-pass'), null, 'renamed');
    assert.ok(await password.signInWithPassword('root', 'system-pass'));
    delete process.env.SYSTEM_PASSWORD_HASH;
    assert.equal(await auth.sessionOf({ headers: { cookie: `nfb_session=${token}` } }), null, 'no password: out');
});

test('roles from .env move into the database once, while it has none', async (t) => {
    const created = [];
    let count = 0;
    t.mock.method(PanelRole, 'count', async () => count);
    t.mock.method(PanelRole, 'bulkCreate', async (rows) => created.push(...rows));
    process.env.ADMIN_USERS = '42, 7';
    process.env.ACCOUNT_USERS = '7,8,x';
    assert.equal(await roles.importFromEnv(), 3);
    assert.deepEqual(created, [
        { userId: '42', role: 'admin' },
        { userId: '7', role: 'admin' },
        { userId: '8', role: 'user' }
    ]);
    count = 3;
    assert.equal(await roles.importFromEnv(), 0, 'not again');
    delete process.env.ADMIN_USERS;
    delete process.env.ACCOUNT_USERS;
    count = 0;
    assert.equal(await roles.importFromEnv(), 0, 'nothing to move');
    assert.equal(created.length, 3);
});

test('a link: only for allowed users with PANEL_URL set; works once; only hashes are stored', async () => {
    assert.equal(await auth.createLink({ id: 99 }), null);
    const link = await auth.createLink({ id: 7, name: '@u7' }, -100);
    assert.match(link, /^https:\/\/box\/login\/[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(link);
    assert.ok(![...links.keys()].includes(token), 'the token itself is not stored');

    const first = await auth.redeemLink(token);
    assert.equal(first.chatId, '-100');
    assert.equal(await auth.redeemLink(token), null, 'second use');
    const session = await auth.sessionOf({ headers: { cookie: `x=1; nfb_session=${first.token}` } });
    assert.deepEqual([session.userId, session.role], ['7', 'user']);

    process.env.PANEL_URL = 'http://box/';
    assert.equal(await auth.createLink({ id: 7 }), null);
    delete process.env.PANEL_URL;
    assert.equal(await auth.createLink({ id: 7 }), null);
});

test('a link expires after five minutes; a user taken off the list loses link and session', async () => {
    const now = Date.now();
    const late = tokenOf(await auth.createLink({ id: 7 }, null, now));
    assert.equal(await auth.redeemLink(late, now + auth.LINK_TTL_MS + 1), null, 'expired');

    const { token } = await auth.redeemLink(tokenOf(await auth.createLink({ id: 8 }, null, now)), now);
    const req = { headers: { cookie: `nfb_session=${token}` } };
    assert.ok(await auth.sessionOf(req, now));
    panelRoles.set('8', 'none');
    assert.equal(await auth.sessionOf(req, now), null);
    panelRoles.set('8', 'user');
    assert.equal(await auth.sessionOf(req, now + auth.SESSION_TTL_MS + 1), null, 'session expired');
});

test('links cannot outlive revocation, even if the role is restored or redemption was pending', async (t) => {
    const old = tokenOf(await auth.createLink({ id: 42 }));
    await roles.setRole('42', 'none');
    await auth.endOtherSessions('42');
    await roles.setRole('42', 'admin');
    assert.equal(await auth.redeemLink(old), null);

    const pending = tokenOf(await auth.createLink({ id: 42 }));
    const find = LoginLink.findByPk;
    t.mock.method(LoginLink, 'findByPk', async (id, options) => {
        if (options?.lock) await auth.endOtherSessions('42');
        return find(id);
    });
    assert.equal(await auth.redeemLink(pending), null);
    assert.equal(sessions.size, 0);
});

test('sessions and links issued before HTTPS are rejected', async () => {
    const crypto = require('node:crypto');
    const legacy = 'x'.repeat(43);
    const id = crypto.createHash('sha256').update(legacy).digest('hex');
    const row = { id, userId: '42', expiresAt: new Date(Date.now() + 60_000) };
    sessions.set(id, row);
    links.set(id, row);
    assert.equal(await auth.sessionOf({ headers: { cookie: `nfb_session=${legacy}` } }), null);
    assert.equal(await auth.redeemLink(legacy), null);
});

test('a system password rotation invalidates old cookies and racing inserts', async (t) => {
    process.env.SYSTEM_PASSWORD_HASH = await password.hashPassword('old-password');
    const { token } = await password.signInWithPassword('admin', 'old-password');
    const replacement = await password.hashPassword('new-password');
    const create = AccountSession.create;
    const stub = t.mock.method(AccountSession, 'create', async (row) => {
        process.env.SYSTEM_PASSWORD_HASH = replacement;
        return create(row);
    });
    assert.equal(await password.signInWithPassword('admin', 'old-password'), null);
    const racingId = stub.mock.calls[0].arguments[0].id;
    assert.equal(sessions.has(racingId), false);
    assert.equal(await auth.sessionOf({ headers: { cookie: `nfb_session=${token}` } }), null);
    stub.mock.restore();
    assert.ok((await password.signInWithPassword('admin', 'new-password')).token);
});

test('"Войти через Telegram": in only after "Да" in the bot, only for the page with the secret, once', async () => {
    const { code, secret } = auth.startCode();
    assert.equal(auth.isWaiting(code), true);
    assert.deepEqual(await auth.pollCode(code, secret), { state: 'waiting' });
    assert.equal(await auth.answerCode(code, { id: 99 }, true), false, 'not allowed in');
    assert.equal(await auth.answerCode(code, { id: 7, name: '@u7' }, true), true);
    assert.equal(await auth.answerCode(code, { id: 8 }, true), false, 'answered already');
    // Someone who only saw the bot link (the code) has no secret
    assert.deepEqual(await auth.pollCode(code, 'x'.repeat(43)), { state: 'gone' });
    const result = await auth.pollCode(code, secret);
    assert.equal(result.state, 'in');
    const session = await auth.sessionOf({ headers: { cookie: `nfb_session=${result.token}` } });
    assert.equal(session.userId, '7');
    assert.deepEqual(await auth.pollCode(code, secret), { state: 'gone' }, 'used up');

    const refused = auth.startCode();
    await auth.answerCode(refused.code, { id: 7 }, false);
    assert.deepEqual(await auth.pollCode(refused.code, refused.secret), { state: 'refused' });
});

test('confirmation: cancel requires the secret; timeout and concurrent polls cannot create another session', async () => {
    const cancelled = auth.startCode();
    assert.equal(auth.cancelCode(cancelled.code, 'x'.repeat(43)), false);
    assert.equal(auth.isWaiting(cancelled.code), true);
    assert.equal(auth.cancelCode(cancelled.code, cancelled.secret), true);
    assert.equal(await auth.answerCode(cancelled.code, { id: 7 }, true), false);
    const late = auth.startCode(null, null, Date.now() - auth.LINK_TTL_MS);
    assert.deepEqual(await auth.pollCode(late.code, late.secret), { state: 'gone' });
    const start = auth.startCode();
    await auth.answerCode(start.code, { id: 7 }, true);
    const results = await Promise.all([
        auth.pollCode(start.code, start.secret),
        auth.pollCode(start.code, start.secret)
    ]);
    assert.deepEqual(results.map((r) => r.state).sort(), ['gone', 'in']);
    assert.equal(sessions.size, 1);
});

test('password confirmation: removal, change, access revocation and end-other-sessions invalidate pending approval', async (t) => {
    t.mock.method(Chat, 'findByPk', async () => null);
    await password.setPassword('7', 'secret-pass');
    for (const action of ['remove', 'change', 'access', 'sessions', 'hash']) {
        await password.setPassword('7', 'secret-pass');
        panelRoles.set('7', 'user');
        const start = await password.signInWithPassword('7', 'secret-pass');
        await auth.answerCode(start.code, { id: 7 }, true);
        if (action === 'remove') await password.removePassword('7');
        if (action === 'change') await password.setPassword('7', 'different-pass');
        if (action === 'access') panelRoles.set('7', 'none');
        if (action === 'sessions') await auth.endOtherSessions('7');
        if (action === 'hash') passwords.get('7').hash = 'replaced elsewhere';
        assert.deepEqual(await auth.pollCode(start.code, start.secret), { state: 'gone' }, action);
        assert.equal(sessions.size, 0);
    }
});

test('revocation while the session insert is pending removes the newly inserted session', async (t) => {
    const start = auth.startCode();
    await auth.answerCode(start.code, { id: 7 }, true);
    const create = AccountSession.create;
    t.mock.method(AccountSession, 'create', async (row) => {
        await auth.endOtherSessions('7');
        return create(row);
    });
    assert.deepEqual(await auth.pollCode(start.code, start.secret), { state: 'gone' });
    assert.equal(sessions.size, 0);
});

test('seven-day inactivity: reads do not renew; actor activity renews only valid sessions; migration only caps', async () => {
    const now = Date.now();
    const token = await auth.startSession({ userId: 7 }, now);
    await auth.startSession({ userId: 8 }, now);
    const req = { headers: { cookie: `nfb_session=${token}` } };
    const row = [...sessions.values()].find((r) => String(r.userId) === '7');
    assert.equal(auth.SESSION_TTL_MS, 7 * 86400000);
    assert.ok(await auth.sessionOf(req, now + 86400000));
    assert.equal(Number(row.expiresAt), now + auth.SESSION_TTL_MS, 'passive reads keep the deadline');
    await auth.touchSessions({ userId: 7 }, now + 2 * 86400000);
    assert.equal(Number(row.expiresAt), now + 2 * 86400000 + auth.SESSION_TTL_MS);
    const other = [...sessions.values()].find((r) => String(r.userId) === '8');
    assert.equal(Number(other.expiresAt), now + auth.SESSION_TTL_MS, 'another user is unchanged');
    assert.deepEqual(await auth.touchSessions({ userId: 8 }, now + auth.SESSION_TTL_MS), [0]);
    assert.equal(await auth.sessionOf({ headers: { cookie: `nfb_session=${token}` } }, Number(row.expiresAt)), null);
    await auth.endOtherSessions(7);
    await auth.touchSessions({ userId: 7 }, now + 3 * 86400000);
    assert.equal(sessions.size, 1, 'revocation is never undone');
    other.expiresAt = new Date(now + 30 * 86400000);
    await auth.capSessionLifetimes(now);
    assert.equal(Number(other.expiresAt), now + auth.SESSION_TTL_MS);
    other.expiresAt = new Date(now - 1);
    await auth.capSessionLifetimes(now);
    assert.equal(Number(other.expiresAt), now - 1, 'expired stays expired');
});

test('bot activity uses the Telegram actor, ignores passive updates and anonymous senders', async (t) => {
    const { accountActivity } = require('../../src/bot/account-activity');
    await auth.startSession({ userId: 7 }, Date.now() - 86400000);
    await auth.startSession({ userId: 8 }, Date.now() - 86400000);
    const update = t.mock.method(AccountSession, 'update', AccountSession.update);
    let handled = false;
    await accountActivity(
        { from: { id: 7 }, chat: { id: -100, type: 'supergroup' }, callbackQuery: { data: 'subs_o' } },
        async () => {
            handled = true;
        }
    );
    assert.equal(handled, true);
    assert.equal(update.mock.calls[0].arguments[1].where.userId, 7);
    const own = [...sessions.values()].find((r) => r.userId === 7);
    const other = [...sessions.values()].find((r) => r.userId === 8);
    assert.ok(Number(own.expiresAt) > Number(other.expiresAt));
    for (const ctx of [
        {},
        { from: { id: 7 }, message: { text: 'chatting' }, chat: { type: 'supergroup' } },
        { from: { id: 7 }, message: { text: '/subs', sender_chat: { id: -1 } } }
    ]) {
        await accountActivity(ctx, async () => {});
    }
    assert.equal(update.mock.calls.length, 1);
});

/** Telegram's answer about members: chatId → userId → status, or an Error */
function fakeBot(statuses, sent = []) {
    return {
        botInfo: { username: 'notfckbot' },
        telegram: {
            getChatMember: async (chatId, userId) => {
                const status = (statuses[chatId] || {})[userId] || 'left';
                if (status instanceof Error) throw status;
                return { status };
            },
            getChat: async (chatId) => ({ title: `Группа ${chatId}` }),
            sendMessage: async (chatId, text) => {
                sent.push({ chatId: String(chatId), text });
                return { message_id: 1 };
            }
        }
    };
}

test('own chat for its user, a group for its members, its settings for its admins only', async (t) => {
    const types = { '-1': 'supergroup', '-2': 'group', '-3': 'channel' };
    t.mock.method(Chat, 'findByPk', async (id) => (types[id] ? { type: types[id] } : null));
    members.useBot(
        fakeBot({
            '-1': { 42: 'administrator', 7: 'member' },
            '-2': { 42: new Error('Too Many Requests: retry after 5') },
            // The bot is an admin of its channels: every subscriber is a "member" to Telegram
            '-3': { 7: 'member' }
        })
    );
    assert.deepEqual(await members.accessTo('42', '42'), { edit: true, settings: true });
    assert.equal(await members.accessTo('42', '7'), null, "someone else's private chat");
    assert.deepEqual(await members.accessTo('42', '-1'), { edit: true, settings: true });
    assert.deepEqual(await members.accessTo('7', '-1'), { edit: true, settings: false });
    assert.equal(await members.accessTo('99', '-1'), null, 'not in the group');
    assert.equal(await members.accessTo('7', '-3'), null, "a channel's subscriber can't change its list");
    assert.equal(await members.accessTo('7', '-9'), null, 'a group the bot has never seen');
    // Telegram didn't answer: no access on a guess, and not "not a member" for minutes either
    await assert.rejects(members.accessTo('42', '-2'), { status: 503 });
    members.forget();
    members.useBot(fakeBot({ '-2': { 42: 'member' } }));
    assert.deepEqual(await members.accessTo('42', '-2'), { edit: true, settings: false });
});

test('Telegram hanging: a membership question gives up after 3 s, and the next one fails at once', async (t) => {
    t.mock.method(Chat, 'findByPk', async () => ({ type: 'group' }));
    members.useBot({ telegram: { getChatMember: () => new Promise(() => {}) } });
    const started = Date.now();
    await assert.rejects(members.accessTo('42', '-1'), { status: 503 });
    const took = Date.now() - started;
    assert.ok(took >= 2900 && took < 4000, String(took));
    const again = Date.now();
    await assert.rejects(members.accessTo('42', '-1'), { status: 503 });
    assert.ok(Date.now() - again < 100, 'not asked again for 30 s');
});

// --- The API, as src/admin/index.js puts it together ---

test('chat visibility is personal, persists, requires membership and cannot hide the own account', async (t) => {
    const hidden = new Map();
    t.mock.method(HiddenChat, 'findAll', async ({ where }) =>
        [...hidden.values()].filter((r) => String(r.userId) === String(where.userId))
    );
    t.mock.method(HiddenChat, 'upsert', async (row) => hidden.set(`${row.userId}:${row.chatId}`, row));
    t.mock.method(HiddenChat, 'destroy', async ({ where }) => hidden.delete(`${where.userId}:${where.chatId}`));
    const group = { id: '-1', type: 'supergroup', title: 'Group' };
    t.mock.method(Chat, 'findByPk', async (id) => (String(id) === '-1' ? group : null));
    t.mock.method(Chat, 'findAll', async () => [group]);
    const { server, call } = await serve(fakeBot({ '-1': { 7: 'member', 8: 'member' } }));
    t.after(() => server.close());
    const cookie = await signIn(call, '7');
    const other = await signIn(call, '8');
    const save = (id, value, token = cookie) =>
        call('PATCH', `/api/account/chats/${id}/visibility`, { cookie: token, body: { hidden: value } });
    assert.equal((await save('-1', true)).status, 200);
    assert.equal((await save('-1', true)).status, 200, 'idempotent');
    assert.equal(hidden.size, 1);
    const list = await call('GET', '/api/account/chats', { cookie });
    assert.equal(list.status, 200);
    assert.equal(list.body.find((c) => c.id === '-1').hidden, true);
    assert.equal(
        (await call('GET', '/api/account/chats', { cookie: other })).body.find((c) => c.id === '-1').hidden,
        false
    );
    assert.equal((await save('7', true)).status, 400);
    assert.equal((await save('-2', true)).status, 403);
    assert.equal((await save('-1', 'yes')).status, 400);
    assert.equal((await save('-1', true, '')).status, 401);
    assert.equal((await save('-1', false)).status, 200);
    assert.equal(hidden.size, 0);
});

async function serve(bot, { trustLoopback = false } = {}) {
    members.useBot(bot);
    const app = express();
    if (trustLoopback) app.set('trust proxy', 'loopback');
    app.set('bot', bot);
    app.use('/api', panelOnly);
    app.use('/api', guard);
    app.use(express.json());
    app.use(require('../../src/account/routes').router);
    app.use(require('../../src/admin/routes/access'));
    app.get('/api/stats', (req, res) => res.json({ admin: true }));
    app.get('/api/poster/w185/test.jpg', (req, res) => res.sendStatus(204));
    // eslint-disable-next-line no-unused-vars
    app.use('/api', (err, req, res, next) => res.status(err.status || 500).json({ error: 'Bad request' }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, path, { body, cookie, device, raw, address, https } = {}) =>
        fetch(`${base}${path}`, {
            method,
            headers: {
                'X-Requested-By': 'notfckbot-panel',
                ...(https ? { 'X-Forwarded-Proto': 'https' } : {}),
                ...(address ? { 'X-Forwarded-For': address } : {}),
                ...(cookie || device
                    ? {
                          Cookie: [cookie && `nfb_session=${cookie}`, device && `nfb_device=${device}`]
                              .filter(Boolean)
                              .join('; ')
                      }
                    : {}),
                ...(body || raw ? { 'Content-Type': 'application/json' } : {})
            },
            body: raw || (body ? JSON.stringify(body) : undefined)
        }).then(async (res) => ({
            status: res.status,
            headers: res.headers,
            body: await res.json().catch(() => null)
        }));
    return { server, call };
}

async function signIn(call, userId) {
    const token = tokenOf(await auth.createLink({ id: userId, name: `@u${userId}` }));
    const res = await call('POST', '/api/login', { body: { token } });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    return /nfb_session=([^;]+)/.exec(cookie)[1];
}

test('Mini App sign-in checks HTTPS, signature, freshness and the panel role', async (t) => {
    const used = new Set();
    t.mock.method(MiniAppLaunch, 'create', async ({ id }) => {
        if (used.has(id)) throw new UniqueConstraintError();
        used.add(id);
    });
    t.mock.method(MiniAppLaunch, 'destroy', async () => 0);
    const token = 'miniapp-test-token';
    const { server, call } = await serve({ telegram: { token } }, { trustLoopback: true });
    t.after(() => server.close());
    const data = (id, authDate = Math.floor(Date.now() / 1000)) => {
        const user = JSON.stringify({ id, first_name: 'Test' });
        const key = createHmac('sha256', 'WebAppData').update(token).digest();
        const hash = createHmac('sha256', key).update(`auth_date=${authDate}\nuser=${user}`).digest('hex');
        return new URLSearchParams({ user, auth_date: String(authDate), hash }).toString();
    };
    const login = (initData, options = { https: true }) =>
        call('POST', '/api/login/miniapp', { body: { initData }, ...options });
    const valid = data(7);
    assert.equal((await login(valid, {})).status, 403);
    assert.equal((await login(valid.replace('%3A7', '%3A42'))).status, 401);
    assert.equal((await login(`${valid}&auth_date=0`)).status, 401);
    assert.equal((await login(data(7, 1))).status, 401);
    assert.equal((await login(data(0))).status, 401);
    assert.equal((await login(data(123))).status, 403);
    const concurrent = await Promise.all([login(valid), login(valid)]);
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 401]);
    const response = concurrent.find((r) => r.status === 200);
    assert.equal(response.status, 200);
    const cookieHeader = response.headers.get('set-cookie');
    assert.match(cookieHeader, /HttpOnly.*Secure/);
    const cookie = /nfb_session=([^;]+)/.exec(cookieHeader)[1];
    assert.equal((await call('GET', '/api/stats', { cookie })).status, 403);
    const mismatch = await login(data(42), { https: true, cookie });
    assert.equal(mismatch.status, 409);
    assert.doesNotMatch(String(mismatch.headers.get('set-cookie')), /nfb_session=/);
    const same = await login(valid, { https: true, cookie });
    assert.equal(same.status, 200);
    assert.doesNotMatch(String(same.headers.get('set-cookie')), /nfb_session=/);
    await call('POST', '/api/logout', { cookie });
    assert.equal((await login(valid)).status, 401);
    const known = data(7, Math.floor(Date.now() / 1000) - 10);
    const otherCookie = await signIn(call, '7');
    assert.equal((await login(known, { https: true, cookie: otherCookie })).status, 200);
    assert.equal((await login(known)).status, 401);
});

test('Mini App sign-in names the chat it was opened from', async (t) => {
    t.mock.method(MiniAppLaunch, 'create', async () => {});
    t.mock.method(MiniAppLaunch, 'destroy', async () => 0);
    const lookups = [];
    t.mock.method(Chat, 'findOne', async ({ where }) => {
        lookups.push(where);
        return where.chat_instance === '-555' ? { id: -100123 } : null;
    });
    const token = 'miniapp-test-token';
    const { server, call } = await serve({ telegram: { token } }, { trustLoopback: true });
    t.after(() => server.close());
    const data = (extra) => {
        const fields = {
            auth_date: String(Math.floor(Date.now() / 1000)),
            user: '{"id":7,"first_name":"T"}',
            ...extra
        };
        const check = Object.keys(fields)
            .sort()
            .map((k) => `${k}=${fields[k]}`)
            .join('\n');
        const key = createHmac('sha256', 'WebAppData').update(token).digest();
        const hash = createHmac('sha256', key).update(check).digest('hex');
        return new URLSearchParams({ ...fields, hash }).toString();
    };
    const chatOf = async (extra) => {
        const res = await call('POST', '/api/login/miniapp', { body: { initData: data(extra) }, https: true });
        assert.equal(res.status, 200);
        return res.body.chatId;
    };
    assert.equal(await chatOf({ start_param: 'c-100777', chat_instance: '-555' }), '-100777');
    assert.equal(await chatOf({ chat_type: 'supergroup', chat_instance: '-555' }), '-100123');
    assert.equal(await chatOf({ chat_type: 'group', chat_instance: '-999' }), null);
    assert.equal(await chatOf({ start_param: 'other', chat_instance: 'x' }), null);
    assert.equal(await chatOf({}), null);
    assert.deepEqual(lookups, [{ chat_instance: '-555' }, { chat_instance: '-999' }]);
});

test('poster images need a session and work for users without the request marker', async (t) => {
    const { server, call } = await serve(fakeBot({}));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/api/poster/w185/test.jpg`;
    assert.equal((await fetch(url)).status, 401);
    const cookie = await signIn(call, '7');
    assert.equal((await fetch(url, { headers: { Cookie: `nfb_session=${cookie}` } })).status, 204);
});

test('the API: a session for everything but signing in; the panel itself for admins only', async (t) => {
    const { server, call } = await serve(fakeBot({}));
    t.after(() => server.close());
    t.mock.method(Chat, 'findByPk', async () => null);
    t.mock.method(Chat, 'findAll', async () => []);
    assert.equal((await call('GET', '/api/stats')).status, 401);
    assert.equal((await call('GET', '/api/account/me')).status, 401);
    assert.equal((await call('POST', '/api/login', { body: { token: 'x'.repeat(43) } })).status, 401);
    const broken = await call('POST', '/api/login', { raw: '{"token":' });
    assert.deepEqual([broken.status, broken.body], [400, { error: 'Bad request' }], 'no page with the stack');

    const user = await signIn(call, 7);
    assert.equal((await call('GET', '/api/stats', { cookie: user })).status, 403);
    const me = await call('GET', '/api/account/me', { cookie: user });
    assert.deepEqual(me.body.user, {
        id: '7',
        name: '@u7',
        role: 'user',
        hasPassword: false,
        passwordChangedAt: null,
        system: false
    });
    assert.deepEqual((await call('GET', '/api/account/chats', { cookie: user })).body, []);

    const admin = await signIn(call, 42);
    assert.equal((await call('GET', '/api/stats', { cookie: admin })).status, 200);
    assert.equal((await call('POST', '/api/logout', { cookie: admin })).status, 200);
    assert.equal((await call('GET', '/api/stats', { cookie: admin })).status, 401, 'signed out');
});

test('the public panel trusts HTTPS and client IP only from its configured proxy', async (t) => {
    t.mock.method(require('../../src/admin/posters'), 'sweepPosters', async () => 0);
    t.mock.method(require('../../src/chat-changes'), 'sweepChanges', async () => 0);
    const { app, startAdminServer } = require('../../src/admin');
    const listen = app.listen.bind(app);
    const server = listen(0, '127.0.0.1');
    t.after(() => server.close());
    t.mock.method(app, 'listen', () => server);
    const proxyIp = process.env.PANEL_PROXY_IP;
    t.after(() => {
        if (proxyIp === undefined) delete process.env.PANEL_PROXY_IP;
        else process.env.PANEL_PROXY_IP = proxyIp;
    });
    process.env.PANEL_PROXY_IP = '127.0.0.1';
    process.env.PANEL_URL = 'https://panel.example.com';
    startAdminServer(fakeBot({}));
    await new Promise((resolve) => server.once('listening', resolve));
    const { resetLimits } = require('../../src/account/routes');
    resetLimits();
    t.after(resetLimits);

    const send = (method, route, body, headers = {}) =>
        new Promise((resolve, reject) => {
            const request = http.request(
                `http://127.0.0.1:${server.address().port}${route}`,
                {
                    method,
                    headers: {
                        Host: 'panel.example.com',
                        Origin: 'https://panel.example.com',
                        'Content-Type': 'application/json',
                        'X-Requested-By': 'notfckbot-panel',
                        'X-Forwarded-Proto': 'https',
                        'X-Forwarded-For': '203.0.113.10',
                        ...headers
                    }
                },
                (res) => {
                    res.resume();
                    res.on('error', reject);
                    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
                }
            );
            request.on('error', reject);
            request.end(JSON.stringify(body));
        });
    const post = (route, body, headers) => send('POST', `/api/login${route}`, body, headers);

    const landing = await send('GET', '/');
    assert.equal(landing.status, 200);
    assert.equal(landing.headers['content-security-policy'], "frame-ancestors 'self' https://web.telegram.org");
    assert.equal(landing.headers['x-content-type-options'], 'nosniff');

    const token = tokenOf(await auth.createLink({ id: 7 }));
    assert.equal((await post('', { token }, { Host: 'other.example.com' })).status, 403);
    assert.equal((await post('', { token }, { Origin: 'http://panel.example.com' })).status, 403);
    app.set('trust proxy', '127.0.0.2');
    assert.equal((await post('', { token })).status, 403);
    app.set('trust proxy', '127.0.0.1');
    const login = await post('', { token });
    assert.equal(login.status, 200);
    assert.match(login.headers['set-cookie'][0], /; Secure\b/);

    const body = { login: '7', password: 'wrong-one' };
    for (let i = 0; i < 5; i++) assert.equal((await post('/password', body)).status, 401);
    assert.equal((await post('/password', body)).status, 429);
    assert.equal((await post('/password', body, { 'X-Forwarded-For': '203.0.113.11' })).status, 401);
});

test('the API: the Telegram code goes with the bot link; the poll lets in the confirmed page', async (t) => {
    const { server, call } = await serve(fakeBot({}));
    t.after(() => server.close());
    const start = await call('POST', '/api/login/telegram');
    assert.match(start.body.url, /^https:\/\/t\.me\/notfckbot\?start=L[A-Za-z0-9_-]{32}$/);
    assert.equal(start.body.url.endsWith(start.body.code), true);
    assert.match(start.body.qr, /^data:image\/png;base64,/);
    assert.ok(start.body.qr.length > 200);
    assert.ok(!start.body.url.includes(start.body.secret), 'QR target never contains the browser secret');
    const poll = () =>
        call('POST', '/api/login/telegram/poll', { body: { code: start.body.code, secret: start.body.secret } });
    assert.equal((await poll()).body.state, 'waiting');
    await auth.answerCode(start.body.code, { id: 42 }, true);
    const done = await poll();
    assert.equal(done.body.state, 'in');
    assert.match(done.headers.get('set-cookie'), /nfb_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly/);
});

test('the API: only deliberate activity renews the server deadline; cookie persistence alone grants nothing', async (t) => {
    const { server, call } = await serve(fakeBot({}));
    t.after(() => server.close());
    const token = await auth.startSession({ userId: 7 }, Date.now() - 86400000);
    const row = [...sessions.values()][0];
    const before = Number(row.expiresAt);
    const read = await call('GET', '/api/account/me', { cookie: token });
    assert.equal(Number(row.expiresAt), before);
    assert.match(read.headers.get('set-cookie'), /Max-Age=31536000/);
    assert.equal((await call('POST', '/api/account/activity', { cookie: token })).status, 200);
    assert.ok(Number(row.expiresAt) > before);
    row.expiresAt = new Date(Date.now() - 1);
    assert.equal((await call('POST', '/api/account/activity', { cookie: token })).status, 401);
    assert.equal(Number(row.expiresAt) < Date.now(), true);
    const headers = {};
    auth.setCookie(
        { secure: true, headers: {} },
        {
            setHeader: (key, value) => {
                headers[key] = value;
            }
        },
        token
    );
    assert.match(headers['Set-Cookie'], /HttpOnly; SameSite=Lax; Max-Age=31536000; Secure/);
});

test('the API: undeliverable confirmation creates no session and repeated correct passwords cannot spam the bot', async (t) => {
    require('../../src/account/routes').resetLimits();
    t.mock.method(Chat, 'findByPk', async () => null);
    await password.setPassword('7', 'secret-pass');
    const bot = fakeBot({});
    let sends = 0;
    bot.telegram.sendMessage = async () => {
        sends += 1;
        throw Object.assign(new Error('bad request'), { response: { error_code: 400 } });
    };
    const { server, call } = await serve(bot);
    t.after(() => server.close());
    const login = () => call('POST', '/api/login/password', { body: { login: '7', password: 'secret-pass' } });
    const failed = await login();
    assert.equal(failed.status, 503);
    assert.doesNotMatch(String(failed.headers.get('set-cookie')), /nfb_session=/);
    assert.equal(sessions.size, 0);
    assert.equal((await login()).status, 429);
    assert.equal(sends, 1);
});

test("the API: a chat the user isn't in is closed; a member can't change a group's settings", async (t) => {
    const sent = [];
    const { server, call } = await serve(fakeBot({ '-1': { 42: 'administrator', 7: 'member' } }, sent));
    t.after(() => server.close());
    let updated = null;
    const chat = {
        id: -1,
        type: 'supergroup',
        quiet_start: null,
        quiet_end: null,
        timezone: 'Europe/Moscow',
        digest_week: false,
        get: () => ({}),
        update: async (changes) => {
            updated = changes;
            Object.assign(chat, changes);
        }
    };
    t.mock.method(Chat, 'findByPk', async () => chat);
    t.mock.method(Subscription, 'findAll', async () => []);
    t.mock.method(Watchlist, 'findAll', async () => []);

    const member = await signIn(call, 7);
    assert.equal((await call('GET', '/api/account/chats/-5/list', { cookie: member })).status, 403);
    assert.equal((await call('GET', '/api/account/chats/42/list', { cookie: member })).status, 403, 'another user');
    assert.equal((await call('GET', '/api/account/chats/-1/list', { cookie: member })).status, 200);
    const refused = await call('PATCH', '/api/account/chats/-1/settings', {
        cookie: member,
        body: { digest_week: true }
    });
    assert.equal(refused.status, 403);
    assert.equal(updated, null);

    const admin = await signIn(call, 42);
    const bad = await call('PATCH', '/api/account/chats/-1/settings', { cookie: admin, body: { quiet_start: 3 } });
    assert.equal(bad.status, 400);
    const ok = await call('PATCH', '/api/account/chats/-1/settings', {
        cookie: admin,
        body: { quiet_start: 23, quiet_end: 9 }
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(updated, { quiet_start: 23, quiet_end: 9 });
    // The group is told who changed what, and from what to what
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, '-1');
    assert.equal(sent[0].text, '⚙️ @u42 изменил(а) настройки:\nТихие часы: выключены → 23:00–09:00');

    await call('PATCH', '/api/account/chats/-1/settings', {
        cookie: admin,
        body: { timezone: 'Asia/Omsk', digest_week: true }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
        sent[1].text,
        '⚙️ @u42 изменил(а) настройки:\nЧасовой пояс: Москва (UTC+3) → Омск (UTC+6)\n' +
            'Сводка недели: выключена → по понедельникам в 10:00'
    );
    // Nothing really changed: nothing to tell
    await call('PATCH', '/api/account/chats/-1/settings', { cookie: admin, body: { timezone: 'Asia/Omsk' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.length, 2);
    // The change log is the panel admins' only, even for a group's admin
    assert.equal((await call('GET', '/api/account/chats/-1/changes', { cookie: admin })).status, 404);
});

test('the API: a film is removed only from the chat in the path', async (t) => {
    const { server, call } = await serve(fakeBot({}));
    t.after(() => server.close());
    let destroyed = false;
    t.mock.method(Watchlist, 'findByPk', async () => ({
        chatId: 999,
        tmdb_id: 'movie_1',
        title: 'X',
        destroy: async () => {
            destroyed = true;
        }
    }));
    const cookie = await signIn(call, 42);
    const res = await call('DELETE', '/api/account/chats/42/films/5', { cookie });
    assert.deepEqual(res.body, { removed: false });
    assert.equal(destroyed, false);
});

test('the API: Following films use cached Kinopoisk ids and IMDb context without waiting for services', async (t) => {
    const tmdb = require('../../src/api/tmdb');
    const kp = require('../../src/api/kinopoisk');
    const { server, call } = await serve(fakeBot({}));
    t.after(() => server.close());
    t.mock.method(Chat, 'findByPk', async () => ({ type: 'private' }));
    t.mock.method(Subscription, 'findAll', async () => []);
    t.mock.method(Watchlist, 'findAll', async () => [{ id: 1, tmdb_id: 'movie_9', title: 'Film' }]);
    t.mock.method(tmdb, 'peekDetails', () => ({ imdb_id: 'tt123' }));
    const lookups = [];
    t.mock.method(kp, 'knownKinopoiskId', (id, imdb) => {
        lookups.push([id, imdb]);
        return 12464471;
    });
    const cookie = await signIn(call, 7);
    const response = await call('GET', '/api/account/chats/7/list', { cookie });
    assert.equal(response.status, 200);
    assert.deepEqual(lookups, [['movie_9', 'tt123']]);
    assert.equal(response.body.films[0].links[1].url, 'https://www.kinopoisk.ru/film/12464471/');
});

test('the API: Aired is scoped to an accessible chat and validates its year', async (t) => {
    t.mock.method(require('../../src/api/tmdb'), 'peekDetails', () => {
        throw new Error('History already contains shared display metadata');
    });
    const { server, call } = await serve(fakeBot({ '-1': { 7: 'member' } }));
    t.after(() => server.close());
    t.mock.method(Chat, 'findByPk', async () => ({ type: 'supergroup' }));
    const requests = [];
    t.mock.method(require('../../src/history'), 'releaseHistory', async (options) => {
        requests.push(options);
        return {
            years: [2026],
            year: 2026,
            series: [],
            films: [
                {
                    tmdbId: 'movie_1',
                    poster: 'https://image.tmdb.org/t/p/w500/poster.jpg',
                    overview: 'Released title description',
                    rating: 8.2,
                    links: [{ kind: 'watch', label: 'Смотреть', url: 'https://www.sspoisk.ru/film/9/' }]
                }
            ]
        };
    });
    const cookie = await signIn(call, 7);
    const response = await call('GET', '/api/account/chats/-1/aired?year=2026', { cookie });
    assert.equal(response.status, 200);
    assert.equal(response.body.films[0].overview, 'Released title description');
    assert.equal(response.body.films[0].rating, 8.2);
    assert.equal(response.body.films[0].poster, '/poster.jpg');
    assert.equal(response.body.films[0].links[0].label, 'Watch on SSPoisk');
    assert.deepEqual(requests, [{ chatId: '-1', year: 2026 }]);
    assert.equal((await call('GET', '/api/account/chats/-2/aired', { cookie })).status, 403);
    assert.equal((await call('GET', '/api/account/chats/-1/aired?year=oops', { cookie })).status, 400);
    assert.equal((await call('GET', '/api/account/chats/-1/aired')).status, 401);
    assert.equal(requests.length, 1);
});

test('calendar unfollow removes old and waiting rows of the film only in the chosen chat', async (t) => {
    const { server, call } = await serve(fakeBot({}));
    t.after(() => server.close());
    let rows = [
        { id: 11, chatId: '7', tmdb_id: 'movie_1', title: 'Film', notified: true },
        { id: 12, chatId: '7', tmdb_id: 'movie_1', title: 'Film', notified: false },
        { id: 13, chatId: '8', tmdb_id: 'movie_1', title: 'Film', notified: false }
    ];
    t.mock.method(Watchlist, 'findByPk', async (id) => {
        const row = rows.find((row) => row.id === Number(id));
        return (
            row && {
                ...row,
                destroy: async () => {
                    rows = rows.filter((other) => other.id !== row.id);
                }
            }
        );
    });
    t.mock.method(Watchlist, 'destroy', async ({ where }) => {
        assert.deepEqual(where, { chatId: '7', tmdb_id: 'movie_1' });
        rows = rows.filter((row) => row.chatId !== where.chatId || row.tmdb_id !== where.tmdb_id);
        return 2;
    });
    const cookie = await signIn(call, 7);
    const response = await call('DELETE', '/api/account/chats/7/films/11', { cookie });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { removed: true });
    assert.deepEqual(
        rows.map((row) => row.id),
        [13],
        'the active row is gone and another chat keeps its subscription'
    );
});

// --- The bot ---

test('the API: calendar includes cached film metadata and tolerates a cache miss without external requests', async (t) => {
    const tmdb = require('../../src/api/tmdb');
    const { server, call } = await serve(fakeBot({}));
    t.after(() => server.close());
    t.mock.method(Chat, 'findByPk', async () => ({ type: 'private', timezone: 'Europe/Moscow' }));
    t.mock.method(Subscription, 'findAll', async () => []);
    t.mock.method(Watchlist, 'findAll', async () => [
        { id: 101, tmdb_id: 'movie_10', title: 'With metadata', premiere_digital: '2099-12-30' },
        { id: 102, tmdb_id: 'movie_11', title: 'Without metadata', premiere_digital: '2099-12-31' }
    ]);
    const peeks = [];
    t.mock.method(tmdb, 'peekDetails', (id, kind) => {
        peeks.push([id, kind]);
        return id === '10' ? { overview: 'A film description.', vote_average: 7.6 } : undefined;
    });
    const cookie = await signIn(call, 7);
    const response = await call('GET', '/api/account/chats/7/calendar', { cookie });
    assert.equal(response.status, 200);
    assert.deepEqual(peeks, [
        ['10', 'movie'],
        ['11', 'movie']
    ]);
    assert.deepEqual(
        response.body.items.map(({ overview, rating }) => ({ overview, rating })),
        [
            { overview: 'A film description.', rating: 7.6 },
            { overview: '', rating: null }
        ]
    );
    assert.equal((await call('GET', '/api/account/chats/8/calendar', { cookie })).status, 403);
    assert.equal((await call('GET', '/api/account/chats/7/calendar')).status, 401);
    assert.equal(peeks.length, 2, 'access checks still run before metadata is read');
    assert.deepEqual(
        response.body.items.map((item) => item.listId),
        [101, 102],
        'calendar carries chat watchlist ids for complete unfollow'
    );
    const list = await call('GET', '/api/account/chats/7/list', { cookie });
    assert.equal(list.status, 200);
    assert.match(list.body.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(list.body.films[0].rating, response.body.items[0].rating);
    assert.equal(list.body.films[0].overview, response.body.items[0].overview);
});

function botHandlers() {
    const handlers = { commands: {}, actions: [], on: {} };
    require('../../src/bot/login').register({
        command: (name, fn) => (handlers.commands[name] = fn),
        action: (re, fn) => handlers.actions.push([re, fn]),
        on: (event, fn) => (handlers.on[event] = fn)
    });
    return handlers;
}

test('sign-in digits are unique among live codes and sign the page in from the bot without a question', async () => {
    const starts = Array.from({ length: 300 }, () => auth.startCode());
    assert.equal(new Set(starts.map((s) => s.check)).size, starts.length, 'no two live codes share the digits');
    for (const s of starts) auth.cancelCode(s.code, s.secret);

    // Digits of a page just closed aren't given out again: sent late, they can't sign a stranger's page in
    const freed = new Set(starts.map((s) => s.check));
    assert.equal(
        Array.from({ length: 300 }, () => auth.startCode()).some((s) => freed.has(s.check)),
        false
    );

    const start = auth.startCode(null, null, Date.now(), 'Safari, iPhone');
    assert.match(start.check, /^\d{6}$/);
    assert.equal(auth.checkWord(start.code), start.check, 'the bot question shows the same digits');
    assert.deepEqual(await auth.answerCheck(start.check, { id: 99 }), { state: 'closed' });
    const answer = await auth.answerCheck(start.check, { id: 7, name: '@u7' });
    assert.equal(answer.state, 'in');
    assert.equal(answer.device, 'Safari, iPhone');
    assert.match(answer.claim, /^[A-Za-z0-9_-]{22}$/);
    const result = await auth.pollCode(start.code, start.secret);
    assert.equal(result.state, 'in');
    const req = { headers: { cookie: `nfb_session=${result.token}` } };
    assert.equal((await auth.sessionOf(req)).userId, '7');
    assert.deepEqual(await auth.answerCheck(start.check, { id: 7 }), { state: 'again' }, 'sent twice: not a miss');
    assert.equal((await auth.answerCheck(start.check, { id: 8 })).state, 'wrong', 'used up for anyone else');

    // "Это не я": only the sender, and it ends the session the digits made
    assert.equal(await auth.denyClaim(answer.claim, 8), false);
    assert.equal(await auth.denyClaim(answer.claim, 7), true);
    assert.equal(await auth.sessionOf(req), null);
    assert.equal(await auth.denyClaim(answer.claim, 7), false, 'once');
});

test('"Это не я" before the page has its session: the page is told the sign-in was cancelled', async (t) => {
    const start = auth.startCode();
    const { claim } = await auth.answerCheck(start.check, { id: 7 });
    assert.equal(await auth.denyClaim(claim, 7), true);
    assert.deepEqual(await auth.pollCode(start.code, start.secret), { state: 'refused' });
    assert.equal(sessions.size, 0);

    // Pressed while the page's poll checks access (a password sign-in then reads the password too):
    // the page is told it was cancelled, not an error
    t.mock.method(Chat, 'findByPk', async () => null);
    await password.setPassword('7', 'secret-pass');
    const checking = await password.signInWithPassword('7', 'secret-pass');
    const pending = await auth.answerCheck(checking.check, { id: 7 });
    const findRole = PanelRole.findByPk;
    PanelRole.findByPk = async (...args) => {
        await auth.denyClaim(pending.claim, 7);
        return findRole.apply(PanelRole, args);
    };
    try {
        assert.deepEqual(await auth.pollCode(checking.code, checking.secret), { state: 'refused' });
    } finally {
        PanelRole.findByPk = findRole;
    }
    assert.equal(sessions.size, 0);

    // Pressed while the page's poll is creating the session: that session is ended at once
    const racing = auth.startCode();
    const second = await auth.answerCheck(racing.check, { id: 7 });
    const create = AccountSession.create;
    AccountSession.create = async (row) => {
        await auth.denyClaim(second.claim, 7);
        return create.call(AccountSession, row);
    };
    try {
        assert.deepEqual(await auth.pollCode(racing.code, racing.secret), { state: 'refused' });
    } finally {
        AccountSession.create = create;
    }
    assert.equal(sessions.size, 0);
});

test('sign-in digits: a password sign-in takes only its own account; wrong tries pause 1, 5, then 15 minutes', async (t) => {
    t.mock.method(Chat, 'findByPk', async () => null);
    await password.setPassword('7', 'secret-pass');
    panelRoles.set('7', 'user');
    panelRoles.set('8', 'user');
    panelRoles.set('9', 'user');
    const bound = await password.signInWithPassword('7', 'secret-pass');
    assert.equal((await auth.answerCheck(bound.check, { id: 8 })).state, 'wrong', 'another account');
    assert.equal(auth.isWaiting(bound.code), true);
    assert.equal((await auth.answerCheck(bound.check, { id: 7 })).state, 'in');

    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const later = (min) => (now += min * 60000 + 1000);
    const live = auth.startCode();
    const other = live.check === '000000' ? '000001' : '000000';
    const states = [];
    for (let i = 0; i < 5; i += 1) states.push(await auth.answerCheck(other, { id: 9 }));
    assert.deepEqual(states, [
        { state: 'wrong', left: 4 },
        { state: 'wrong', left: 3 },
        { state: 'wrong', left: 2 },
        { state: 'wrong', left: 1 },
        { state: 'paused', minutes: 1 }
    ]);
    assert.deepEqual(
        await auth.answerCheck(live.check, { id: 9 }),
        { state: 'paused', minutes: 1 },
        'even the right digits'
    );
    assert.equal(auth.isWaiting(live.code), true);
    // Like an iPhone: each miss after the pause pauses longer, and 15 minutes stays the longest
    later(1);
    assert.deepEqual(await auth.answerCheck(other, { id: 9 }), { state: 'paused', minutes: 5 });
    later(5);
    assert.deepEqual(await auth.answerCheck(other, { id: 9 }), { state: 'paused', minutes: 15 });
    now += 60000;
    assert.deepEqual(await auth.answerCheck(other, { id: 9 }), { state: 'paused', minutes: 14 });
    later(15);
    assert.deepEqual(await auth.answerCheck(other, { id: 9 }), { state: 'paused', minutes: 15 });
    later(15);
    const fresh = auth.startCode();
    assert.equal((await auth.answerCheck(fresh.check, { id: 9 })).state, 'in', 'the pause is over');
    // A right code starts over: five tries again before a pause
    assert.deepEqual(await auth.answerCheck(other, { id: 9 }), { state: 'wrong', left: 4 });
});

test('sign-in digits: tries sent at once cannot get past the five-try limit together', async () => {
    panelRoles.set('10', 'user');
    const live = auth.startCode();
    const wrong = live.check === '000000' ? '000001' : '000000';
    const results = await Promise.all(Array.from({ length: 20 }, () => auth.answerCheck(wrong, { id: 10 })));
    assert.equal(results.filter((r) => r.state === 'wrong').length, 4);
    assert.equal(results.filter((r) => r.state === 'paused').length, 16);
    assert.deepEqual(await auth.answerCheck(live.check, { id: 10 }), { state: 'paused', minutes: 1 });
});

test('/code in the bot: with the digits, or asked for; a group is sent to the private chat', async () => {
    const { commands, actions, on } = botHandlers();
    const device = {
        deviceId: 'd'.repeat(64),
        name: 'Chrome, Windows',
        ip: '95.24.17.80',
        country: 'RU',
        network: 'Vimpelcom'
    };
    const start = auth.startCode(null, null, Date.now(), device);
    const replies = [];
    const session = {};
    const ctx = (text, chat = { id: 7, type: 'private' }) => ({
        from: { id: 7, username: 'u7' },
        chat,
        message: { text },
        set session(v) {
            session.value = v;
        },
        get session() {
            return session.value;
        },
        reply: async (body) => replies.push(body),
        replyWithHTML: async (body, extra) => {
            replies.push(body);
            extras.push(extra);
        }
    });
    const extras = [];
    await commands.code(ctx(`/code ${start.check}`, { id: -5, type: 'group' }));
    assert.match(replies.pop(), /личном чате/);
    assert.equal(auth.isWaiting(start.code), true);

    await commands.code(ctx('/code'));
    assert.match(replies.pop(), /Пришлите 6 цифр/);
    let passed = false;
    await on.text(ctx('12'), () => (passed = true));
    assert.equal(passed, false, 'digits are a try');
    assert.match(replies.pop(), /Код не подошёл[\s\S]*Осталось попыток: 4/);
    await on.text(ctx(` ${start.check} `), () => (passed = true));
    assert.equal(
        replies.pop(),
        '✅ <b>Вход выполнен на новом устройстве</b>\nChrome, Windows\nРоссия, Vimpelcom · 95.24.17.80'
    );
    const buttons = extras.pop().reply_markup.inline_keyboard.flat();
    assert.deepEqual(
        buttons.map((b) => b.text),
        ['🚫 Не моё устройство — отменить вход']
    );
    assert.equal(session.value.state, 'idle');
    // "Это не я": the sign-in is cancelled and the reply says so
    const [re, deny] = actions.find(([name]) => String(name).includes('notme'));
    const denied = [];
    await deny({
        match: re.exec(buttons[0].callback_data),
        from: { id: 7 },
        answerCbQuery: async () => {},
        editMessageText: async (text) => denied.push(text)
    });
    assert.match(denied.pop(), /Вход отменён/);
    assert.deepEqual(await auth.pollCode(start.code, start.secret), { state: 'refused' });
    await on.text(ctx('Дюна'), () => (passed = true));
    assert.equal(passed, true, 'not waiting any more: a search goes on');

    const next = auth.startCode();
    await commands.code(ctx(`/code ${next.check}`));
    const plain = replies.pop();
    assert.equal(plain, '✅ <b>Вход выполнен на новом устройстве</b>', 'no device known: no device lines');
    // "Это не я" forgot the denied browser
    assert.equal(deviceRows.length, 0);

    // From ⚙️ Настройки → 🔑 Вход по коду
    const [, press] = actions.find(([name]) => name === 'login_code');
    const edits = [];
    await press(
        Object.assign(ctx(''), { answerCbQuery: async () => {}, editMessageText: async (text) => edits.push(text) })
    );
    assert.match(edits.pop(), /Вход по коду/);
    assert.equal(session.value.state, 'waiting_for_login_code');
    await on.text(ctx('🔍 Поиск'), () => (passed = 'menu'));
    assert.equal(passed, 'menu', 'a menu button leaves the code screen');
    assert.equal(session.value.state, 'idle');
});

test('⚙️ Настройки: sections in a private chat, the chat settings straight away in a group', async () => {
    const handlers = { commands: {}, hears: {}, actions: {} };
    require('../../src/bot/settings').register({
        command: (name, fn) => (handlers.commands[name] = fn),
        hears: (text, fn) => (handlers.hears[text] = fn),
        action: (name, fn) => (handlers.actions[String(name)] = fn)
    });
    const sent = [];
    const ctx = (chat) => ({
        chat,
        from: { id: 7 },
        state: { chatData: { menu_enabled: true } },
        replyWithHTML: async (text, keyboard) => sent.push({ text, keyboard })
    });
    const buttons = (view) => view.keyboard.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    await handlers.commands.settings(ctx({ id: 7, type: 'private' }));
    let view = sent.pop();
    assert.match(view.text, /^⚙️ <b>Настройки<\/b>$/);
    assert.deepEqual(buttons(view), ['settings_open', 'login_code', 'settings_close']);
    await handlers.commands.settings(ctx({ id: -5, type: 'group' }));
    view = sent.pop();
    assert.match(view.text, /Настройки чата/);
    assert.equal(buttons(view).includes('login_code'), false);
    assert.equal(buttons(view).at(-1), 'settings_close');
});

test('/login is gone from the bot; /app opens a group on its own page, a private chat on the user’s', async () => {
    const { commands } = botHandlers();
    assert.equal(commands.login, undefined);
    const replies = [];
    const ctx = (chat, botInfo = { username: 'nfb', has_main_web_app: true }) => ({
        from: { id: 7 },
        chat,
        botInfo,
        reply: async (text, extra) => replies.push({ text, extra })
    });
    const urlOf = (reply) => reply.extra.reply_markup.inline_keyboard[0][0].url;
    await commands.app(ctx({ id: -100123, type: 'supergroup', title: 'Кино <b>' }));
    let reply = replies.pop();
    assert.equal(urlOf(reply), 'https://t.me/nfb?startapp=c-100123');
    assert.match(reply.text, /Кино &lt;b&gt;/);
    await commands.app(ctx({ id: 7, type: 'private' }));
    assert.equal(urlOf(replies.pop()), 'https://t.me/nfb?startapp');
    await commands.app(ctx({ id: -1, type: 'group' }, { username: 'nfb' }));
    reply = replies.pop();
    assert.equal(reply.extra, undefined);
    assert.match(reply.text, /не настроено/);
});

test('/start L<code>: the bot asks first, and only "Да, это я" lets the page in', async () => {
    const { commands, actions } = botHandlers();
    const { code, secret } = auth.startCode();
    const replies = [];
    let passedOn = false;
    const message = (text, from = { id: 7 }) => ({
        from,
        chat: { id: from.id, type: 'private' },
        message: { text },
        reply: async (body, extra) => replies.push({ body, extra })
    });
    await commands.start(message('/start'), () => (passedOn = true));
    assert.equal(passedOn, true, 'the usual /start goes on to src/bot/commands.js');

    await commands.start(message(`/start L${code}`, { id: 99 }), () => {});
    assert.match(replies.pop().body, /закрытом тесте/);
    await commands.start(message(`/start L${code}`), () => {});
    const ask = replies.pop();
    assert.match(ask.body, /Войти в панель/);
    // The same six digits as the sign-in page shows: a link sent by someone else shows other digits
    assert.match(ask.body, new RegExp(`Проверочный код: <b>${auth.checkWord(code)}</b>`));
    const buttons = ask.extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.deepEqual(buttons, [`login_ok_${code}`, `login_no_${code}`]);
    assert.deepEqual(await auth.pollCode(code, secret), { state: 'waiting' }, 'nothing yet');

    const [re, press] = actions[0];
    const edits = [];
    await press({
        match: re.exec(`login_ok_${code}`),
        from: { id: 7, username: 'u7' },
        answerCbQuery: async () => {},
        editMessageText: async (text) => edits.push(text)
    });
    assert.match(edits[0], /Готово/);
    assert.equal((await auth.pollCode(code, secret)).state, 'in');
});

// --- Passwords ---

test('a password: only a salted scrypt hash is stored; the same password hashes differently', async () => {
    const one = await password.hashPassword('correct horse');
    const two = await password.hashPassword('correct horse');
    assert.match(one, /^scrypt:16384:8:1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/);
    // The first hashes (31.10) had "$" between the parts
    assert.equal(await password.matches('correct horse', one.replaceAll(':', '$')), true);
    assert.notEqual(one, two);
    assert.equal(one.includes('correct horse'), false);
    assert.equal(await password.matches('correct horse', one), true);
    assert.equal(await password.matches('correct hors', one), false);
    assert.equal(await password.matches('x', 'garbage'), false);
});

test('signing in with a password: by id or @username, only for people still on the lists', async (t) => {
    const { resetLimits } = require('../../src/account/routes');
    resetLimits();
    t.after(resetLimits);
    t.mock.method(Chat, 'findAll', async ({ where }) => (where.username === '@kirill' ? [{ id: 7 }] : []));
    t.mock.method(Chat, 'findByPk', async () => ({ username: '@Kirill' }));
    await password.setPassword('7', 'secret-pass');
    for (const login of ['7', '@kirill', 'Kirill', ' @KIRILL ']) {
        const pending = await password.signInWithPassword(login, 'secret-pass');
        assert.ok(pending, login);
        assert.equal(pending.token, undefined, 'a password is not a session');
        assert.deepEqual(await auth.pollCode(pending.code, pending.secret), { state: 'waiting' });
        assert.equal(await auth.answerCode(pending.code, { id: 8 }, true), false, 'another account cannot approve');
        await auth.answerCode(pending.code, { id: 7, name: '@Kirill' }, true);
        const session = await auth.pollCode(pending.code, pending.secret);
        const signed = await auth.sessionOf({ headers: { cookie: `nfb_session=${session.token}` } });
        assert.deepEqual([signed.userId, signed.role, signed.userName], ['7', 'user', '@Kirill']);
    }
    assert.equal(await password.signInWithPassword('7', 'wrong-pass'), null);
    assert.equal(await password.signInWithPassword('@nobody', 'secret-pass'), null);
    assert.equal(await password.signInWithPassword('8', 'secret-pass'), null, 'no password set');
    assert.equal(await password.signInWithPassword('first name', 'secret-pass'), null, 'only @usernames');
    panelRoles.set('7', 'none');
    t.mock.method(Chat, 'findOne', async ({ where }) =>
        where.id === '7' && where.type === 'private' ? { id: 7 } : null
    );
    const { server, call } = await serve(fakeBot());
    t.after(() => server.close());
    const login = (who, pass = 'secret-pass') =>
        call('POST', '/api/login/password', { body: { login: who, password: pass } });
    assert.deepEqual((await login('7', 'wrong-pass')).body, (await login('999')).body);
    for (const who of ['7', '@Kirill']) {
        const denied = await login(who);
        assert.deepEqual([denied.status, denied.body.error], [403, 'No access to the panel.']);
        assert.doesNotMatch(String(denied.headers.get('set-cookie')), /nfb_session=/);
    }
    assert.equal((await login('999')).status, 401, 'unknown numeric ID');
    panelRoles.set('7', 'user');
    assert.equal(await password.removePassword('7'), true);
    assert.equal(await password.signInWithPassword('7', 'secret-pass'), null, 'removed');
});

/** Waits for the bot's messages sent without being waited for (a second at most). */
async function sentCount(sent, n) {
    for (let i = 0; i < 100 && sent.length < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    return sent.length;
}

test('the API: signing out on other devices keeps this one', async (t) => {
    const { server, call } = await serve(fakeBot({}));
    t.after(() => server.close());
    const user = await signIn(call, 8);
    const other = await signIn(call, 8);
    const stranger = await signIn(call, 7);
    assert.equal((await call('POST', '/api/account/sessions/end-others')).status, 401);
    const ended = await call('POST', '/api/account/sessions/end-others', { cookie: user });
    assert.deepEqual([ended.status, ended.body], [200, { ended: 1 }]);
    assert.equal((await call('GET', '/api/account/me', { cookie: other })).status, 401);
    assert.equal((await call('GET', '/api/account/me', { cookie: user })).status, 200, 'this device stays in');
    assert.equal((await call('GET', '/api/account/me', { cookie: stranger })).status, 200, "someone else's stays in");
});

test('the API: set, use and remove a password; wrong tries stop at the limit', async (t) => {
    const sent = [];
    const { server, call } = await serve(fakeBot({}, sent));
    t.after(() => server.close());
    require('../../src/account/routes').resetLimits();
    t.mock.method(Chat, 'findByPk', async () => null);
    t.mock.method(Chat, 'findAll', async () => []);
    const user = await signIn(call, 7);
    const short = await call('PUT', '/api/account/password', { cookie: user, body: { password: 'short' } });
    assert.deepEqual([short.status, short.body.error], [400, 'At least 8 characters']);
    assert.equal((await call('PUT', '/api/account/password', { body: { password: 'long-enough' } })).status, 401);
    const other = await signIn(call, 7);
    const set = await call('PUT', '/api/account/password', { cookie: user, body: { password: 'long-enough' } });
    assert.deepEqual(set.body, { hasPassword: true, passwordChangedAt: '2026-11-02T10:00:00.000Z' });
    const me = (await call('GET', '/api/account/me', { cookie: user })).body.user;
    assert.deepEqual([me.hasPassword, me.passwordChangedAt], [true, '2026-11-02T10:00:00.000Z']);
    assert.equal(await sentCount(sent, 1), 1);
    assert.equal(sent[0].chatId, '7');
    assert.match(sent[0].text, /задан пароль/);
    assert.equal(
        (await call('GET', '/api/account/me', { cookie: other })).status,
        200,
        'a first password signs out nobody'
    );

    // A change: the bot says so, and the other device is signed out
    await call('PUT', '/api/account/password', { cookie: user, body: { password: 'long-enough' } });
    assert.equal(await sentCount(sent, 2), 2);
    assert.match(sent[1].text, /изменён/);
    assert.equal((await call('GET', '/api/account/me', { cookie: other })).status, 401);
    assert.equal((await call('GET', '/api/account/me', { cookie: user })).status, 200, 'this device stays in');

    const login = (pass, who = '7') => call('POST', '/api/login/password', { body: { login: who, password: pass } });
    const ok = await login('long-enough');
    assert.equal(ok.status, 200);
    assert.doesNotMatch(String(ok.headers.get('set-cookie')), /nfb_session=/, 'no session before bot confirmation');
    assert.equal(ok.body.confirmation, true);
    await auth.answerCode(ok.body.code, { id: 7 }, true);
    const approved = await call('POST', '/api/login/telegram/poll', {
        body: { code: ok.body.code, secret: ok.body.secret }
    });
    assert.match(approved.headers.get('set-cookie'), /nfb_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly/);
    ok.cookie = /nfb_session=([^;]+)/.exec(approved.headers.get('set-cookie'))[1];
    assert.equal((await login('')).status, 400);
    for (let i = 0; i < 4; i += 1) {
        const wrong = await login('wrong-one');
        assert.deepEqual([wrong.status, wrong.body.error], [401, 'Wrong username or password.']);
    }
    const blocked = await login('long-enough');
    assert.deepEqual([blocked.status, blocked.body.error], [429, 'Too many attempts. Try again in 15 minutes.']);

    require('../../src/account/routes').resetLimits();
    const before = sent.length;
    assert.equal((await call('DELETE', '/api/account/password', { cookie: user })).status, 200);
    assert.equal(await sentCount(sent, before + 1), before + 1);
    assert.match(sent.at(-1).text, /удалён/);
    assert.equal((await call('GET', '/api/account/me', { cookie: ok.cookie })).status, 401, 'signed out elsewhere');
    assert.equal((await call('GET', '/api/account/me', { cookie: user })).status, 200);
    assert.equal((await login('long-enough')).status, 401, 'removed');
});

test('password sign-in can repeat immediately after logout without bypassing pending confirmation limits', async (t) => {
    const sent = [];
    const { server, call } = await serve(fakeBot({}, sent));
    t.after(() => server.close());
    const { resetLimits } = require('../../src/account/routes');
    resetLimits();
    t.after(resetLimits);
    t.mock.method(Chat, 'findByPk', async () => null);
    await password.setPassword('7', 'long-enough');
    await password.setPassword('8', 'long-enough');
    const login = (userId) => call('POST', '/api/login/password', { body: { login: userId, password: 'long-enough' } });
    const first = await login('7');
    assert.equal(first.status, 200);
    assert.equal((await login('7')).status, 429, 'pending requests stay limited');
    assert.equal((await call('POST', '/api/logout')).status, 401, 'signed-out callers cannot reset the limit');
    assert.equal((await login('7')).status, 429);
    assert.equal((await login('8')).status, 200);
    await auth.answerCode(first.body.code, { id: 7 }, true);
    const approved = await call('POST', '/api/login/telegram/poll', {
        body: { code: first.body.code, secret: first.body.secret }
    });
    const cookie = /nfb_session=([^;]+)/.exec(approved.headers.get('set-cookie'))[1];
    assert.equal((await call('POST', '/api/logout', { cookie })).status, 200);
    assert.equal((await call('GET', '/api/account/me', { cookie })).status, 401);
    const again = await login('7');
    assert.equal(again.status, 200, 'a completed sign-in and logout do not impose a one-minute lockout');
    assert.equal(again.body.confirmation, true, 'the next login still needs Telegram approval');
    assert.doesNotMatch(String(again.headers.get('set-cookie')), /nfb_session=/);
    assert.notEqual(again.body.code, first.body.code);
    assert.equal((await login('8')).status, 429, 'another account keeps its own cooldown');
    assert.equal(sent.length, 3);
});

test('failed attempts from other addresses cannot lock out a personal password', async (t) => {
    t.mock.method(Chat, 'findAll', async ({ where }) => (where.username === '@kirill' ? [{ id: 7 }] : []));
    t.mock.method(Chat, 'findByPk', async () => null);
    const { resetLimits } = require('../../src/account/routes');
    resetLimits();
    t.after(resetLimits);
    await password.setPassword('7', 'right-password');
    const { server, call } = await serve(fakeBot(), { trustLoopback: true });
    t.after(() => server.close());
    const login = (address, name, pass) =>
        call('POST', '/api/login/password', { address, body: { login: name, password: pass } });
    for (const address of ['10.0.0.1', '10.0.0.2']) {
        for (let attempt = 0; attempt < 5; attempt++) {
            assert.equal((await login(address, '7', 'wrong-password')).status, 401);
        }
        assert.equal((await login(address, '@kirill', 'wrong-password')).status, 429);
    }
    assert.equal((await login('10.0.0.3', '@kirill', 'right-password')).body.confirmation, true);
});

test('the API: the system account has no chats and no own password here, its password is in Settings', async (t) => {
    const { server, call } = await serve(fakeBot({}));
    t.after(() => server.close());
    process.env.SYSTEM_PASSWORD_HASH = await password.hashPassword('system-pass');
    const token = await auth.startSession({ userId: '0', userName: 'admin' });
    const me = await call('GET', '/api/account/me', { cookie: token });
    assert.deepEqual(me.body.user, {
        id: '0',
        name: 'admin',
        role: 'admin',
        hasPassword: true,
        passwordChangedAt: null,
        system: true
    });
    assert.deepEqual((await call('GET', '/api/account/chats', { cookie: token })).body, []);
    const own = await call('PUT', '/api/account/password', { cookie: token, body: { password: 'long-enough' } });
    assert.deepEqual([own.status, own.body.error], [400, "The system account's password is in Settings"]);
    assert.equal((await call('DELETE', '/api/account/password', { cookie: token })).status, 400);
});

test('the system account cannot open chat 0', async () => {
    assert.equal(await members.accessTo('0', '0'), null);
});

// --- Known devices (src/account/devices.js) ---

const DEVICE_A = 'a'.repeat(64);
const DEVICE_B = 'b'.repeat(64);
const deviceRow = (deviceId, userId, country, firstSeen = Date.now()) => ({
    deviceId,
    userId: String(userId),
    name: 'Chrome, Windows',
    country,
    network: null,
    firstSeen: new Date(firstSeen),
    lastSeen: new Date(firstSeen)
});

test('the place of an IP comes from the local databases, and the line shows what is known', () => {
    assert.deepEqual(devices.placeOf('8.8.8.8'), { country: 'US', network: 'Google' });
    assert.equal(devices.placeOf('95.24.17.80').country, 'RU');
    assert.deepEqual(devices.placeOf('192.168.2.1'), { country: null, network: null }, 'a home network');
    assert.deepEqual(devices.placeOf('not an ip'), { country: null, network: null });
    assert.equal(devices.countryName('NL'), 'Нидерланды');
    assert.equal(
        devices.placeLine({ country: 'RU', network: 'Vimpelcom', ip: '95.24.17.80' }),
        'Россия, Vimpelcom · 95.24.17.80'
    );
    assert.equal(devices.placeLine({ country: null, network: null, ip: '192.168.2.1' }), '192.168.2.1');
    assert.equal(devices.placeLine(null), '');
    assert.equal(devices.deviceName('Mozilla/5.0 (iPhone) AppleWebKit Version/17 Safari/604.1'), 'Safari, iPhone');
});

test('/code from a known browser says so in one line; from another country it warns, with the buttons', async () => {
    const { commands } = botHandlers();
    const replies = [];
    const ctx = (text) => ({
        from: { id: 7, username: 'u7' },
        chat: { id: 7, type: 'private' },
        message: { text },
        session: {},
        replyWithHTML: async (body, extra) => replies.push({ body, extra })
    });
    deviceRows.push(deviceRow(DEVICE_A, 7, 'RU'));
    const known = auth.startCode(null, null, Date.now(), {
        deviceId: DEVICE_A,
        name: 'Safari, iPhone',
        ip: '95.24.17.80',
        country: 'RU',
        network: 'Vimpelcom'
    });
    await commands.code(ctx(`/code ${known.check}`));
    assert.deepEqual(replies.pop(), {
        body: '✅ <b>Вход выполнен</b>\nSafari, iPhone · Россия, Vimpelcom',
        extra: undefined
    });

    const odd = auth.startCode(null, null, Date.now(), {
        deviceId: DEVICE_B,
        name: 'Chrome, Linux',
        ip: '185.220.101.4',
        country: 'DE',
        network: 'Stiftung Erneuerbare Freiheit'
    });
    await commands.code(ctx(`/code ${odd.check}`));
    const warned = replies.pop();
    assert.equal(
        warned.body,
        '⚠️ <b>Незнакомый вход</b>\nChrome, Linux\nГермания, Stiftung Erneuerbare Freiheit · 185.220.101.4'
    );
    assert.deepEqual(
        warned.extra.reply_markup.inline_keyboard.flat().map((b) => b.text),
        ['🚫 Не моё устройство — отменить вход']
    );
    // The same country as a known browser: only new
    assert.equal(await devices.judge(7, { deviceId: DEVICE_B, country: 'RU' }), 'new');
    assert.equal(await devices.judge(8, { deviceId: DEVICE_B, country: 'DE' }), 'new', 'nothing to compare with');
});

test('the bot question for Telegram and password sign-ins names the browser and its place', () => {
    const start = auth.startCode(null, null, Date.now(), {
        deviceId: DEVICE_A,
        name: 'Firefox, Mac',
        ip: '83.149.9.12',
        country: 'RU',
        network: 'MegaFon <b>'
    });
    const { text } = require('../../src/account/confirmation').confirmation(start.code);
    assert.match(
        text,
        /Войти в панель NotFckBot\?<\/b>\n\nFirefox, Mac\nРоссия, MegaFon &lt;b&gt; · 83\.149\.9\.12\n\n/
    );
    assert.match(
        require('../../src/account/confirmation').confirmation(auth.startCode().code).text,
        /\?<\/b>\n\nПроверочный/
    );
});

test('the guard marks and remembers the browser; a day-old device may end sessions, a new one waits', async (t) => {
    const { server, call } = await serve(fakeBot({}));
    t.after(() => server.close());
    t.mock.method(Chat, 'findByPk', async () => null);
    const user = await signIn(call, 7);
    const first = await call('GET', '/api/account/me', { cookie: user });
    const mark = /nfb_device=([A-Za-z0-9_-]{43});[^,]*HttpOnly/.exec(first.headers.get('set-cookie'))[1];
    assert.match(first.headers.get('set-cookie'), /nfb_session=/, 'the session cookie is still renewed');
    assert.equal(deviceRows.length, 0, 'remembered only once it comes back with the mark');
    await call('GET', '/api/account/me', { cookie: user });
    assert.equal(deviceRows.length, 0, 'a client dropping cookies adds no rows');
    const again = await call('GET', '/api/account/me', { cookie: user, device: mark });
    assert.doesNotMatch(String(again.headers.get('set-cookie')), /nfb_device=/, 'a marked browser keeps its mark');
    assert.equal(deviceRows.length, 1);
    assert.equal(deviceRows[0].userId, '7');
    assert.equal(deviceRows[0].trusted, true);

    // The only device: nothing older to wait for
    const alone = await call('POST', '/api/account/sessions/end-others', { cookie: user, device: mark });
    assert.equal(alone.status, 200);

    // With a device from last week, a browser first seen now can't lock it out
    deviceRows.push(deviceRow(DEVICE_B, 7, 'RU', Date.now() - 7 * 24 * 3600 * 1000));
    for (const [method, path, body] of [
        ['POST', '/api/account/sessions/end-others'],
        ['PUT', '/api/account/password', { password: 'long-enough' }],
        ['DELETE', '/api/account/password']
    ]) {
        const refused = await call(method, path, { cookie: user, device: mark, body });
        assert.equal(refused.status, 403, `${method} ${path}`);
        assert.match(refused.body.error, /one day after its first sign-in/);
    }
    assert.equal(passwords.size, 0);
    // An admin removing their own password from Users waits the same
    panelRoles.set('7', 'admin');
    const own = await call('DELETE', '/api/access/7/password', { cookie: user, device: mark });
    assert.equal(own.status, 403);

    // A day later it may
    deviceRows[0].firstSeen = new Date(Date.now() - devices.FRESH_MS - 1000);
    devices.resetDevices();
    assert.equal((await call('POST', '/api/account/sessions/end-others', { cookie: user, device: mark })).status, 200);
});

test('a session from before devices were remembered counts from its own start', async (t) => {
    const { server, call } = await serve(fakeBot({}));
    t.after(() => server.close());
    t.mock.method(Chat, 'findByPk', async () => null);
    const user = await signIn(call, 7);
    for (const row of sessions.values()) row.createdAt = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    deviceRows.push(deviceRow(DEVICE_B, 7, 'RU', Date.now() - 7 * 24 * 3600 * 1000));
    const mark = 'm'.repeat(43);
    assert.equal((await call('POST', '/api/account/sessions/end-others', { cookie: user, device: mark })).status, 200);
    assert.equal(deviceRows.length, 2);
    assert.ok(deviceRows[1].firstSeen.getTime() < Date.now() - 29 * 24 * 3600 * 1000);
});

test('a browser signed in only by digits stays new; a Telegram-confirmed sign-in makes it known; a denied one stays forgotten', async (t) => {
    const { server, call: plain } = await serve(fakeBot({}), { trustLoopback: true });
    // An address of its own: the sign-in start limit is shared with the other tests
    const call = (method, path, options) => plain(method, path, { ...options, address: '10.9.9.9' });
    t.after(() => server.close());
    t.mock.method(Chat, 'findByPk', async () => null);
    const { actions } = botHandlers();
    const mark = 'k'.repeat(43);
    const signInByDigits = async () => {
        const start = (await call('POST', '/api/login/telegram', { device: mark })).body;
        const answer = await auth.answerCheck(start.check, { id: 7, name: '@u7' });
        assert.equal(answer.state, 'in');
        const poll = await call('POST', '/api/login/telegram/poll', {
            device: mark,
            body: { code: start.code, secret: start.secret }
        });
        assert.equal(poll.body.state, 'in');
        return answer;
    };
    const first = await signInByDigits();
    assert.equal(first.seen, 'new');
    assert.equal(deviceRows.length, 1);
    assert.equal(deviceRows[0].trusted, false, 'signed in by digits only');
    const second = await signInByDigits();
    assert.equal(second.seen, 'new', 'an unconfirmed browser gets the cancel button again');

    const [re, press] = actions.find(([name]) => String(name).includes('notme'));
    await press({
        match: re.exec(`login_me_${second.claim}`),
        from: { id: 7 },
        answerCbQuery: async () => {},
        editMessageReplyMarkup: async () => {}
    });
    assert.equal(deviceRows[0].trusted, false, 'an old "Это я" button trusts nothing: only Telegram does');

    // Confirmed in Telegram ("Да, это я"): now a known browser
    const start = (await call('POST', '/api/login/telegram', { device: mark })).body;
    assert.equal(await auth.answerCode(start.code, { id: 7, name: '@u7' }, true), true);
    const poll = await call('POST', '/api/login/telegram/poll', {
        device: mark,
        body: { code: start.code, secret: start.secret }
    });
    assert.equal(poll.body.state, 'in');
    assert.equal(deviceRows[0].trusted, true);
    const third = await signInByDigits();
    assert.equal(third.seen, 'known');

    // Denied: a request still on its way can't write the browser back
    await press({
        match: re.exec(`login_notme_${third.claim}`),
        from: { id: 7 },
        answerCbQuery: async () => {},
        editMessageText: async () => {}
    });
    assert.equal(deviceRows.length, 0);
    const req = { headers: { cookie: `nfb_device=${mark}` }, get: () => '', ip: '127.0.0.1' };
    await devices.remember(req, { append() {} }, 7, { trusted: true });
    assert.equal(deviceRows.length, 0);
});

test('a digit sign-in polled under another cookie still leaves its browser untrusted', async (t) => {
    const { server, call: plain } = await serve(fakeBot({}), { trustLoopback: true });
    const call = (method, path, options) => plain(method, path, { ...options, address: '10.9.9.8' });
    t.after(() => server.close());
    t.mock.method(Chat, 'findByPk', async () => null);
    // The page drops the mark it was given and polls without it: a new mark comes back
    const start = (await call('POST', '/api/login/telegram', { device: 'p'.repeat(43) })).body;
    assert.equal((await auth.answerCheck(start.check, { id: 7, name: '@u7' })).state, 'in');
    const poll = await call('POST', '/api/login/telegram/poll', { body: { code: start.code, secret: start.secret } });
    const cookies = poll.headers.get('set-cookie');
    const session = /nfb_session=([^;]+)/.exec(cookies)[1];
    const swapped = /nfb_device=([A-Za-z0-9_-]{43})/.exec(cookies)[1];
    assert.equal(deviceRows.length, 0);
    await call('GET', '/api/account/me', { cookie: session, device: swapped });
    assert.equal(deviceRows.length, 1);
    assert.equal(deviceRows[0].trusted, false, 'the session was never confirmed');
    const next = auth.startCode(null, null, Date.now(), { deviceId: deviceRows[0].deviceId, country: null });
    assert.equal((await auth.answerCheck(next.check, { id: 7, name: '@u7' })).seen, 'new');
});
