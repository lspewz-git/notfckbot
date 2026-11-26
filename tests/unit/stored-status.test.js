/** Legacy status messages already saved before the catalog wording changed. */
const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../src/db');
const { fakeBot } = require('./fakes');
const { flushPending } = require('../../src/cron/outbox');
const { heldView } = require('../../src/cron/held');
const title = 'Бегущий &lt;2099&gt;';
const legacy = (head) => `${head}\n\n📺 <b>${title}</b>\n\nНовых серий не будет. Если сериал продлят, я сообщу.`;
const unsafe = /Новых серий не будет|Сериал завершён|Сериал отменён|Сериал продлили/i;

beforeEach(() => {
    mock.method(db.Chat, 'findByPk', async () => null);
    for (const model of [db.SendFailure, db.SentNotification]) {
        mock.method(model, 'create', async () => {});
        mock.method(model, 'destroy', async () => 0);
    }
});

for (const header of ['🏁 <b>Сериал завершён</b>', '⛔ <b>Сериал отменён</b>', '🎉 <b>Сериал продлили!</b>']) {
    test(`audit: pending legacy status is neutralized: ${header}`, async () => {
        let destroyed = false;
        mock.method(db.PendingMessage, 'findAll', async () => [
            {
                chatId: 10,
                text: legacy(header),
                attempts: 0,
                createdAt: new Date(),
                destroy: async () => {
                    destroyed = true;
                }
            }
        ]);
        const bot = fakeBot();
        await flushPending(bot);
        assert.equal(bot.sent.length, 1);
        assert.doesNotMatch(bot.sent[0].text, unsafe);
        assert.ok(bot.sent[0].text.includes(title));
        assert.equal(destroyed, true);
    });
}

test('audit: an old held message is safe in both its summary and photo caption', async () => {
    const item = {
        id: 7,
        label: 'Saved',
        line: `📺 <b>${title}</b> — сериал завершён`,
        text: legacy('🏁 <b>Сериал завершён</b>'),
        photo: 'poster.jpg'
    };
    assert.doesNotMatch(heldView([item]).text, unsafe);
    mock.method(db.HeldNotification, 'findOne', async () => item);
    let handler;
    require('../../src/bot/held').register({
        action: (_, fn) => {
            handler = fn;
        }
    });
    const sent = [];
    await handler({
        botInfo: {},
        chat: { id: 10 },
        match: ['held_7', '7'],
        answerCbQuery: async () => {},
        replyWithPhoto: async (_, options) => {
            sent.push(options.caption);
            return {};
        },
        reply: async (text) => sent.push(text)
    });
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0], unsafe);
    assert.ok(sent[0].includes(title));
});

test('audit: episode text quoting a status phrase is not rewritten', async () => {
    const text = '⚡️ Новая серия! <b>Сериал завершён</b> — Серия 2';
    mock.method(db.PendingMessage, 'findAll', async () => [
        { chatId: 10, text, attempts: 0, createdAt: new Date(), destroy: async () => {} }
    ]);
    const bot = fakeBot();
    await flushPending(bot);
    assert.equal(bot.sent[0].text, text);
});

test('audit: held status text stays safe when its poster fails, including a test prefix', async () => {
    mock.method(db.HeldNotification, 'findOne', async () => ({
        text: `🧪 <b>[Тестовое уведомление]</b>\n\n${legacy('🎉 <b>Сериал продлили!</b>')}`,
        photo: 'broken.jpg'
    }));
    let handler;
    require('../../src/bot/held').register({
        action: (_, fn) => {
            handler = fn;
        }
    });
    const replies = [];
    await handler({
        botInfo: {},
        chat: { id: 10 },
        match: ['held_7', '7'],
        answerCbQuery: async () => {},
        replyWithPhoto: async () => {
            throw new Error('poster unavailable');
        },
        reply: async (text) => replies.push(text)
    });
    assert.equal(replies.length, 1);
    assert.match(replies[0], /^🧪 <b>\[Тестовое уведомление\]<\/b>/);
    assert.doesNotMatch(replies[0], unsafe);
    for (const status of ['сериал продлили', 'сериал отменён']) {
        assert.doesNotMatch(heldView([{ id: 7, label: 'Saved', line: `📺 <b>${title}</b> — ${status}` }]).text, unsafe);
    }
});
