/**
 * Whether the bot can still reach a chat (src/bot-status.js): Telegram's my_chat_member
 * (src/bot/membership.js), a refused send (src/delivery.js), a chat seen again; and the update
 * check skipping a chat the bot has lost (src/cron/outbox.js). Telegram and the database are stubbed.
 * Run: npm run test:unit
 */
const { test, describe, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Telegram } = require('telegraf');

mock.method(Telegram.prototype, 'callApi', async () => true);

// --- The database, stubbed: chat rows by id ---
const { Chat } = require('../../src/db');
const rows = new Map();
function row(id, fields = {}) {
    const r = {
        id,
        type: 'private',
        bot_status: 'active',
        bot_status_at: null,
        bot_status_by: null,
        last_seen_at: null,
        ...fields,
        async update(changes) {
            Object.assign(r, changes);
        }
    };
    rows.set(String(id), r);
    return r;
}
mock.method(Chat, 'findAll', async ({ where }) =>
    where.id ? where.id.map((id) => rows.get(String(id))).filter(Boolean) : [...rows.values()]
);
mock.method(Chat, 'findByPk', async (id) => rows.get(String(id)) || null);
mock.method(Chat, 'findOrCreate', async ({ where, defaults }) => [
    rows.get(String(where.id)) || row(where.id, defaults),
    false
]);

const status = require('../../src/bot-status');
const events = require('../../src/chat-events');
const { membershipChange, seenAt, recheckRemoved } = require('../../src/bot/membership');
const { deliver } = require('../../src/delivery');
const { notify } = require('../../src/cron/outbox');
const { fakeBot } = require('./fakes');

const botEvents = () =>
    events
        .unwritten()
        .filter((e) => e.kind.startsWith('bot_'))
        .map((e) => [String(e.chatId), e.kind, e.detail, e.userName]);

beforeEach(async () => {
    rows.clear();
    status.reset();
    // Unwritten events are module state: drop what earlier tests recorded, without the database
    const { ChatEvent } = require('../../src/db');
    const write = mock.method(ChatEvent, 'bulkCreate', async () => {});
    await events.flushEvents();
    write.mock.restore();
});

describe('a refused send', () => {
    test('says how the chat was lost, or that it was not', () => {
        assert.equal(status.leftReason('Forbidden: bot was blocked by the user'), 'stopped');
        assert.equal(status.leftReason('Forbidden: bot was kicked from the supergroup chat'), 'removed');
        assert.equal(status.leftReason('Forbidden: bot is not a member of the channel chat'), 'removed');
        assert.equal(status.leftReason('Forbidden: user is deactivated'), 'deleted');
        assert.equal(status.leftReason('Bad Request: chat not found'), 'deleted');
        // Still there, just can't write: not lost
        assert.equal(status.leftReason('Bad Request: not enough rights to send text messages'), null);
        assert.equal(status.leftReason("Forbidden: bot can't initiate conversation with a user"), null);
    });

    test('marks the chat at once for the next send and in the database at the flush', async () => {
        const chat = row(7);
        const result = await deliver(fakeBot({ failFor: [7] }), 7, 'hi', { wait: async () => {} });
        assert.equal(result.status, 'gone');
        assert.equal(status.isLeft(chat), true, 'skipped before anything is written');
        assert.equal(chat.bot_status, 'active');

        await status.flushStatus();
        assert.equal(chat.bot_status, 'stopped');
        assert.ok(chat.bot_status_at instanceof Date);
        assert.deepEqual(botEvents(), [['7', 'bot_off', 'stopped', null]]);
    });

    test('for a chat already marked: no new event', async () => {
        const since = new Date('2026-10-01T00:00:00Z');
        const chat = row(8, { bot_status: 'stopped', bot_status_at: since });
        status.noteSendFailed(8, 'Forbidden: bot was blocked by the user');
        await status.flushStatus();
        assert.equal(chat.bot_status_at, since);
        assert.deepEqual(botEvents(), []);
    });
});

