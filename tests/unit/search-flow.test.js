/**
 * The bot's search, end to end on a fake Telegram: the handlers of src/bot/search.js run for real,
 * TMDB and the database are stubbed. Checks what the chat ends up with at each step — one message
 * that turns from the list into a card and back, never a pile of them. Run: npm run test:unit
 */
const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const tmdb = require('../../src/api/tmdb');
const kinopoisk = require('../../src/api/kinopoisk');
const { Series, Subscription, Watchlist } = require('../../src/db');

// --- TMDB and the database, stubbed ---
const film = (id, title, date) => ({ media_type: 'movie', id, title, release_date: date });
const RESULTS = [
    film(1, 'Курьер', '2026-12-18'),
    film(2, 'Курьер', '2019-11-08'),
    { media_type: 'tv', id: 3, name: 'Курьер', first_air_date: '2023-01-01' },
    ...Array.from({ length: 4 }, (_, i) => film(10 + i, `Фильм ${i}`, '2001-01-01'))
];
const DETAILS = {
    'movie:1': { id: 1, title: 'Курьер', release_date: '2099-12-18', status: 'Post Production', poster_path: '/a.jpg' },
    // Out already; opened only by the poster test, so its poster isn't cached by another test
    'movie:2': { id: 2, title: 'Курьер', release_date: '2019-11-08', status: 'Released', poster_path: '/b.jpg' },
    'tv:3': {
        id: 3,
        name: 'Курьер',
        first_air_date: '2023-01-01',
        number_of_seasons: 1,
        status: 'Returning Series',
        poster_path: null,
        last_episode_to_air: { season_number: 1, episode_number: 4, name: 'Четвёртая' }
    }
};
mock.method(tmdb, 'searchMulti', async () => RESULTS);
mock.method(tmdb, 'getDetails', async (id, type) => DETAILS[`${type}:${id}`]);
mock.method(tmdb, 'getDetailsCached', async (id, type) => DETAILS[`${type}:${id}`]);
mock.method(kinopoisk, 'kinopoiskQuick', async () => ({ kinopoiskId: null, ru: kinopoisk.NO_DATES }));
// Recorded: the list prefetches each film's Kinopoisk ID for its card
const kinopoiskAsked = [];
mock.method(kinopoisk, 'findKinopoiskId', async (tmdbId) => {
    kinopoiskAsked.push(tmdbId);
    return null;
});

let db;
beforeEach(() => {
    db = { series: new Map(), subs: [], watchlist: [] };
});
mock.method(Series, 'findOrCreate', async ({ where, defaults }) => {
    if (!db.series.has(where.tmdb_id))
        db.series.set(where.tmdb_id, { tmdb_id: where.tmdb_id, ...defaults, update: async () => {} });
    return [db.series.get(where.tmdb_id), false];
});
mock.method(Subscription, 'findOne', async ({ where }) => db.subs.find((s) => s.seriesId === where.seriesId) || null);
mock.method(Subscription, 'findOrCreate', async ({ where, defaults }) => {
    const sub = { ...where, ...defaults, update: async () => {} };
    db.subs.push(sub);
    return [sub, true];
});
mock.method(Watchlist, 'findOne', async () => null);
mock.method(Watchlist, 'findOrCreate', async ({ where, defaults }) => {
    db.watchlist.push({ ...where, ...defaults });
    return [{}, true];
});

// --- A fake bot that records handlers, and a fake chat that records what is on screen ---
function fakeBot() {
    const actions = [];
    let onText = null;
    const bot = {
        // Like Telegraf: several middlewares per button, each calling the next
        action: (trigger, ...fns) =>
            actions.push([
                trigger,
                (ctx) =>
                    fns.reduceRight(
                        (next, fn) => () => fn(ctx, next),
                        async () => {}
                    )()
            ]),
        on: (event, fn) => {
            if (event === 'text') onText = fn;
        }
    };
    require('../../src/bot/search').register(bot);
    return { actions, onText: () => onText };
}

function fakeChat() {
    let nextId = 100;
    // id -> { kind: 'text' | 'photo', text, buttons }
    const screen = new Map();
    const buttons = (extra) => (extra.reply_markup ? extra.reply_markup.inline_keyboard.flat() : []);
    // What each photo was sent as: a URL, or Telegram's file id of an earlier upload
    const photosSent = [];
    // Pop-up answers to button presses (show_alert), newest last
    const alerts = [];
    const post = (kind, text, extra = {}) => {
        const id = nextId++;
        const message = { message_id: id, ...(kind === 'photo' ? { photo: [{ file_id: `file-${id}` }] } : {}) };
        screen.set(message.message_id, { kind, text, buttons: buttons(extra) });
        return message;
    };
    const ctxFor = (message, extra = {}) => ({
        chat: { id: 555 },
        from: { id: 777 },
        state: {},
        callbackQuery: message ? { message } : undefined,
        answerCbQuery: async (text, opts) => {
            if (opts && opts.show_alert) alerts.push(text);
        },
        reply: async (text, opts) => post('text', text, opts),
        replyWithHTML: async (text, opts) => post('text', text, opts),
        replyWithPhoto: async (photo, opts) => {
            photosSent.push(photo);
            return post('photo', opts.caption, opts);
        },
        sendChatAction: async () => {},
        deleteMessage: async () => screen.delete(message.message_id),
        editMessageText: async (text, opts) => {
            const m = screen.get(message.message_id);
            if (!m || m.kind !== 'text') throw new Error('Bad Request: there is no text in the message to edit');
            screen.set(message.message_id, { kind: 'text', text, buttons: buttons(opts) });
        },
        telegram: { deleteMessage: async (chatId, id) => screen.delete(id) },
        ...extra
    });
    return { screen, ctxFor, photosSent, alerts };
}

