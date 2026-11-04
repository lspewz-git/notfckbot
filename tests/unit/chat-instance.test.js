// A group's chat_instance is learned from button presses there (src/bot/middleware.js), so a Mini App
// opened from that group can open its page in the panel
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Chat } = require('../../src/db');
const middleware = require('../../src/bot/middleware');

/** The chat-record middleware (the second one registered), run on a fake update. */
async function press(t, { chatType = 'supergroup', instance, stored = null, failWrite = false }) {
    const handlers = [];
    middleware.register({ use: (fn) => handlers.push(fn) });
    const writes = [];
    t.mock.method(Chat, 'findOrCreate', async ({ where }) => [
        {
            id: where.id,
            username: where.id < 0 ? 'Group' : '@u',
            chat_instance: where.id < 0 ? stored : null,
            blockedUntil: null,
            update: async (fields) => {
                if (failWrite && 'chat_instance' in fields) throw new Error('db down');
                writes.push({ id: where.id, ...fields });
            }
        }
    ]);
    const ctx = {
        from: { id: 7, username: 'u' },
        chat: { id: -100, type: chatType, title: 'Group' },
        callbackQuery: { data: 'x', chat_instance: instance },
        state: {}
    };
    let passed = false;
    await handlers[1](ctx, async () => {
        passed = true;
    });
    return { writes, passed };
}

test('a button press in a group stores its chat_instance once', async (t) => {
    const first = await press(t, { instance: '-4242' });
    assert.deepEqual(first.writes, [{ id: -100, chat_instance: '-4242' }]);
    assert.equal(first.passed, true);
    t.mock.restoreAll();
    assert.deepEqual((await press(t, { instance: '-4242', stored: '-4242' })).writes, []);
});

test('chat_instance is ignored outside groups and when malformed', async (t) => {
    assert.deepEqual((await press(t, { chatType: 'channel', instance: '-1' })).writes, []);
    t.mock.restoreAll();
    assert.deepEqual((await press(t, { instance: 'abc' })).writes, []);
    t.mock.restoreAll();
    assert.deepEqual((await press(t, { instance: undefined })).writes, []);
});

test('a failed chat_instance write does not break the button', async (t) => {
    const { passed } = await press(t, { instance: '-4242', failWrite: true });
    assert.equal(passed, true);
});
