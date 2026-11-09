const { test } = require('node:test');
const assert = require('node:assert/strict');
const { editView } = require('../../src/bot/message-view');

test('editing preserves HTML, the keyboard, preview options and the Telegram result', async () => {
    const view = {
        text: '<b>Calendar</b>',
        keyboard: { reply_markup: { inline_keyboard: [[{ text: 'Next', callback_data: 'next' }]] } }
    };
    const extra = { link_preview_options: { is_disabled: true } };
    const original = JSON.stringify({ view, extra });
    const message = { message_id: 42 };
    let calls = 0;
    const ctx = {
        async editMessageText(text, options) {
            calls++;
            assert.equal(this, ctx);
            assert.equal(text, view.text);
            assert.deepEqual(options, { parse_mode: 'HTML', ...extra, ...view.keyboard });
            return message;
        }
    };
    assert.equal(await editView(ctx, view, extra), message);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify({ view, extra }), original);
});

test('an unchanged message is harmless in both Telegram error shapes', async () => {
    for (const error of [
        { description: 'Bad Request: message is not modified', message: 'Telegram request failed' },
        new Error('400: Bad Request: message is not modified: specified new message content is exactly the same')
    ]) {
        let calls = 0;
        const ctx = {
            async editMessageText() {
                calls++;
                throw error;
            }
        };
        assert.equal(await editView(ctx, { text: 'Same page' }), undefined);
        assert.equal(calls, 1);
    }
});

test('other edit failures propagate unchanged without a replacement or a retry', async () => {
    for (const error of [
        new Error('Bad Request: message to edit not found'),
        new Error('Bad Request: cannot parse entities'),
        new Error('Too Many Requests: retry after 20'),
        new Error('Network connection reset'),
        new Error('A different resource was not modified')
    ]) {
        let calls = 0;
        const ctx = {
            async editMessageText() {
                calls++;
                throw error;
            }
        };
        await assert.rejects(editView(ctx, { text: 'Page' }), (caught) => caught === error);
        assert.equal(calls, 1);
    }
});
