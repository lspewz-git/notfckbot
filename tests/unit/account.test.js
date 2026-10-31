/**
 * Signing in to the panel and the users' own chats (src/account/): who may sign in and as what,
 * the one-time links, the codes the bot confirms, sessions, which API a role may call, and who may
 * open and change which chat. The database and Telegram are stubbed.
 * Run: node --test tests/unit/account.test.js
 */
const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Op } = require('sequelize');
const {
    AccountSession,
    LoginLink,
    AccountPassword,
    PanelRole,
    Chat,
    Watchlist,
    Subscription
} = require('../../src/db');
const auth = require('../../src/account/auth');
const roles = require('../../src/account/roles');
const password = require('../../src/account/password');
const members = require('../../src/account/members');
const { guard } = require('../../src/account/guard');
const { panelOnly } = require('../../src/admin/panel-only');

const ENV = ['ADMIN_USERS', 'ACCOUNT_USERS', 'PANEL_URL', 'OPEN_SIGNUP', 'SYSTEM_LOGIN', 'SYSTEM_PASSWORD_HASH'];
let savedEnv;
let sessions;
let links;
let passwords;
// PanelRole's rows: userId → role
let panelRoles;

beforeEach(() => {
    savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    process.env.PANEL_URL = 'http://box/';
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
    mock.method(AccountPassword, 'findByPk', async (id) =>
        passwords.has(String(id)) ? passwords.get(String(id)) : null
    );
    mock.method(AccountPassword, 'upsert', async (row) => passwords.set(String(row.userId), row));
    mock.method(AccountPassword, 'destroy', async ({ where }) => Number(passwords.delete(String(where.userId))));
    const table = (rows) => ({
        create: async (row) => {
            rows.set(row.id, row);
            return row;
        },
        findByPk: async (id) => rows.get(id) || null,
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
        for (const method of ['create', 'findByPk', 'destroy']) mock.method(model, method, fake[method]);
    }
    members.forget();
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
    assert.match(link, /^http:\/\/box\/login\/[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(link);
    assert.ok(![...links.keys()].includes(token), 'the token itself is not stored');

    const first = await auth.redeemLink(token);
    assert.equal(first.chatId, '-100');
    assert.equal(await auth.redeemLink(token), null, 'second use');
    const session = await auth.sessionOf({ headers: { cookie: `x=1; nfb_session=${first.token}` } });
    assert.deepEqual([session.userId, session.role], ['7', 'user']);

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

async function serve(bot) {
    members.useBot(bot);
    const app = express();
    app.set('bot', bot);
    app.use('/api', panelOnly);
    app.use('/api', guard);
    app.use(express.json());
    app.use(require('../../src/account/routes').router);
    app.get('/api/stats', (req, res) => res.json({ admin: true }));
    // eslint-disable-next-line no-unused-vars
    app.use('/api', (err, req, res, next) => res.status(err.status || 500).json({ error: 'Bad request' }));
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, path, { body, cookie, raw } = {}) =>
        fetch(`${base}${path}`, {
            method,
            headers: {
                'X-Requested-By': 'notfckbot-panel',
                ...(cookie ? { Cookie: `nfb_session=${cookie}` } : {}),
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
    assert.deepEqual(me.body.user, { id: '7', name: '@u7', role: 'user', hasPassword: false, system: false });
    assert.deepEqual((await call('GET', '/api/account/chats', { cookie: user })).body, []);

    const admin = await signIn(call, 42);
    assert.equal((await call('GET', '/api/stats', { cookie: admin })).status, 200);
    assert.equal((await call('POST', '/api/logout', { cookie: admin })).status, 200);
    assert.equal((await call('GET', '/api/stats', { cookie: admin })).status, 401, 'signed out');
});

test('the API: the Telegram code goes with the bot link; the poll lets in the confirmed page', async (t) => {
    const { server, call } = await serve(fakeBot({}));
    t.after(() => server.close());
    const start = await call('POST', '/api/login/telegram');
    assert.match(start.body.url, /^https:\/\/t\.me\/notfckbot\?start=L[A-Za-z0-9_-]{32}$/);
    assert.equal(start.body.url.endsWith(start.body.code), true);
    const poll = () =>
        call('POST', '/api/login/telegram/poll', { body: { code: start.body.code, secret: start.body.secret } });
    assert.equal((await poll()).body.state, 'waiting');
    await auth.answerCode(start.body.code, { id: 42 }, true);
    const done = await poll();
    assert.equal(done.body.state, 'in');
    assert.match(done.headers.get('set-cookie'), /nfb_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly/);
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

// --- The bot ---

function botHandlers() {
    const handlers = { commands: {}, actions: [] };
    require('../../src/bot/login').register({
        command: (name, fn) => (handlers.commands[name] = fn),
        action: (re, fn) => handlers.actions.push([re, fn])
    });
    return handlers;
}

test('/login: refused to users not on the lists; in a group the link goes to the private chat', async () => {
    const { commands } = botHandlers();
    const replies = [];
    const sent = [];
    const ctx = (from, chat) => ({
        from,
        chat,
        reply: async (text) => replies.push(text),
        telegram: fakeBot({}, sent).telegram
    });
    await commands.login(ctx({ id: 99 }, { id: 99, type: 'private' }));
    assert.match(replies.pop(), /закрытом тесте/);
    assert.equal(sent.length, 0);

    await commands.login(ctx({ id: 42, username: 'me' }, { id: -1, type: 'supergroup', title: 'Кино <b>' }));
    assert.equal(sent[0].chatId, '42');
    assert.match(sent[0].text, /http:\/\/box\/login\//);
    assert.match(sent[0].text, /Кино &lt;b&gt;/);
    assert.match(replies.pop(), /личные сообщения/);
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
    // The same four digits as the sign-in page shows: a link sent by someone else shows other digits
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
    t.mock.method(Chat, 'findAll', async ({ where }) => (where.username === '@kirill' ? [{ id: 7 }] : []));
    t.mock.method(Chat, 'findByPk', async () => ({ username: '@Kirill' }));
    await password.setPassword('7', 'secret-pass');
    for (const login of ['7', '@kirill', 'Kirill', ' @KIRILL ']) {
        const session = await password.signInWithPassword(login, 'secret-pass');
        assert.ok(session, login);
        const signed = await auth.sessionOf({ headers: { cookie: `nfb_session=${session.token}` } });
        assert.deepEqual([signed.userId, signed.role, signed.userName], ['7', 'user', '@Kirill']);
    }
    assert.equal(await password.signInWithPassword('7', 'wrong-pass'), null);
    assert.equal(await password.signInWithPassword('@nobody', 'secret-pass'), null);
    assert.equal(await password.signInWithPassword('8', 'secret-pass'), null, 'no password set');
    assert.equal(await password.signInWithPassword('first name', 'secret-pass'), null, 'only @usernames');
    panelRoles.set('7', 'none');
    assert.equal(await password.signInWithPassword('7', 'secret-pass'), null, 'access taken away');
    panelRoles.set('7', 'user');
    assert.equal(await password.removePassword('7'), true);
    assert.equal(await password.signInWithPassword('7', 'secret-pass'), null, 'removed');
});

/** Waits for the bot's messages sent without being waited for (a second at most). */
async function sentCount(sent, n) {
    for (let i = 0; i < 100 && sent.length < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    return sent.length;
}

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
    assert.deepEqual(set.body, { hasPassword: true });
    assert.equal((await call('GET', '/api/account/me', { cookie: user })).body.user.hasPassword, true);
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
    assert.match(ok.headers.get('set-cookie'), /nfb_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly/);
    ok.cookie = /nfb_session=([^;]+)/.exec(ok.headers.get('set-cookie'))[1];
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

test('the per-account limit: an id and its @username count as one account', async (t) => {
    t.mock.method(Chat, 'findAll', async ({ where }) => (where.username === '@kirill' ? [{ id: 7 }] : []));
    const { loginLimitKey } = require('../../src/account/routes');
    const keyFor = async (login) => loginLimitKey({ body: { login }, loginUserId: await password.userIdFor(login) });
    assert.equal(await keyFor('@Kirill'), await keyFor('7'));
    assert.notEqual(await keyFor('@nobody'), await keyFor('7'));
});

test('the API: the system account has no chats and no own password here, its password is in Settings', async (t) => {
    const { server, call } = await serve(fakeBot({}));
    t.after(() => server.close());
    process.env.SYSTEM_PASSWORD_HASH = await password.hashPassword('system-pass');
    const token = await auth.startSession({ userId: '0', userName: 'admin' });
    const me = await call('GET', '/api/account/me', { cookie: token });
    assert.deepEqual(me.body.user, { id: '0', name: 'admin', role: 'admin', hasPassword: true, system: true });
    assert.deepEqual((await call('GET', '/api/account/chats', { cookie: token })).body, []);
    const own = await call('PUT', '/api/account/password', { cookie: token, body: { password: 'long-enough' } });
    assert.deepEqual([own.status, own.body.error], [400, "The system account's password is in Settings"]);
    assert.equal((await call('DELETE', '/api/account/password', { cookie: token })).status, 400);
});

test('the system account: its tries count per address (the login is public), and it opens no chat', async () => {
    const { loginLimitKey } = require('../../src/account/routes');
    const key = (ip) => loginLimitKey({ body: { login: 'admin' }, loginUserId: '0', ip });
    assert.notEqual(key('10.0.0.1'), key('10.0.0.2'));
    assert.equal(loginLimitKey({ body: { login: '7' }, loginUserId: '7', ip: '10.0.0.1' }), 'login:7');
    assert.equal(await members.accessTo('0', '0'), null);
});
