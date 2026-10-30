/**
 * A chat's change log (src/chat-changes.js): settings changes in words, who made them and from where,
 * a page of the log with the unwritten changes on it, the time it is kept. No database: stubbed.
 * Run: npm run test:unit
 */
const { test, describe, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { ChatEvent, Chat } = require('../../src/db');
const events = require('../../src/chat-events');
const changes = require('../../src/chat-changes');
const ops = require('../../src/chat-ops');

const SETTINGS = {
    buttons_mode: 'owner',
    menu_enabled: true,
    quiet_start: null,
    quiet_end: null,
    timezone: 'Europe/Moscow',
    digest_week: false,
    digest_month: false
};

const stubs = [];
const stub = (object, name, fn) => stubs.push(mock.method(object, name, fn));
afterEach(async () => {
    stubs.splice(0).forEach((s) => s.mock.restore());
    delete process.env.CHANGES_KEEP_DAYS;
    // Nothing left for the next test: the flush writes into a stub
    const write = mock.method(ChatEvent, 'bulkCreate', async () => []);
    const findAll = mock.method(Chat, 'findAll', async () => []);
    await events.flushEvents();
    write.mock.restore();
    findAll.mock.restore();
});

describe('settings changes', () => {
    test('one line per setting that really changed, the quiet hours as one', () => {
        const after = { ...SETTINGS, quiet_start: 23, quiet_end: 8, timezone: 'Asia/Omsk', menu_enabled: true };
        assert.deepEqual(changes.settingLines(SETTINGS, after), [
            { setting: 'quiet', line: 'Тихие часы: выключены → 23:00–08:00' },
            { setting: 'timezone', line: 'Часовой пояс: Москва (UTC+3) → Омск (UTC+6)' }
        ]);
        assert.deepEqual(changes.settingLines(SETTINGS, { ...SETTINGS }), []);
    });

    test('updateSettings notes the change with who made it and from where', async () => {
        const chat = { ...SETTINGS, get: () => ({ ...chat }) };
        chat.update = async (values) => Object.assign(chat, values);
        stub(Chat, 'findByPk', async () => chat);
        const who = { userId: 7, userName: 'Анна', source: 'account' };
        const { lines } = await ops.updateSettings('-100', { digest_week: true, menu_enabled: true }, who);
        assert.deepEqual(lines, ['Сводка недели: выключена → по понедельникам в 10:00']);
        const row = events.unwritten().find((e) => e.kind === 'settings');
        assert.equal(row.chatId, '-100');
        assert.equal(row.detail, 'digest_week');
        assert.equal(row.userName, 'Анна');
        assert.equal(row.source, 'account');
    });
});

describe('a page of the log', () => {
    const written = (n) =>
        Array.from({ length: n }, (_, i) => ({
            createdAt: new Date(Date.UTC(2026, 9, 1) - i * 1000),
            kind: 'subscribed',
            detail: 'episode',
            title: `Old ${i}`,
            userName: null,
            source: null
        }));

    test('the unwritten changes come first, then the written ones, a page at a time', async () => {
        const rows = written(12);
        const asked = [];
        stub(ChatEvent, 'count', async () => rows.length);
        stub(ChatEvent, 'findAll', async (q) => {
            asked.push({ offset: q.offset, limit: q.limit });
            return rows.slice(q.offset, q.offset + q.limit);
        });
        const now = new Date(Date.UTC(2026, 9, 2));
        events.record('-100', { kind: 'film_added', title: 'Mickey 17', source: 'panel' }, now);
        events.record('-100', { kind: 'used', detail: 'search' }, now);
        events.record('-200', { kind: 'film_added', title: 'Elsewhere' }, now);
        events.record('-100', { kind: 'unsubscribed', title: 'Newest' }, new Date(now.getTime() + 1));

        const first = await changes.changesOf('-100', { page: 1, size: 10 }, now);
        assert.equal(first.total, 14);
        assert.deepEqual(
            first.rows.slice(0, 3).map((r) => r.title),
            ['Newest', 'Mickey 17', 'Old 0']
        );
        assert.equal(first.rows[1].source, 'panel');
        assert.deepEqual(asked.at(-1), { offset: 0, limit: 8 });

        const second = await changes.changesOf('-100', { page: 2, size: 10 }, now);
        assert.deepEqual(asked.at(-1), { offset: 8, limit: 10 });
        assert.deepEqual(
            second.rows.map((r) => r.title),
            ['Old 8', 'Old 9', 'Old 10', 'Old 11']
        );
    });

    test('the search looks in the title and the name; % and _ are taken as they are', async () => {
        let where;
        stub(ChatEvent, 'count', async (q) => {
            where = q.where;
            return 0;
        });
        stub(ChatEvent, 'findAll', async () => []);
        events.record('-100', { kind: 'settings', title: 'Тихие часы: выключены → 23:00–08:00', userName: 'Анна' });
        events.record('-100', { kind: 'subscribed', title: 'The Bear', userName: '@igor' });
        const found = await changes.changesOf('-100', { q: 'АННА' });
        assert.deepEqual(
            found.rows.map((r) => r.title),
            ['Тихие часы: выключены → 23:00–08:00']
        );
        await changes.changesOf('-100', { q: '50%_off' });
        assert.equal(where[Op.or][0].title[Op.like], '%50\\%\\_off%');
    });

    test('kept 30 days unless Settings picked one of the offered periods', async () => {
        let since;
        stub(ChatEvent, 'count', async (q) => {
            since = q.where.createdAt[Op.gte];
            return 0;
        });
        stub(ChatEvent, 'findAll', async () => []);
        const now = new Date(Date.UTC(2026, 9, 30));
        assert.equal((await changes.changesOf('-100', {}, now)).keepDays, 30);
        assert.equal(since.toISOString(), '2026-09-30T00:00:00.000Z');
        process.env.CHANGES_KEEP_DAYS = '7';
        assert.equal((await changes.changesOf('-100', {}, now)).keepDays, 7);
        process.env.CHANGES_KEEP_DAYS = '45';
        assert.equal(changes.keepDays(), 30);
    });

    test('the sweep drops only settings changes past the time kept', async () => {
        let where;
        stub(ChatEvent, 'destroy', async (q) => {
            where = q.where;
            return 2;
        });
        process.env.CHANGES_KEEP_DAYS = '90';
        assert.equal(await changes.sweepChanges(new Date(Date.UTC(2026, 9, 30))), 2);
        assert.equal(where.kind, 'settings');
        assert.equal(where.createdAt[Op.lt].toISOString(), '2026-08-01T00:00:00.000Z');
    });

    test('the query: page and size as the panel sends them, anything else refused', () => {
        assert.deepEqual(changes.changesQuery.parse({ page: '3', size: '50', q: 'bear' }), {
            page: 3,
            size: 50,
            q: 'bear'
        });
        assert.deepEqual(changes.changesQuery.parse({}), { page: 1, size: 10, q: '' });
        assert.equal(changes.changesQuery.safeParse({ size: '1000' }).success, false);
        assert.equal(changes.changesQuery.safeParse({ page: '0' }).success, false);
    });
});