/** Presses the button whose callback data is `data` on message `id`, as user `fromId`. */
async function press(bot, chat, id, data, fromId = 777) {
    const message = { message_id: id, ...(chat.screen.get(id).kind === 'photo' ? { photo: [{}] } : {}) };
    assert.ok(
        chat.screen.get(id).buttons.some((b) => b.callback_data === data),
        `no "${data}" button on message ${id}`
    );
    for (const [trigger, fn] of bot.actions) {
        const match = typeof trigger === 'string' ? (trigger === data ? [data] : null) : data.match(trigger);
        if (match) return fn({ ...chat.ctxFor(message, { from: { id: fromId } }), match });
    }
    throw new Error(`no handler for ${data}`);
}

const only = (chat) => {
    assert.equal(chat.screen.size, 1, `one search message on screen, not ${chat.screen.size}`);
    const [[id, m]] = chat.screen;
    return { id, ...m };
};

test('query → list → page 2 → card → back → card → subscribe, always one message', async () => {
    const bot = fakeBot();
    const chat = fakeChat();
    const { setState } = require('../../src/bot/state');
    const userCtx = chat.ctxFor(null, { message: { text: 'курьер' } });
    setState(userCtx, { state: 'waiting_for_search' });

    await bot.onText()(userCtx, async () => {});
    let screen = only(chat);
    assert.equal(screen.kind, 'text');
    assert.match(screen.text, /«курьер» — 7 вариантов/);
    assert.equal(screen.buttons.filter((b) => b.callback_data.startsWith('card_')).length, 5);

    // Page 2: the same message, edited
    await press(bot, chat, screen.id, 'page_1');
    const page2 = only(chat);
    assert.equal(page2.id, screen.id);
    assert.match(page2.buttons.map((b) => b.text).join(' '), /2 \/ 2/);

    // Back to page 1 and open a film: the list gives way to a photo card
    await press(bot, chat, page2.id, 'page_0');
    await press(bot, chat, screen.id, 'card_movie_1');
    screen = only(chat);
    assert.equal(screen.kind, 'photo');
    assert.match(screen.text, /Релиз:/);

    // Back: the card gives way to the list, on the page it was on
    await press(bot, chat, screen.id, 'back_to_results');
    screen = only(chat);
    assert.equal(screen.kind, 'text');
    assert.match(screen.buttons.map((b) => b.text).join(' '), /1 \/ 2/);

    // A series without a poster: a text card, then subscribing turns it into the confirmation
    await press(bot, chat, screen.id, 'card_tv_3');
    screen = only(chat);
    assert.match(screen.text, /Как уведомлять\?/);
    assert.equal(db.series.size, 0, 'opening a card saves nothing');
    await press(bot, chat, screen.id, 'sub_set_tv_3_season');
    screen = only(chat);
    assert.match(screen.text, /Вы успешно подписались на <b>«Курьер»<\/b>/);
    assert.deepEqual(
        db.subs.map((s) => [s.seriesId, s.notify_type]),
        [['tv_3', 'season']]
    );
    assert.ok(db.series.has('tv_3'), 'the series is saved on subscribing');
});

test('adding a film from its photo card replaces the card with the confirmation', async () => {
    const bot = fakeBot();
    const chat = fakeChat();
    const { setState } = require('../../src/bot/state');
    const userCtx = chat.ctxFor(null, { message: { text: 'курьер' } });
    setState(userCtx, { state: 'waiting_for_search' });
    await bot.onText()(userCtx, async () => {});

    await press(bot, chat, only(chat).id, 'card_movie_1');
    await press(bot, chat, only(chat).id, 'watchlist_add_movie_1');
    const screen = only(chat);
    assert.equal(screen.kind, 'text');
    assert.match(screen.text, /добавлен в список ожидания/);
    assert.equal(db.watchlist.length, 1);
});

