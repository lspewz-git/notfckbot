/**
 * Quiet hours: when a chat is in them (src/quiet.js), notifications held instead of sent
 * (src/cron/outbox.js), the list that goes out when they end (src/cron/held.js), and the bot's
 * screens for them (src/bot/settings.js). Run: npm run test:unit
 */
const { test, describe, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { Chat, HeldNotification } = require('../../src/db');
const { ZONES, isQuietNow, quietLabel, hourIn } = require('../../src/quiet');
const { notify, flushPending } = require('../../src/cron/outbox');
const { releaseHeld, heldView } = require('../../src/cron/held');
const { heldLine } = require('../../src/cron/messages');
const { quietView, zoneView, settingsView } = require('../../src/bot/settings');

// 14 October 2026, in UTC: 20:30 is 23:30 in Moscow and 06:30 the next day in Vladivostok
const at = (utc) => new Date(`2026-10-14T${utc}:00Z`);
const chat = (fields) => ({ id: 10, quiet_start: 23, quiet_end: 8, timezone: 'Europe/Moscow', ...fields });

describe('isQuietNow', () => {
    test('hours over midnight: 23–08 in Moscow', () => {
        assert.equal(isQuietNow(chat(), at('20:30')), true, '23:30 Moscow');
        assert.equal(isQuietNow(chat(), at('02:00')), true, '05:00 Moscow');
        assert.equal(isQuietNow(chat(), at('05:00')), false, '08:00 Moscow: the hours are over');
        assert.equal(isQuietNow(chat(), at('19:59')), false, '22:59 Moscow');
    });

    test('hours within a day: 01–10', () => {
        const c = chat({ quiet_start: 1, quiet_end: 10 });
        assert.equal(isQuietNow(c, at('21:30')), false, '00:30 Moscow');
        assert.equal(isQuietNow(c, at('22:00')), true, '01:00 Moscow');
        assert.equal(isQuietNow(c, at('07:00')), false, '10:00 Moscow');
    });

    test("the chat's own time zone counts", () => {
        assert.equal(hourIn('Asia/Vladivostok', at('20:30')), 6);
        assert.equal(isQuietNow(chat({ timezone: 'Asia/Vladivostok' }), at('20:30')), true);
        assert.equal(isQuietNow(chat({ timezone: 'Asia/Vladivostok' }), at('23:00')), false, '09:00 there');
        // An unknown zone falls back to Moscow, not to an error
        assert.equal(isQuietNow(chat({ timezone: 'Mars/Olympus' }), at('20:30')), true);
    });

    test('off: no hours, one of them missing, or the same hour twice', () => {
        for (const c of [
            chat({ quiet_start: null, quiet_end: null }),
            chat({ quiet_end: null }),
            chat({ quiet_end: 23 }),
            null
        ]) {
            assert.equal(isQuietNow(c, at('20:30')), false);
        }
    });

    test('the label: hours and city, or null when off', () => {
        assert.equal(quietLabel(chat()), '23:00–08:00 (Москва)');
        assert.equal(quietLabel(chat({ quiet_start: null })), null);
        assert.equal(quietLabel(chat({ timezone: 'Asia/Omsk' }), 'en'), '23:00–08:00 (Omsk)');
    });
});

describe('holding', () => {
    let held;
    let sent;
    const bot = {
        telegram: {
            sendMessage: async (chatId, text) => sent.push({ chatId, text }),
            sendPhoto: async (chatId, photo, opts) => sent.push({ chatId, text: opts.caption, photo })
        }
    };

    beforeEach(async () => {
        held = [];
        sent = [];
        mock.method(HeldNotification, 'create', async (fields) => held.push(fields));
        mock.method(Chat, 'findByPk', async (id) => (id === 10 ? chat() : null));
        // A new check: chat settings are read afresh
        mock.method(require('../../src/db').PendingMessage, 'findAll', async () => []);
        await flushPending(bot);
    });

    test('in quiet hours a notification is held, with its line and button, not sent', async () => {
        mock.timers.enable({ apis: ['Date'], now: at('20:30') });
        try {
            const line = heldLine({ kind: 'episode', title: 'Пацаны', season: 5, episode: 4, episodeName: 'Пилот' });
            const result = await notify(bot, 10, 'full text', { photo: 'p.jpg', about: 'Пацаны', ...line });
            assert.equal(result.status, 'held');
        } finally {
            mock.timers.reset();
        }
        assert.deepEqual(sent, []);
        assert.deepEqual(held, [
            {
                chatId: 10,
                line: '📺 <b>Пацаны</b> — серия S5E4 «Пилот»',
                label: 'Пацаны S5E4',
                text: 'full text',
                photo: 'p.jpg'
            }
        ]);
    });

    test('outside them, or for a chat without them, it goes out as usual', async () => {
        mock.timers.enable({ apis: ['Date'], now: at('12:00') });
        try {
            await notify(bot, 10, 'day text', { about: 'A', ...heldLine({ kind: 'film', title: 'A' }) });
            await notify(bot, 11, 'other chat', { about: 'B', ...heldLine({ kind: 'film', title: 'B' }) });
        } finally {
            mock.timers.reset();
        }
        assert.deepEqual(
            sent.map((s) => s.text),
            ['day text', 'other chat']
        );
        assert.equal(held.length, 0);
    });
});

test('a queued retry waits out quiet hours too, without spending a try', async () => {
    const { PendingMessage } = require('../../src/db');
    const row = {
        id: 1,
        chatId: 10,
        text: 'retry',
        photo: null,
        attempts: 0,
        createdAt: at('19:00'),
        destroyed: false,
        async destroy() {
            this.destroyed = true;
        },
        async update(changes) {
            Object.assign(this, changes);
        }
    };
    mock.method(PendingMessage, 'findAll', async () => [row]);
    mock.method(Chat, 'findByPk', async () => chat());
    const sent = [];
    const bot = { telegram: { sendMessage: async (id, text) => sent.push(text) } };

    await flushPending(bot, at('21:00')); // midnight in Moscow
    assert.deepEqual([sent.length, row.destroyed, row.attempts], [0, false, 0]);
    await flushPending(bot, at('06:00')); // 09:00
    assert.deepEqual([sent, row.destroyed], [['retry'], true]);
});

describe('the list after quiet hours', () => {
    const row = (id, fields = {}) => ({
        id,
        chatId: 10,
        line: `📺 <b>Сериал ${id}</b> — серия S1E${id}`,
        label: `Сериал ${id} S1E${id}`,
        ...fields
    });

    test('a line per notification, a button per notification that sends it', () => {
        const view = heldView([row(1), row(2), row(3)]);
        assert.match(view.text, /^🌅 <b>Пока вы спали<\/b>\n\n📺 <b>Сериал 1<\/b>/);
        const buttons = view.keyboard.reply_markup.inline_keyboard;
        assert.deepEqual(
            buttons.map((r) => r.map((b) => b.callback_data)),
            [['held_1', 'held_2'], ['held_3'], ['cal_w_0']]
        );
    });

    test("a long night stays under Telegram's limit, and at ten buttons", () => {
        const many = Array.from({ length: 60 }, (_, i) =>
            row(i + 1, {
                line: `📺 <b>Очень длинное название сериала номер ${i + 1}</b> — серия S1E${i + 1} «${'х'.repeat(40)}»`
            })
        );
        const view = heldView(many);
        assert.ok(view.text.length < 4096, String(view.text.length));
        assert.match(view.text, /…и ещё \d+/);
        const data = view.keyboard.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
        assert.equal(data.filter((d) => d.startsWith('held_')).length, 10);
        assert.equal(data.at(-1), 'cal_w_0', 'and the week ahead');
    });

    test('sent once the hours are over; kept while they last; kept after a failed send', async () => {
        const rows = [row(1), row(2)];
        const updates = [];
        mock.method(HeldNotification, 'findAll', async () => rows);
        mock.method(HeldNotification, 'update', async (fields, { where }) => updates.push({ fields, ids: where.id }));
        mock.method(HeldNotification, 'destroy', async () => 0);
        mock.method(Chat, 'findByPk', async () => chat());
        const sent = [];
        let down = false;
        const bot = {
            telegram: {
                sendMessage: async (chatId, text, extra) => {
                    if (down) throw Object.assign(new Error('500'), { response: { error_code: 500 } });
                    sent.push({ chatId, text, buttons: extra.reply_markup.inline_keyboard.length });
                }
            }
        };

        await releaseHeld(bot, at('22:00'));
        assert.equal(sent.length, 0, 'still 01:00 in Moscow');

        down = true;
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const releasing = releaseHeld(bot, at('06:00'));
            for (let i = 0; i < 10; i++) {
                for (let j = 0; j < 50; j++) await Promise.resolve();
                mock.timers.tick(10000);
            }
            await releasing;
        } finally {
            mock.timers.reset();
        }
        assert.equal(updates.length, 0, 'a failed send leaves them held');

        down = false;
        await releaseHeld(bot, at('06:00'));
        assert.equal(sent.length, 1);
        assert.match(sent[0].text, /Сериал 1[\s\S]*Сериал 2/);
        assert.deepEqual(updates[0].ids, [1, 2]);
    });
});

