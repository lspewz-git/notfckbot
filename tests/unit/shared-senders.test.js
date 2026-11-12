// Telegram's stand-ins (an anonymous group admin, a linked channel) reach every group under one id:
// the anti-spam limits count them per group, so one group can't silence the bot for the others
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Chat } = require('../../src/db');
const middleware = require('../../src/bot/middleware');

const ANONYMOUS_ADMIN = 1087968824;

function setup(t, { blockedUntil = null } = {}) {
    const handlers = [];
    middleware.register({ use: (fn) => handlers.push(fn) });
    const writes = [];
    t.mock.method(Chat, 'findOrCreate', async ({ where }) => [
        {
            id: where.id,
            username: where.id < 0 ? 'Group' : '@GroupAnonymousBot',
            chat_instance: null,
            blockedUntil: where.id < 0 ? null : blockedUntil,
            update: async (fields) => writes.push({ id: where.id, ...fields })
        }
    ]);
    let messageId = 0;
    /** One text message through a middleware; whether it reached the handlers. */
    const send = async (index, from, chatId, text) => {
        const ctx = {
            from: { id: from, username: from === ANONYMOUS_ADMIN ? 'GroupAnonymousBot' : 'u' },
            chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private', title: 'Group' },
            message: { text, message_id: ++messageId },
            state: {},
            telegram: { deleteMessage: async () => {} },
            reply: async () => {}
        };
        let passed = false;
        await handlers[index](ctx, async () => {
            passed = true;
        });
        return passed;
    };
    return { send, writes };
}

test('an anonymous admin repeating a message is blocked in that group only, not on the shared record', async (t) => {
    const { send, writes } = setup(t);
    assert.equal(await send(1, ANONYMOUS_ADMIN, -100, '/search'), true);
    assert.equal(await send(1, ANONYMOUS_ADMIN, -100, '/search'), true);
    // The third in a row: blocked
    assert.equal(await send(1, ANONYMOUS_ADMIN, -100, '/search'), false);
    assert.equal(await send(1, ANONYMOUS_ADMIN, -100, 'hello'), false);
    // Another group's anonymous admin is someone else
    assert.equal(await send(1, ANONYMOUS_ADMIN, -200, '/search'), true);
    assert.deepEqual(
        writes.filter((w) => 'blockedUntil' in w),
        []
    );
});

test("a block set in the panel on a stand-in's record still stops it in every group", async (t) => {
    const { send } = setup(t, { blockedUntil: new Date(Date.now() + 60000) });
    assert.equal(await send(1, ANONYMOUS_ADMIN, -500, 'hi'), false);
    assert.equal(await send(1, ANONYMOUS_ADMIN, -600, 'hi'), false);
});

test('a person repeating a message is still blocked on their own record, in every chat', async (t) => {
    const { send, writes } = setup(t);
    for (const passed of [true, true, false]) assert.equal(await send(1, 4201, -100, '/spam'), passed);
    const blocks = writes.filter((w) => 'blockedUntil' in w);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].id, 4201);
    assert.ok(blocks[0].blockedUntil.getTime() > Date.now());
});

test('the one-a-second throttle counts anonymous admins per group, a person across their chats', async (t) => {
    const { send } = setup(t);
    assert.equal(await send(0, ANONYMOUS_ADMIN, -300, 'a'), true);
    assert.equal(await send(0, ANONYMOUS_ADMIN, -400, 'a'), true);
    assert.equal(await send(0, ANONYMOUS_ADMIN, -300, 'b'), false);
    assert.equal(await send(0, 4202, -300, 'a'), true);
    assert.equal(await send(0, 4202, 4202, 'b'), false);
});