describe('the update check', () => {
    test('skips a chat the bot has lost and records nothing for it', async () => {
        row(21, { bot_status: 'removed' });
        row(22);
        const bot = fakeBot();
        const event = { detail: 'episode', tmdb_id: 'tv_1', title: 'Show', season: 1, episode: 2 };
        assert.deepEqual(await notify(bot, 21, 'text', { event }), { status: 'left' });
        await notify(bot, 22, 'text', { event });
        assert.deepEqual(
            bot.sent.map((m) => m.chatId),
            [22]
        );
        assert.deepEqual(
            events.unwritten().map((e) => e.chatId),
            [22]
        );
    });
});

describe('Telegram tells us', () => {
    const member = (status, extra = {}) => ({ status, ...extra });

    test('what a change of membership means', () => {
        assert.deepEqual(membershipChange('private', member('member'), member('kicked')), {
            status: 'stopped',
            detail: 'stopped'
        });
        assert.deepEqual(membershipChange('private', member('kicked'), member('member')), {
            status: 'active',
            detail: 'started'
        });
        assert.deepEqual(membershipChange('supergroup', member('member'), member('left')), {
            status: 'removed',
            detail: 'removed'
        });
        assert.deepEqual(membershipChange('group', member('left'), member('member')), {
            status: 'active',
            detail: 'added'
        });
        // Made an admin, or its rights changed: still in
        assert.equal(membershipChange('supergroup', member('member'), member('administrator')), null);
        assert.equal(membershipChange('supergroup', member('member'), member('restricted', { is_member: true })), null);
    });

    test('a group removing the bot: written at once, with who did it', async () => {
        process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:test';
        const bot = require('../../src/bot');
        bot.botInfo = { id: 1, is_bot: true, username: 'test_bot', first_name: 'Test' };
        const me = { id: 1, is_bot: true, first_name: 'Test' };
        const group = row(-100, { type: 'supergroup', username: 'Movie Club' });
        await bot.handleUpdate({
            update_id: 1,
            my_chat_member: {
                chat: { id: -100, type: 'supergroup', title: 'Movie Club' },
                from: { id: 5, is_bot: false, first_name: 'Masha', username: 'masha' },
                date: Date.parse('2026-10-20T10:00:00Z') / 1000,
                old_chat_member: { user: me, status: 'member' },
                new_chat_member: { user: me, status: 'left' }
            }
        });
        assert.equal(group.bot_status, 'removed');
        assert.equal(group.bot_status_by, '@masha');
        assert.equal(group.bot_status_at.toISOString(), '2026-10-20T10:00:00.000Z');
        assert.deepEqual(botEvents(), [['-100', 'bot_off', 'removed', '@masha']]);

        // Added back: active again, and the history has both
        await bot.handleUpdate({
            update_id: 2,
            my_chat_member: {
                chat: { id: -100, type: 'supergroup', title: 'Movie Club' },
                from: { id: 6, is_bot: false, first_name: 'Ann', username: 'ann' },
                date: Date.parse('2026-10-22T10:00:00Z') / 1000,
                old_chat_member: { user: me, status: 'left' },
                new_chat_member: { user: me, status: 'member' }
            }
        });
        assert.equal(group.bot_status, 'active');
        assert.deepEqual(botEvents().at(-1), ['-100', 'bot_on', 'added', '@ann']);
    });

    test('a user starting the bot again for the first time: an event, no change', async () => {
        const chat = row(30);
        status.noteTelegram(30, 'active', { detail: 'started' });
        await status.flushStatus();
        assert.equal(chat.bot_status_at, null, 'never left: no "came back"');
        assert.deepEqual(botEvents(), [['30', 'bot_on', 'started', null]]);
    });
});

describe('a chat seen', () => {
    test('its last use is written; a chat thought lost that writes again is back', async () => {
        const quiet = row(40);
        const lost = row(41, { bot_status: 'stopped', bot_status_at: new Date('2026-10-01T00:00:00Z') });
        const at = new Date('2026-10-24T12:00:00Z');
        status.noteSeen(40, at);
        status.noteSeen(41, at);
        await status.flushStatus();
        assert.equal(quiet.last_seen_at, at);
        assert.equal(lost.bot_status, 'active');
        assert.equal(lost.bot_status_at, at);
        assert.deepEqual(botEvents(), [['41', 'bot_on', 'returned', null]]);
    });

    test('a failed write keeps what was noted for the next one', async () => {
        const chat = row(50);
        const failing = mock.method(chat, 'update', async () => {
            throw new Error('database down');
        });
        status.noteSeen(50, new Date('2026-10-24T12:00:00Z'));
        await status.flushStatus();
        assert.equal(chat.last_seen_at, null);
        failing.mock.restore();
        await status.flushStatus();
        assert.ok(chat.last_seen_at);
    });
});