describe('the bot screens', () => {
    const buttons = (view) =>
        view.keyboard.reply_markup.inline_keyboard.flat().map((b) => `${b.text}|${b.callback_data}`);

    test('settings show the quiet hours and lead to them', () => {
        const view = settingsView({ type: 'private' }, chat());
        assert.match(view.text, /🌙 Тихие часы: <b>23:00–08:00 \(Москва\)<\/b>/);
        assert.ok(buttons(view).includes('🌙 Тихие часы|settings_quiet'));
        assert.match(settingsView({ type: 'private' }, chat({ quiet_start: null })).text, /Тихие часы: <b>выключены/);
    });

    test('quiet hours: the current choice ticked, "off" only when on, the zone, the way back', () => {
        const on = buttons(quietView(chat()));
        assert.ok(on.includes('✅ 23:00–08:00|settings_quiet_23_8'));
        assert.ok(on.includes('Выключить|settings_quiet_off'));
        assert.ok(on.includes('🕓 Часовой пояс: Москва|settings_tz'));
        const off = buttons(quietView(chat({ quiet_start: null, quiet_end: null })));
        assert.ok(!off.some((b) => b.endsWith('|settings_quiet_off')));
    });

    test("zones: Russia's, the chat's ticked", () => {
        const list = buttons(zoneView(chat({ timezone: 'Asia/Omsk' })));
        assert.equal(list.length, ZONES.length + 1);
        assert.ok(list.includes(`✅ Омск +6|settings_tz_${ZONES.findIndex((z) => z.id === 'Asia/Omsk')}`));
    });
});