test('a new search removes the previous one, so there is still one message', async () => {
    const bot = fakeBot();
    const chat = fakeChat();
    const { setState } = require('../../src/bot/state');
    for (const q of ['курьер', 'курьер 2']) {
        const ctx = chat.ctxFor(null, { message: { text: q } });
        setState(ctx, { state: 'waiting_for_search' });
        await bot.onText()(ctx, async () => {});
    }
    assert.match(only(chat).text, /«курьер 2»/);
});

test('a button on a search this user no longer has (expired, or before a restart) leaves it alone', async () => {
    const bot = fakeBot();
    const chat = fakeChat();
    const { clearState } = require('../../src/bot/state');
    const card = await chat.ctxFor(null).replyWithPhoto('x', {
        caption: 'card',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ К результатам', callback_data: 'back_to_results' }]] }
    });
    clearState(chat.ctxFor(null));
    await press(bot, chat, card.message_id, 'back_to_results');
    assert.equal(only(chat).text, 'card', 'the message is untouched');
    assert.match(chat.alerts.at(-1), /поиск устарел/);
});

test('the search lives with its message: another participant can page it (who may is access.js)', async () => {
    const bot = fakeBot();
    const chat = fakeChat();
    const { setState } = require('../../src/bot/state');
    const userCtx = chat.ctxFor(null, { message: { text: 'курьер' } });
    setState(userCtx, { state: 'waiting_for_search' });
    await bot.onText()(userCtx, async () => {});

    await press(bot, chat, only(chat).id, 'page_1', 888);
    assert.match(
        only(chat)
            .buttons.map((b) => b.text)
            .join(' '),
        /2 \/ 2/
    );
    await press(bot, chat, only(chat).id, 'page_0', 888);
    await press(bot, chat, only(chat).id, 'card_tv_3', 888);
    assert.match(only(chat).text, /Как уведомлять/);
    // The card someone else opened is still the starter's, should the chat go back to "owner"
    const { ownerOf } = require('../../src/bot/access');
    assert.equal(ownerOf(555, only(chat).id), 777);
    // ...and the one who started it can still go back to the list
    await press(bot, chat, only(chat).id, 'back_to_results');
    assert.match(only(chat).text, /«курьер»/);
});

test('a poster opened before is sent by its Telegram file id, not downloaded again', async () => {
    const bot = fakeBot();
    const chat = fakeChat();
    const { setState } = require('../../src/bot/state');
    const userCtx = chat.ctxFor(null, { message: { text: 'курьер' } });
    setState(userCtx, { state: 'waiting_for_search' });
    await bot.onText()(userCtx, async () => {});

    await press(bot, chat, only(chat).id, 'card_movie_2');
    await press(bot, chat, only(chat).id, 'back_to_results');
    await press(bot, chat, only(chat).id, 'card_movie_2');
    assert.equal(chat.photosSent[0], 'https://image.tmdb.org/t/p/w500/b.jpg');
    assert.match(chat.photosSent[1], /^file-\d+$/);
    assert.equal(only(chat).kind, 'photo');
});

test('a double tap on a result opens one card, not two', async () => {
    const bot = fakeBot();
    const chat = fakeChat();
    const { setState } = require('../../src/bot/state');
    const userCtx = chat.ctxFor(null, { message: { text: 'курьер' } });
    setState(userCtx, { state: 'waiting_for_search' });
    await bot.onText()(userCtx, async () => {});

    const list = only(chat).id;
    await Promise.all([press(bot, chat, list, 'card_tv_3'), press(bot, chat, list, 'card_tv_3')]);
    assert.equal(only(chat).kind, 'text');
    assert.match(only(chat).text, /Как уведомлять/);
});

test('a double tap on "subscribe" subscribes once', async () => {
    const bot = fakeBot();
    const chat = fakeChat();
    const { setState } = require('../../src/bot/state');
    const userCtx = chat.ctxFor(null, { message: { text: 'курьер' } });
    setState(userCtx, { state: 'waiting_for_search' });
    await bot.onText()(userCtx, async () => {});
    await press(bot, chat, only(chat).id, 'card_tv_3');

    const card = only(chat).id;
    await Promise.all([press(bot, chat, card, 'sub_set_tv_3_episode'), press(bot, chat, card, 'sub_set_tv_3_episode')]);
    assert.equal(db.subs.length, 1);
    assert.match(only(chat).text, /Вы успешно подписались/);
});

test("the list prefetches every film's Kinopoisk ID, out or not: its card needs it for the Russian dates", async () => {
    const bot = fakeBot();
    const chat = fakeChat();
    const { setState } = require('../../src/bot/state');
    const userCtx = chat.ctxFor(null, { message: { text: 'курьер' } });
    setState(userCtx, { state: 'waiting_for_search' });
    kinopoiskAsked.length = 0;
    await bot.onText()(userCtx, async () => {});
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    assert.ok(kinopoiskAsked.includes('movie_1'), 'the film not out yet too');
    assert.ok(!kinopoiskAsked.includes('tv_3'), 'not for a series');
});
