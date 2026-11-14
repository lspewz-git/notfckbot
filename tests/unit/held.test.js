/**
 * The buttons under the after-quiet-hours list (src/bot/held.js). Anyone may press them, and button
 * data can be sent by hand, so a held notification opens only in the chat it was held for.
 * Run: npm run test:unit
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HeldNotification } = require('../../src/db');

const ROW = { id: 7, chatId: -100, text: 'Held text', photo: null, app_target: null };

function press(t, chatId) {
    // The database, stubbed: answers only what the query really asks for
    t.mock.method(HeldNotification, 'findOne', async ({ where }) =>
        where.id === ROW.id && where.chatId === ROW.chatId ? ROW : null
    );
    let handler;
    require('../../src/bot/held').register({ action: (_, fn) => (handler = fn) });
    const seen = { replies: [], popups: [] };
    return handler({
        botInfo: {},
        chat: { id: chatId },
        match: ['held_7', '7'],
        answerCbQuery: async (text) => seen.popups.push(text),
        reply: async (text) => seen.replies.push(text)
    }).then(() => seen);
}

test('a held notification opens in its own chat', async (t) => {
    const seen = await press(t, -100);
    assert.deepEqual(seen.replies, ['Held text']);
});

test('another chat pressing the same button by hand gets nothing of it', async (t) => {
    const seen = await press(t, -200);
    assert.deepEqual(seen.replies, []);
    assert.deepEqual(seen.popups, ['Это уведомление уже недоступно.']);
});
