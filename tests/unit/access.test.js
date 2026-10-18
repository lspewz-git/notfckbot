/**
 * Who may press the bot's buttons in a group (src/bot/access.js), and the settings screen that
 * changes it (src/bot/settings.js). Runs the real bot on a stubbed Telegram and database.
 * Run: npm run test:unit
 */
const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Telegram } = require('telegraf');

// --- Telegram, stubbed: messages get ids; getChatMember answers from `memberStatus` ---
let nextMessageId = 1000;
let calls = [];
const memberStatus = {};
mock.method(Telegram.prototype, 'callApi', async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'sendMessage') return { message_id: nextMessageId++, chat: { id: payload.chat_id }, date: 0 };
    if (method === 'getChatMember') return { status: memberStatus[payload.user_id] || 'member' };
    return true;
});

// --- The database, stubbed: one group and its members ---
const GROUP = -1001;
const rows = new Map();
const { Chat } = require('../../src/db');
mock.method(Chat, 'findOrCreate', async ({ where, defaults }) => {
    if (!rows.has(where.id)) {
        const row = {
            id: where.id,
            ...defaults,
            menu_enabled: true,
            buttons_mode: 'owner',
            blockedUntil: null,
            async update(changes) {
                Object.assign(row, changes);
            }
        };
        rows.set(where.id, row);
    }
    return [rows.get(where.id), false];
});

process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:test';
const bot = require('../../src/bot');
bot.botInfo = { id: 1, is_bot: true, username: 'test_bot', first_name: 'Test' };

// A message with a button, and the button's handler, for the tests
const pressed = [];
bot.command('probe', (ctx) =>
    ctx.reply('probe', { reply_markup: { inline_keyboard: [[{ text: 'p', callback_data: 'probe' }]] } })
);
bot.action('probe', (ctx) => {
    pressed.push(ctx.from.id);
    return ctx.answerCbQuery();
});

let updateId = 1;
const chatOf = (chatId) =>
    chatId === GROUP ? { id: GROUP, type: 'supergroup', title: 'Group' } : { id: chatId, type: 'private' };
const user = (id) => ({ id, is_bot: false, first_name: `U${id}` });

/** `userId` sends /probe in `chatId`; resolves to the id of the bot's message with the button. */
async function callUp(userId, chatId = GROUP) {
    const before = nextMessageId;
    await bot.handleUpdate({
        update_id: updateId++,
        message: {
            message_id: 1,
            date: 0,
            chat: chatOf(chatId),
            from: user(userId),
            text: '/probe',
            entities: [{ type: 'bot_command', offset: 0, length: 6 }]
        }
    });
    assert.equal(nextMessageId, before + 1, 'the bot answered with one message');
    return before;
}

/** `userId` presses `data` on message `messageId`; resolves to the popup text, if any. */
async function press(userId, messageId, data = 'probe', chatId = GROUP) {
    calls = [];
    await bot.handleUpdate({
        update_id: updateId++,
        callback_query: {
            id: `q${updateId}`,
            from: user(userId),
            chat_instance: '1',
            data,
            message: { message_id: messageId, date: 0, chat: chatOf(chatId), text: 'x' }
        }
    });
    const answer = calls.find((c) => c.method === 'answerCallbackQuery');
    return answer && answer.payload.show_alert ? answer.payload.text : null;
}

// The bot throttles each user's taps (400 ms) and messages (1 s): every step uses a fresh user id
let fresh = 100;
const someone = () => fresh++;

beforeEach(() => {
    pressed.length = 0;
    rows.delete(GROUP);
});

test('in a group, by default only whoever called the buttons up can press them', async () => {
    const owner = someone();
    const other = someone();
    const message = await callUp(owner);

    assert.match(await press(other, message), /только тот, кто их вызвал/);
    assert.deepEqual(pressed, []);
    // The bot's anti-spam wants 0.4 s between one user's message and their next tap
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(await press(owner, message), null);
    assert.deepEqual(pressed, [owner]);
});

test('with the chat set to "all", anyone can', async () => {
    const message = await callUp(someone());
    (await Chat.findOrCreate({ where: { id: GROUP }, defaults: {} }))[0].buttons_mode = 'all';
    const other = someone();
    assert.equal(await press(other, message), null);
    assert.deepEqual(pressed, [other]);
});

test("buttons whose owner the bot doesn't know (before a restart) ask to call the menu again", async () => {
    await callUp(someone()); // the group row exists
    assert.match(await press(someone(), 1), /устарели/);
    assert.deepEqual(pressed, []);
});

test('a private chat is never restricted', async () => {
    const me = someone();
    assert.equal(await press(me, 1, 'probe', me), null);
    assert.deepEqual(pressed, [me]);
});

test('the settings screen and its buttons: anyone sees them, only admins change them', async () => {
    const message = await callUp(someone());
    const member = someone();
    const admin = someone();
    memberStatus[admin] = 'administrator';

    // A member's press is let through by access.js (settings check rights themselves)...
    assert.match(await press(member, message, 'settings_buttons_all'), /только её админы/);
    assert.equal(rows.get(GROUP).buttons_mode, 'owner');
    // ...and an admin's changes the mode
    assert.equal(await press(admin, message, 'settings_buttons_all'), null);
    assert.equal(rows.get(GROUP).buttons_mode, 'all');
});

test('/menu_off in a group: refused for a member, done for an admin', async () => {
    const send = (userId, text) =>
        bot.handleUpdate({
            update_id: updateId++,
            message: {
                message_id: 1,
                date: 0,
                chat: chatOf(GROUP),
                from: user(userId),
                text,
                entities: [{ type: 'bot_command', offset: 0, length: text.length }]
            }
        });
    await callUp(someone());
    calls = [];
    await send(someone(), '/menu_off');
    assert.equal(rows.get(GROUP).menu_enabled, true);
    assert.match(calls.find((c) => c.method === 'sendMessage').payload.text, /только её админы/);

    const admin = someone();
    memberStatus[admin] = 'creator';
    await send(admin, '/menu_off');
    assert.equal(rows.get(GROUP).menu_enabled, false);
});

test('an admin posting anonymously (as the group) can use /menu_on', async () => {
    await callUp(someone());
    rows.get(GROUP).menu_enabled = false;
    // Telegram sends such a message from @GroupAnonymousBot, with the group as its sender
    await bot.handleUpdate({
        update_id: updateId++,
        message: {
            message_id: 1,
            date: 0,
            chat: chatOf(GROUP),
            from: { id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' },
            sender_chat: chatOf(GROUP),
            text: '/menu_on',
            entities: [{ type: 'bot_command', offset: 0, length: 8 }]
        }
    });
    assert.equal(rows.get(GROUP).menu_enabled, true);
});

test("a member can't close someone else's settings; the one who opened them can", async () => {
    const opener = someone();
    await callUp(someone()); // the group row exists
    calls = [];
    await bot.handleUpdate({
        update_id: updateId++,
        message: {
            message_id: 1,
            date: 0,
            chat: chatOf(GROUP),
            from: user(opener),
            text: '/settings',
            entities: [{ type: 'bot_command', offset: 0, length: 9 }]
        }
    });
    const settingsMessage = nextMessageId - 1;

    assert.match(await press(someone(), settingsMessage, 'settings_close'), /тот, кто открыл/);
    assert.ok(!calls.some((c) => c.method === 'deleteMessage'));
    await new Promise((r) => setTimeout(r, 450)); // the opener's anti-spam gap
    assert.equal(await press(opener, settingsMessage, 'settings_close'), null);
    assert.ok(calls.some((c) => c.method === 'deleteMessage'));
});
