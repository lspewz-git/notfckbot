/**
 * A handler that throws must not stop the bot: without a catch-all, Telegraf rethrows and its
 * polling loop ends, and the bot stops answering everyone. Run: npm run test:unit
 */
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Telegram } = require('telegraf');

// No network: every Bot API call "succeeds" and is recorded
const calls = [];
mock.method(Telegram.prototype, 'callApi', async (method, payload) => {
    calls.push({ method, payload });
    return true;
});
mock.method(console, 'error', () => {});

// No database: the middleware records every chat it sees; here it finds a plain, unblocked one
const { Chat } = require('../../src/db');
mock.method(Chat, 'findOrCreate', async ({ where, defaults }) => [
    { id: where.id, ...defaults, blockedUntil: null, menu_enabled: true, update: async () => {} },
    false
]);

process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:test';
const bot = require('../../src/bot');
bot.botInfo = { id: 1, is_bot: true, username: 'test_bot', first_name: 'Test' };

bot.action('explode', () => {
    throw new Error('Bad Request: message to edit not found');
});

const press = (data, updateId) => ({
    update_id: updateId,
    callback_query: {
        id: `q${updateId}`,
        from: { id: 777, is_bot: false, first_name: 'U' },
        chat_instance: '1',
        data,
        message: { message_id: 5, date: 0, chat: { id: 555, type: 'private' }, text: 'list' }
    }
});

test('an error in a button handler is caught: the bot carries on and tells the user', async () => {
    await assert.doesNotReject(bot.handleUpdate(press('explode', 1)));
    const answer = calls.find((c) => c.method === 'answerCallbackQuery');
    assert.ok(answer, 'the button press is answered');
    assert.match(answer.payload.text, /Что-то пошло не так/);
});
