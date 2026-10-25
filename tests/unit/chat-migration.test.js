/**
 * A group that became a supergroup (src/chat-migration.js, src/bot/migration.js, the fallback in
 * src/delivery.js): its data moves to the new id, the new chat's own rows win, a second call finds
 * nothing, and a send to the old id follows the move. The tables are in memory.
 * Run: npm run test:unit
 */
const { test, describe, mock, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const sequelize = require('../../src/database');
const db = require('../../src/db');
const events = require('../../src/chat-events');

const MODELS = ['Subscription', 'Watchlist', 'PendingMessage', 'HeldNotification', 'ChatEvent', 'RecapSend'];
let chats;
let tables;

/** Rows matching a where of plain values or arrays of values. */
const matches = (rowValues, where) =>
    Object.entries(where).every(([k, v]) =>
        Array.isArray(v) ? v.map(String).includes(String(rowValues[k])) : String(rowValues[k]) === String(v)
    );

const stubs = [];
const stub = (object, name, impl) => stubs.push(mock.method(object, name, impl));
after(() => {
    for (const m of stubs.reverse()) m.mock.restore();
});

stub(sequelize, 'transaction', async (fn) => fn({}));
const chatRow = (values) => ({
    ...values,
    get: () => ({ ...values }),
    async update(changes) {
        Object.assign(values, changes);
    },
    async destroy() {
        chats.delete(String(values.id));
    }
});
stub(db.Chat, 'findByPk', async (id) => (chats.has(String(id)) ? chatRow(chats.get(String(id))) : null));
stub(db.Chat, 'create', async (values) => {
    chats.set(String(values.id), { ...values });
});
for (const name of MODELS) {
    stub(db[name], 'findAll', async ({ where }) => tables[name].filter((r) => matches(r, where)));
    stub(db[name], 'destroy', async ({ where }) => {
        tables[name] = tables[name].filter((r) => !matches(r, where));
    });
    stub(db[name], 'update', async (changes, { where }) => {
        for (const r of tables[name]) if (matches(r, where)) Object.assign(r, changes);
    });
}

const { migrateChat, migratedTo } = require('../../src/chat-migration');
const { migrationOf } = require('../../src/bot/migration');
const { deliver, classify } = require('../../src/delivery');

beforeEach(() => {
    chats = new Map([
        ['-100', { id: '-100', type: 'group', username: 'Club', quiet_start: 23, quiet_end: 8, timezone: 'Asia/Omsk' }]
    ]);
    tables = Object.fromEntries(MODELS.map((m) => [m, []]));
    tables.Subscription.push({ chatId: '-100', seriesId: 'tv_1' }, { chatId: '-100', seriesId: 'tv_2' });
    tables.Watchlist.push({ chatId: '-100', tmdb_id: 'movie_1' });
    tables.HeldNotification.push({ chatId: '-100' });
    tables.PendingMessage.push({ chatId: '-100' });
    tables.ChatEvent.push({ chatId: '-100', kind: 'subscribed' });
    tables.RecapSend.push({ chatId: '-100', year: 2026, status: 'queued' });
});

describe('moving a group to its supergroup', () => {
    test('everything goes to the new id with the group’s settings; the old chat is gone', async () => {
        assert.equal(await migrateChat(-100, -1001), true);
        assert.equal(chats.has('-100'), false);
        const moved = chats.get('-1001');
        assert.equal(moved.type, 'supergroup');
        assert.equal(moved.username, 'Club');
        assert.deepEqual([moved.quiet_start, moved.quiet_end, moved.timezone], [23, 8, 'Asia/Omsk']);
        for (const name of MODELS) {
            assert.ok(tables[name].length > 0, name);
            assert.ok(
                tables[name].every((r) => r.chatId === '-1001'),
                `${name} moved`
            );
        }
    });

    test('the supergroup already has some of it: its own rows win, no duplicates; a second call finds nothing', async () => {
        // The bot saw the supergroup first and someone subscribed there already
        chats.set('-1001', { id: '-1001', type: 'supergroup', username: 'Club' });
        tables.Subscription.push({ chatId: '-1001', seriesId: 'tv_1', own: true });
        tables.RecapSend.push({ chatId: '-1001', year: 2026, status: 'sent', own: true });
        await migrateChat('-100', '-1001');
        assert.deepEqual(tables.Subscription.map((r) => r.seriesId).sort(), ['tv_1', 'tv_2']);
        assert.ok(tables.Subscription.find((r) => r.seriesId === 'tv_1').own);
        assert.deepEqual(tables.RecapSend, [{ chatId: '-1001', year: 2026, status: 'sent', own: true }]);
        // The group's settings carried over to the existing row
        assert.equal(chats.get('-1001').timezone, 'Asia/Omsk');
        assert.equal(await migrateChat('-100', '-1001'), false);
    });

    test("whether the bot is in the chat is the supergroup's own, not the old group's", async () => {
        // Telegram may say the bot left the old group as it closes
        Object.assign(chats.get('-100'), { bot_status: 'removed', bot_status_at: new Date(), bot_status_by: '@ann' });
        chats.set('-1001', { id: '-1001', type: 'supergroup', username: 'Club', bot_status: 'active' });
        await migrateChat('-100', '-1001');
        assert.equal(chats.get('-1001').bot_status, 'active');
        assert.equal(chats.get('-1001').bot_status_by, undefined);
        assert.equal(chats.get('-1001').timezone, 'Asia/Omsk');
    });

    test('events recorded but not written yet go under the new id too', async () => {
        events.record('-100', { kind: 'used', detail: 'search' });
        await migrateChat('-100', '-1001');
        assert.ok(events.unwritten().some((e) => String(e.chatId) === '-1001' && e.detail === 'search'));
        assert.ok(!events.unwritten().some((e) => String(e.chatId) === '-100'));
    });
});

describe('noticing the move', () => {
    test('the service message in either chat names both ids', () => {
        assert.deepEqual(migrationOf({ message: { chat: { id: -100 }, migrate_to_chat_id: -1001 } }), {
            from: -100,
            to: -1001
        });
        assert.deepEqual(migrationOf({ message: { chat: { id: -1001 }, migrate_from_chat_id: -100 } }), {
            from: -100,
            to: -1001
        });
        assert.equal(migrationOf({ message: { chat: { id: -100 }, text: 'hi' } }), null);
        assert.equal(migrationOf({ callback_query: {} }), null);
    });

    const upgraded = () =>
        Object.assign(new Error('Bad Request: group chat was upgraded to a supergroup chat'), {
            description: 'Bad Request: group chat was upgraded to a supergroup chat',
            response: {
                error_code: 400,
                description: 'Bad Request: group chat was upgraded to a supergroup chat',
                parameters: { migrate_to_chat_id: -1001 }
            }
        });

    test('a send to the old id: the error says where it went', () => {
        assert.deepEqual(classify(upgraded()), { kind: 'moved', to: '-1001' });
        assert.equal(migratedTo(upgraded()), '-1001');
    });

    test('a send the bot missed the move for: data moved, the message goes to the supergroup, once', async () => {
        const tried = [];
        const bot = {
            telegram: {
                sendMessage: async (chatId) => {
                    tried.push(String(chatId));
                    if (String(chatId) === '-100') throw upgraded();
                }
            }
        };
        const result = await deliver(bot, '-100', 'Новая серия', { wait: async () => {} });
        assert.equal(result.status, 'sent');
        assert.deepEqual(tried, ['-100', '-1001']);
        assert.ok(chats.has('-1001'));
    });
});