describe('an announcement from the panel', () => {
    test('skips the chats that left the bot and says how many', async () => {
        const express = require('express');
        const app = express();
        app.use(express.json());
        const bot = fakeBot();
        app.set('bot', bot);
        app.use(require('../../src/admin/routes/actions'));
        const server = await new Promise((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        try {
            row(60);
            row(61, { bot_status: 'stopped' });
            const res = await fetch(`http://127.0.0.1:${server.address().port}/api/broadcast`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'hi', target: 'all' })
            });
            assert.deepEqual(await res.json(), { success: true, successCount: 1, failCount: 0, leftCount: 1 });
            assert.deepEqual(
                bot.sent.map((m) => m.chatId),
                [60]
            );
        } finally {
            server.close();
        }
    });
});

describe('review fixes', () => {
    test("Telegram's own note that the bot left is not the group using it", () => {
        const chat = { id: -100, type: 'supergroup' };
        const from = { id: 5 };
        const date = Date.parse('2026-10-20T10:00:00Z') / 1000;
        assert.equal(seenAt({ chat, from, message: { date, left_chat_member: { id: 1 } } }), null);
        assert.equal(seenAt({ chat, from, message: { date, new_chat_members: [{ id: 1 }] } }), null);
        // A message, by its own time to the second; a button, now
        assert.equal(
            seenAt({ chat, from, message: { date, text: '/subs' } }).toISOString(),
            '2026-10-20T10:00:00.000Z'
        );
        assert.ok(seenAt({ chat, from, callbackQuery: { data: 'x' } }) instanceof Date);
        assert.equal(seenAt({ chat: null, from }), null);
    });

    test('a message in the same second as the removal does not bring the group back', async () => {
        const at = new Date('2026-10-20T10:00:00Z');
        const group = row(-200, { type: 'supergroup', bot_status: 'removed', bot_status_at: at });
        status.noteSeen(-200, new Date(at));
        await status.flushStatus();
        assert.equal(group.bot_status, 'removed');
    });

    test('the bot leaving a chat it keeps nothing for (an old group, moved) makes no row', async () => {
        process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:test';
        const bot = require('../../src/bot');
        bot.botInfo = { id: 1, is_bot: true, username: 'test_bot', first_name: 'Test' };
        const me = { id: 1, is_bot: true, first_name: 'Test' };
        await bot.handleUpdate({
            update_id: 10,
            my_chat_member: {
                chat: { id: -300, type: 'group', title: 'Old' },
                from: { id: 5, is_bot: false, first_name: 'Masha' },
                date: 1,
                old_chat_member: { user: me, status: 'member' },
                new_chat_member: { user: me, status: 'left' }
            }
        });
        assert.equal(rows.has('-300'), false);
        assert.deepEqual(botEvents(), []);
    });

    test('after a start, a group marked removed that has the bot again is back', async () => {
        const back = row(-400, { type: 'supergroup', bot_status: 'removed', bot_status_at: new Date('2026-10-01') });
        const gone = row(-401, { type: 'supergroup', bot_status: 'removed', bot_status_at: new Date('2026-10-01') });
        const findAll = mock.method(Chat, 'findAll', async ({ where }) =>
            where.bot_status ? [back, gone] : where.id.map((id) => rows.get(String(id))).filter(Boolean)
        );
        const asked = [];
        const bot = {
            telegram: {
                getChatMember: async (chatId, userId) => {
                    asked.push([chatId, userId]);
                    if (chatId === -400) return { status: 'member' };
                    throw new Error('Bad Request: member not found');
                }
            }
        };
        try {
            await recheckRemoved(bot, 1);
        } finally {
            findAll.mock.restore();
        }
        assert.deepEqual(asked, [
            [-400, 1],
            [-401, 1]
        ]);
        assert.equal(back.bot_status, 'active');
        assert.equal(gone.bot_status, 'removed');
        assert.deepEqual(botEvents(), [['-400', 'bot_on', 'returned', null]]);
    });
});
