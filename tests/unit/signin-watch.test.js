// Wrong passwords for the system account are counted across addresses and alert the people who run
// the bot (src/account/signin-watch.js): the route's own limit is per address and locks nobody out
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const alerts = require('../../src/alerts');
const catalog = require('../../src/alerts/catalog');
const watch = require('../../src/account/signin-watch');
const password = require('../../src/account/password');
const { Chat } = require('../../src/db');

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 12, 10, 0, 0);
const from = (ip) => ({ deviceId: 'd', name: 'Chrome', ip, country: 'NL', network: 'Example' });

/** alerts.once replaced: what it was asked to send. */
function capture(t) {
    const calls = [];
    t.mock.method(alerts, 'once', async (key, text, options) => {
        calls.push({ key, text: text(() => '10:00'), options });
        return { sent: 1, failed: 0, wanted: 1, unreachable: 0 };
    });
    return calls;
}

beforeEach(() => watch.reset());

test('the tenth wrong password within the hour alerts once, with the count and the addresses', async (t) => {
    const calls = capture(t);
    let now = START;
    t.mock.method(Date, 'now', () => now);
    for (let i = 0; i < 9; i++) {
        assert.equal(await watch.systemMiss(from(i % 2 ? '203.0.113.7' : '198.51.100.4'), now), null);
        now += 60000;
    }
    assert.equal(calls.length, 0);
    await watch.systemMiss(from('203.0.113.7'), now);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, 'system_signin');
    assert.match(calls[0].text, /Неверных паролей за час: 10\nАдресов: 2, последний: .*203\.0\.113\.7/);
    assert.match(calls[0].text, /Вход не заблокирован/);
    assert.equal(calls[0].options.fingerprint, String(Math.floor(now / HOUR)));
    // Counted from nothing again: nine more say nothing
    for (let i = 0; i < 9; i++) await watch.systemMiss(from('203.0.113.7'), now);
    assert.equal(calls.length, 1);
});

test('wrong passwords more than an hour apart never add up', async (t) => {
    const calls = capture(t);
    let now = START;
    t.mock.method(Date, 'now', () => now);
    for (let i = 0; i < 30; i++) {
        await watch.systemMiss(from('203.0.113.7'), now);
        now += 7 * 60000;
    }
    assert.equal(calls.length, 0);
});

test('the next hour of guessing is an alert of its own', async (t) => {
    const calls = capture(t);
    let now = START;
    t.mock.method(Date, 'now', () => now);
    for (let i = 0; i < 10; i++) await watch.systemMiss(null, now);
    now += HOUR;
    for (let i = 0; i < 10; i++) await watch.systemMiss(null, now);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].options.fingerprint, calls[1].options.fingerprint);
    // No address known: the line about them is left out
    assert.doesNotMatch(calls[0].text, /Адресов/);
});

test('a wrong system password is counted; a wrong personal one and a right one are not', async (t) => {
    const calls = capture(t);
    t.mock.method(Chat, 'findAll', async () => []);
    const saved = process.env.SYSTEM_PASSWORD_HASH;
    process.env.SYSTEM_PASSWORD_HASH = await password.hashPassword('system-pass');
    t.after(() => {
        if (saved === undefined) delete process.env.SYSTEM_PASSWORD_HASH;
        else process.env.SYSTEM_PASSWORD_HASH = saved;
    });
    for (let i = 0; i < 9; i++)
        assert.equal(await password.signInWithPassword('admin', 'nope', Date.now(), null), null);
    assert.equal(await password.signInWithPassword('nobody_here', 'nope'), null);
    assert.equal(calls.length, 0);
    assert.equal(await password.signInWithPassword('admin', 'nope'), null);
    // The count is not waited for by the sign-in
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 1);
});

test('the event is critical and has its own group in the catalog', () => {
    const event = catalog.EVENTS.find((e) => e.key === 'system_signin');
    assert.deepEqual([event.group, event.critical], ['security', true]);
    assert.ok(catalog.GROUPS.some((g) => g.key === 'security'));
    assert.equal(catalog.wants({ preset: 'critical' }, 'system_signin'), true);
});
