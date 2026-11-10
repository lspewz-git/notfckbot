const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { notificationTarget, notificationButton } = require('../../src/app-links');
const { miniAppUser } = require('../../src/account/miniapp');
const { PendingMessage, HeldNotification, Chat } = require('../../src/db');
const { notify, flushPending } = require('../../src/cron/outbox');
const { deliver } = require('../../src/delivery');

const botInfo = { username: 'notfckbot', has_main_web_app: true };
const url = (extra) => extra.reply_markup.inline_keyboard[0][0].url;
const event = { detail: 'episode', tmdb_id: 'tv_100', title: 'Show' };

test('release buttons name the title and chat, and unsupported/invalid targets have no button', () => {
    for (const detail of ['episode', 'premiere', 'complete', 'film', 'film_digital']) {
        const target = detail.startsWith('film') ? 'movie_7' : 'tv_100';
        assert.equal(notificationTarget({ detail, tmdb_id: target }), target);
        const extra = notificationButton({ botInfo }, '-100123', target);
        assert.equal(extra.reply_markup.inline_keyboard[0][0].text, 'Открыть WebApp');
        assert.equal(url(extra), `https://t.me/notfckbot?startapp=c-100123_${target}`);
        assert.ok(new URL(url(extra)).searchParams.get('startapp').length <= 512);
    }
    assert.equal(url(notificationButton({ botInfo }, 42, 'movie_7')), 'https://t.me/notfckbot?startapp=c42_movie_7');
    for (const target of [null, 'tv_0', 'movie_1?x=y', 'movie_12345678901'])
        assert.deepEqual(notificationButton({ botInfo }, 42, target), {});
    assert.deepEqual(notificationButton({ botInfo: { username: 'notfckbot' } }, 42, 'tv_1'), {});
    assert.equal(notificationTarget({ ...event, detail: 'status' }), null);
});

test('only signed launch data supplies the title; old chat links still work', () => {
    const token = 'test-only-token';
    const signed = (start) => {
        const fields = {
            auth_date: String(Math.floor(Date.now() / 1000)),
            user: '{"id":42,"first_name":"T"}',
            start_param: start
        };
        const key = createHmac('sha256', 'WebAppData').update(token).digest();
        const check = Object.keys(fields)
            .sort()
            .map((k) => `${k}=${fields[k]}`)
            .join('\n');
        return new URLSearchParams({
            ...fields,
            hash: createHmac('sha256', key).update(check).digest('hex')
        }).toString();
    };
    for (const target of ['tv_100', 'movie_7']) {
        const launch = signed(`c-100_${target}`);
        const user = miniAppUser(launch, token);
        assert.deepEqual([user.startChat, user.title], ['-100', target]);
        assert.equal(miniAppUser(launch.replace(target, 'tv_999'), token), null);
    }
    assert.equal(miniAppUser(signed('c-100'), token).title, null);
    assert.equal(miniAppUser(signed('c-100_movie_0'), token).title, null);
});

test('direct sends, poster fallback and queued retries retain the Open button', async (t) => {
    t.mock.method(require('../../src/chat-events'), 'record', () => {});
    t.mock.method(Chat, 'findByPk', async () => null);
    t.mock.method(PendingMessage, 'findAll', async () => []);
    const sent = [];
    const bot = {
        botInfo,
        telegram: {
            sendMessage: async (id, text, extra) => sent.push({ id, extra }),
            sendPhoto: async () => {
                throw Object.assign(new Error('Bad photo'), {
                    response: { error_code: 400, description: 'Bad Request: wrong file identifier/HTTP URL specified' }
                });
            }
        }
    };
    await flushPending(bot);
    assert.equal((await notify(bot, -100, 'Episode', { event, photo: 'bad.jpg' })).status, 'sent');
    assert.match(url(sent[0].extra), /c-100_tv_100$/);
    let destroyed = false;
    t.mock.method(PendingMessage, 'findAll', async () => [
        {
            chatId: '-100999',
            text: 'Retry',
            app_target: 'movie_7',
            attempts: 1,
            createdAt: new Date(),
            destroy: async () => {
                destroyed = true;
            }
        }
    ]);
    await flushPending(bot);
    assert.match(url(sent[1].extra), /c-100999_movie_7$/);
    assert.equal(destroyed, true);
});

test('quiet-hour storage and full held notifications retain their title and button after poster failure', async (t) => {
    t.mock.method(require('../../src/chat-events'), 'record', () => {});
    const hour = require('../../src/quiet').hourIn('Europe/Moscow');
    t.mock.method(Chat, 'findByPk', async () => ({
        quiet_start: hour,
        quiet_end: (hour + 2) % 24,
        timezone: 'Europe/Moscow'
    }));
    t.mock.method(PendingMessage, 'findAll', async () => []);
    await flushPending({});
    let held;
    t.mock.method(HeldNotification, 'create', async (row) => {
        held = row;
    });
    assert.equal((await notify({ botInfo }, -100, 'Text', { event, line: 'Episode', label: 'Show' })).status, 'held');
    assert.equal(held.app_target, 'tv_100');
    let handler;
    require('../../src/bot/held').register({
        action: (_, fn) => {
            handler = fn;
        }
    });
    t.mock.method(HeldNotification, 'findOne', async () => ({ ...held, photo: 'bad.jpg' }));
    let extra;
    await handler({
        botInfo,
        chat: { id: -100 },
        match: ['held_1', '1'],
        answerCbQuery: async () => {},
        replyWithPhoto: async () => {
            throw new Error('Bad photo');
        },
        reply: async (_, options) => {
            extra = options;
        }
    });
    assert.match(url(extra), /c-100_tv_100$/);
});

test('a group migration rebuilds the button for the destination chat', async (t) => {
    t.mock.method(require('../../src/chat-migration'), 'migrateChat', async () => true);
    const calls = [];
    const bot = {
        botInfo,
        telegram: {
            sendMessage: async (id, text, extra) => {
                calls.push({ id, extra });
                if (id === -123)
                    throw Object.assign(new Error('moved'), {
                        response: { error_code: 400, parameters: { migrate_to_chat_id: -100999 }, description: 'moved' }
                    });
            }
        }
    };
    await deliver(bot, -123, 'Film', { extra: (id) => notificationButton(bot, id, 'movie_7') });
    assert.deepEqual(
        calls.map((c) => url(c.extra)),
        ['https://t.me/notfckbot?startapp=c-123_movie_7', 'https://t.me/notfckbot?startapp=c-100999_movie_7']
    );
});
