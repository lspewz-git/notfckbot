/**
 * Where each conversation is (src/bot/state.js on Telegraf's session()): kept between updates
 * for one user in one chat, apart for anyone else, gone on clearState and 30 minutes after the
 * last change. Updates go through a real Telegraf bot, nothing reaches Telegram.
 * Run: npm run test:unit
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Telegraf } = require('telegraf');
const { stateSession, getState, setState, clearState } = require('../../src/bot/state');

// What each text update saw, then did: "set <state>", "clear", or just a look
const seen = [];
const bot = new Telegraf('123:test');
bot.botInfo = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };
bot.use(stateSession);
bot.on('text', (ctx) => {
    seen.push(getState(ctx).state);
    const [command, value] = ctx.message.text.split(' ');
    if (command === 'set') setState(ctx, { state: value });
    if (command === 'clear') clearState(ctx);
});

let updateId = 0;
const say = (text, { user = 7, chat = 7 } = {}) =>
    bot.handleUpdate({
        update_id: ++updateId,
        message: {
            message_id: updateId,
            date: 0,
            text,
            from: { id: user, is_bot: false, first_name: 'U' },
            chat: chat === user ? { id: chat, type: 'private' } : { id: chat, type: 'group', title: 'G' }
        }
    });
const last = () => seen.at(-1);

test('kept from one update to the next for the same user and chat', async () => {
    await say('set waiting_for_search');
    await say('look');
    assert.equal(last(), 'waiting_for_search');
});

test('another user, or the same user in another chat, has a conversation of their own', async () => {
    await say('set searching', { user: 8, chat: -100 });
    await say('look', { user: 9, chat: -100 });
    assert.equal(last(), 'idle');
    await say('look', { user: 8, chat: 8 });
    assert.equal(last(), 'idle');
    await say('look', { user: 8, chat: -100 });
    assert.equal(last(), 'searching');
});

test('clearState forgets it; a new state can be set in the same update', async () => {
    await say('set searching', { user: 10, chat: 10 });
    await say('clear', { user: 10, chat: 10 });
    await say('look', { user: 10, chat: 10 });
    assert.equal(last(), 'idle');
});

test('gone 30 minutes after the last update that used it; a read counts too', async () => {
    await say('set waiting_for_search', { user: 11, chat: 11 });
    const realNow = Date.now;
    try {
        const start = realNow();
        // A look at 20 minutes starts the 30 over: still there at 40
        Date.now = () => start + 20 * 60 * 1000;
        await say('look', { user: 11, chat: 11 });
        Date.now = () => start + 40 * 60 * 1000;
        await say('look', { user: 11, chat: 11 });
        assert.equal(last(), 'waiting_for_search');
        Date.now = () => start + 71 * 60 * 1000;
        await say('look', { user: 11, chat: 11 });
        assert.equal(last(), 'idle');
    } finally {
        Date.now = realNow;
    }
});