test("the panel's time zones are the server's", () => {
    const html = fs.readFileSync(path.join(__dirname, '../../admin/index.html'), 'utf8');
    const select = html.slice(
        html.indexOf('id="chat-settings-timezone"'),
        html.indexOf('</select>', html.indexOf('id="chat-settings-timezone"'))
    );
    const values = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(
        values,
        ZONES.map((z) => z.id)
    );
});

describe('PATCH /api/chat/:id/settings', () => {
    const express = require('express');
    let base;
    let server;
    let saved;

    const patch = (body) =>
        fetch(`${base}/api/chat/10/settings`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(async (res) => ({ status: res.status, body: await res.json() }));

    test('takes two different hours and a zone of the list; refuses anything else', async () => {
        const app = express();
        app.use(express.json());
        app.use(require('../../src/admin/routes/records'));
        await new Promise((resolve) => {
            server = app.listen(0, resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
        mock.method(Chat, 'findByPk', async () => ({
            ...chat({ quiet_start: null, quiet_end: null, digest_week: false, digest_month: false }),
            get() {
                return { ...this };
            },
            async update(changes) {
                saved = changes;
                Object.assign(this, changes);
            }
        }));
        try {
            const ok = await patch({ quiet_start: 22, quiet_end: 7, timezone: 'Asia/Omsk' });
            assert.equal(ok.status, 200);
            assert.deepEqual(saved, { quiet_start: 22, quiet_end: 7, timezone: 'Asia/Omsk' });

            const off = await patch({ quiet_start: null, quiet_end: null });
            assert.equal(off.status, 200);
            assert.deepEqual(saved, { quiet_start: null, quiet_end: null });

            // Turning a digest on: its first one is the next due, not one straight away
            const digests = await patch({ digest_week: true, digest_month: false });
            assert.equal(digests.status, 200);
            assert.equal(saved.digest_week, true);
            assert.ok('digest_week_sent' in saved, 'the period it starts from is set');
            assert.ok(!('digest_month_sent' in saved));

            for (const bad of [
                { quiet_start: 8, quiet_end: 8 },
                { quiet_start: 24, quiet_end: 8 },
                { quiet_start: '23', quiet_end: 8 },
                { quiet_start: 23 },
                { quiet_start: 1.5, quiet_end: 8 },
                { timezone: 'Europe/London' },
                { digest_week: 'yes' }
            ]) {
                saved = null;
                const res = await patch(bad);
                assert.equal(res.status, 400, JSON.stringify(bad));
                assert.equal(saved, null);
            }
        } finally {
            server.close();
        }
    });
});

describe('the bot buttons', () => {
    /** The handlers settings.js registers, by the first trigger that matches the data. */
    function handlers() {
        const actions = [];
        const fake = {
            command() {},
            hears() {},
            action(trigger, handler) {
                actions.push([trigger, handler]);
            }
        };
        require('../../src/bot/settings').register(fake);
        return async (data, ctx) => {
            for (const [trigger, handler] of actions) {
                const match = typeof trigger === 'string' ? (trigger === data ? [data] : null) : data.match(trigger);
                if (match) return handler(Object.assign(ctx, { match }));
            }
            throw new Error(`No handler for ${data}`);
        };
    }

    const ctxFor = ({ status = 'creator', type = 'supergroup' } = {}) => {
        const chatData = {
            ...chat({ quiet_start: null, quiet_end: null }),
            async update(changes) {
                Object.assign(this, changes);
            }
        };
        return {
            chat: { id: -100, type },
            from: { id: 5 },
            state: { chatData },
            answers: [],
            edits: [],
            getChatMember: async () => ({ status }),
            answerCbQuery(text) {
                this.answers.push(text);
            },
            editMessageText(text) {
                this.edits.push(text);
                return Promise.resolve();
            }
        };
    };

    test('an admin picks a preset and a zone; the screen updates', async () => {
        const press = handlers();
        const ctx = ctxFor();
        await press('settings_quiet_23_8', ctx);
        assert.equal(ctx.state.chatData.quiet_start, 23);
        assert.equal(ctx.state.chatData.quiet_end, 8);
        await press('settings_tz_8', ctx);
        assert.equal(ctx.state.chatData.timezone, ZONES[8].id);
        assert.match(ctx.edits.at(-1), /Часовой пояс: <b>Владивосток/);
        await press('settings_quiet_off', ctx);
        assert.equal(ctx.state.chatData.quiet_start, null);
    });

    test('a member of a group may look but not change', async () => {
        const press = handlers();
        const ctx = ctxFor({ status: 'member' });
        await press('settings_quiet', ctx);
        assert.equal(ctx.edits.length, 1, 'the screen opens');
        await press('settings_quiet_23_8', ctx);
        await press('settings_tz_1', ctx);
        assert.equal(ctx.state.chatData.quiet_start, null);
        assert.equal(ctx.state.chatData.timezone, 'Europe/Moscow');
        assert.match(ctx.answers.at(-1), /только её админы/);
    });

    test('made-up button data changes nothing', async () => {
        const press = handlers();
        const ctx = ctxFor();
        await press('settings_quiet_5_6', ctx);
        await press('settings_tz_99', ctx);
        assert.equal(ctx.state.chatData.quiet_start, null);
        assert.equal(ctx.state.chatData.timezone, 'Europe/Moscow');
    });
});
