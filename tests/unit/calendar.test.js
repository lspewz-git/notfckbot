/**
 * The 📅 week and month views (src/calendar.js, src/bot/calendar.js) and the digests that send
 * them (src/cron/digests.js). TMDB and the database are stubbed. Run: npm run test:unit
 */
const { test, describe, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const tmdb = require('../../src/api/tmdb');
const { Subscription, Watchlist, Chat, SendFailure } = require('../../src/db');

// --- TMDB: one series, seasons 1 and 2; season 2 airs weekly across October 2026 ---
const SEASONS = {
    '1:1': [
        ['2025-03-03', 1, 'Пилот'],
        ['2025-03-10', 2, '']
    ],
    '1:2': [
        ['2026-10-05', 1, 'Начало'],
        ['2026-10-12', 2, ''],
        ['2026-10-14', 3, ''],
        ['2026-10-19', 4, ''],
        ['2026-11-02', 5, 'Финал']
    ]
};
let seasonAsks = [];
let tmdbDown = false;
mock.method(tmdb, 'getSeasonDetailsCached', async (id, season) => {
    seasonAsks.push(`${id}:${season}`);
    if (tmdbDown) throw new Error('TMDB down');
    return {
        episodes: (SEASONS[`${id}:${season}`] || []).map(([air_date, episode_number, name]) => ({
            air_date,
            episode_number,
            name
        }))
    };
});
mock.method(tmdb, 'getDetailsCached', async () => ({
    seasons: [
        { season_number: 0, episode_count: 3, air_date: '2024-01-01' },
        { season_number: 1, episode_count: 2, air_date: '2025-03-03' },
        { season_number: 2, episode_count: 5, air_date: '2026-10-05' }
    ]
}));

const calendar = require('../../src/calendar');
const { calendarView, calendarKeyboard, register } = require('../../src/bot/calendar');
const { dueDigests, sentMarkOnEnable, sendDigests } = require('../../src/cron/digests');

const SERIES = {
    tmdb_id: 'tv_1',
    title: 'Пацаны',
    last_season: 2,
    next_episode_season: 2,
    release_seasons: '2025:1;2026:2'
};
const FILMS = [
    { tmdb_id: 'movie_7', title: 'Дюна', premiere_digital: '2026-10-16' },
    { tmdb_id: 'movie_7', title: 'Дюна', premiere_digital: '2026-10-16' }, // the same film twice
    { tmdb_id: 'movie_8', title: 'Позже', premiere_digital: '2026-12-01' }
];

beforeEach(() => {
    seasonAsks = [];
    tmdbDown = false;
    mock.method(Subscription, 'findAll', async () => [{ Series: SERIES }]);
    mock.method(Watchlist, 'findAll', async () => FILMS);
});

// Wednesday 14 October 2026, 12:00 in Moscow
const NOW = new Date('2026-10-14T09:00:00Z');
const chat = (fields = {}) => ({ id: 10, timezone: 'Europe/Moscow', ...fields });

describe('dates', () => {
    test('a week runs Monday to Sunday; offsets go back and ahead, across months and years', () => {
        assert.deepEqual(pick(calendar.period('w', 0, 'Europe/Moscow', NOW)), ['2026-10-12', '2026-10-18']);
        assert.deepEqual(pick(calendar.period('w', -1, 'Europe/Moscow', NOW)), ['2026-10-05', '2026-10-11']);
        assert.deepEqual(pick(calendar.period('w', 11, 'Europe/Moscow', NOW)), ['2026-12-28', '2027-01-03']);
    });

    test('a month is the calendar month; February and year ends come out right', () => {
        assert.deepEqual(pick(calendar.period('m', 0, 'Europe/Moscow', NOW)), ['2026-10-01', '2026-10-31']);
        assert.deepEqual(pick(calendar.period('m', 4, 'Europe/Moscow', NOW)), ['2027-02-01', '2027-02-28']);
        assert.deepEqual(pick(calendar.period('m', -10, 'Europe/Moscow', NOW)), ['2025-12-01', '2025-12-31']);
    });

    test("the panel's one list runs from last month to the end of the month after next, across years", () => {
        assert.deepEqual(pick(calendar.listPeriod('Europe/Moscow', NOW)), ['2026-09-01', '2026-12-31']);
        const december = new Date('2026-12-10T12:00:00Z');
        assert.deepEqual(pick(calendar.listPeriod('Europe/Moscow', december)), ['2026-11-01', '2027-02-28']);
    });

    test("today is the chat's: late on Sunday in Moscow is Monday in Vladivostok", () => {
        const sunday = new Date('2026-10-18T18:00:00Z');
        assert.equal(calendar.todayIn('Europe/Moscow', sunday), '2026-10-18');
        assert.equal(calendar.todayIn('Asia/Vladivostok', sunday), '2026-10-19');
        assert.equal(calendar.period('w', 0, 'Asia/Vladivostok', sunday).from, '2026-10-19');
    });

    test('ranges and counts in Russian', () => {
        assert.equal(calendar.rangeText('2026-10-12', '2026-10-18'), '12–18 октября');
        assert.equal(calendar.rangeText('2026-10-26', '2026-11-01'), '26 октября – 1 ноября');
        assert.equal(calendar.rangeText('2026-12-28', '2027-01-03'), '28 декабря 2026 – 3 января 2027');
        assert.equal(calendar.plural(1, 'серия', 'серии', 'серий'), '1 серия');
        assert.equal(calendar.plural(3, 'серия', 'серии', 'серий'), '3 серии');
        assert.equal(calendar.plural(12, 'серия', 'серии', 'серий'), '12 серий');
        assert.equal(calendar.plural(22, 'серия', 'серии', 'серий'), '22 серии');
    });
});

const pick = (p) => [p.from, p.to];

describe('the week', () => {
    test('days with something out, past ones ticked, today marked; films once', async () => {
        const view = await calendarView(chat(), 'w', 0, { now: NOW });
        const text = view.text;
        assert.match(text, /^📅 <b>Неделя 12–18 октября<\/b>/);
        assert.match(text, /<b>Пн, 12 окт<\/b> ✓\n📺 Пацаны — S2E2/);
        assert.match(text, /<b>Ср, 14 окт<\/b> · сегодня\n📺 Пацаны — S2E3/);
        assert.match(text, /<b>Пт, 16 окт<\/b>\n🎬 Дюна — выход/);
        assert.equal(text.match(/Дюна/g).length, 1);
        assert.equal(view.empty, false);
    });

    test('premieres and finales are named', async () => {
        const first = await calendarView(chat(), 'w', -1, { now: NOW });
        assert.match(first.text, /S2E1, премьера сезона/);
        const last = await calendarView(chat(), 'w', 3, { now: NOW });
        assert.match(last.text, /S2E5, финал сезона/);
    });

    test('a week far back asks TMDB for the seasons of that year, not the latest', async () => {
        const view = await calendarView(chat(), 'w', -84, { now: NOW });
        assert.match(view.text, /Неделя 3–9 марта/);
        assert.match(view.text, /S1E1, премьера сезона/);
        assert.ok(seasonAsks.includes('1:1'));
    });

    test('nothing that week: says so', async () => {
        const view = await calendarView(chat(), 'w', 20, { now: NOW });
        assert.match(view.text, /ничего не выходит/);
        assert.equal(view.empty, true);
    });

    test('TMDB not answering: the films still, and a note about the series left out', async () => {
        tmdbDown = true;
        const view = await calendarView(chat(), 'w', 0, { now: NOW });
        assert.match(view.text, /🎬 Дюна/);
        assert.match(view.text, /TMDB не ответил по 1 сериалу/);
    });
});

describe('the month', () => {
    test('the current one: the days gone in one line, then the rest by week', async () => {
        const view = await calendarView(chat(), 'm', 0, { now: NOW });
        assert.match(view.text, /^📅 <b>Октябрь 2026<\/b>/);
        assert.match(view.text, /<i>1–13 окт: вышло 2 серии ✓<\/i>/);
        // This week from today: the days before it are in the line above, not twice
        assert.match(view.text, /<b>14–18 окт<\/b>\n📺 Пацаны — S2E3\n🎬 Дюна — выход/);
        assert.match(view.text, /<b>19–25 окт<\/b>\n📺 Пацаны — S2E4/);
    });

    test('a past month in full, its weeks ticked', async () => {
        const view = await calendarView(chat(), 'm', -19, { now: NOW });
        assert.match(view.text, /Март 2025/);
        assert.match(view.text, /<b>3–9 мар<\/b> ✓\n📺 Пацаны — S1E1/);
    });
});

describe('the buttons', () => {
    const texts = (p, opts) =>
        calendarKeyboard(p, opts).reply_markup.inline_keyboard.map((r) => r.map((b) => `${b.text}|${b.callback_data}`));

    test('week: only the previous and the next; the tabs; the way back to the subscriptions', () => {
        assert.deepEqual(texts({ kind: 'w', offset: 0, from: '2026-10-12' }), [
            ['◀️ Прошлая|cal_w_-1', 'Следующая ▶️|cal_w_1'],
            ['✅ Неделя|cal_w_0', 'Месяц|cal_m_0', 'Год|hist_0'],
            ['⬅️ К подпискам|subs_o']
        ]);
    });

    test('from a neighbouring week or month only the way back to the current one', () => {
        assert.deepEqual(texts({ kind: 'w', offset: 1, from: '2026-10-19' })[0], ['◀️ Текущая|cal_w_0']);
        assert.deepEqual(texts({ kind: 'w', offset: -1, from: '2026-10-05' })[0], ['Текущая ▶️|cal_w_0']);
        assert.deepEqual(texts({ kind: 'm', offset: -1, from: '2026-09-01' })[0], ['Октябрь ▶️|cal_m_0']);
    });

    test('month: the neighbouring months by name, month ticked; no way back when asked', () => {
        const rows = texts({ kind: 'm', offset: 0, from: '2026-12-01' }, { back: false });
        assert.deepEqual(rows[0], ['◀️ Ноябрь|cal_m_-1', 'Январь ▶️|cal_m_1']);
        assert.deepEqual(rows[1], ['Неделя|cal_w_0', '✅ Месяц|cal_m_0', 'Год|hist_0']);
        assert.equal(rows.length, 2);
    });

    test('a digest: the way back in a private chat and where anyone may press; not where only the owner may', async () => {
        const back = async (fields) =>
            (await calendarView(chat(fields), 'w', 0, { digest: true, now: NOW })).keyboard.reply_markup.inline_keyboard
                .flat()
                .some((b) => b.callback_data === 'subs_o');
        assert.equal(await back({ id: 10 }), true);
        assert.equal(await back({ id: -100, buttons_mode: 'all' }), true);
        assert.equal(await back({ id: -100, buttons_mode: 'owner' }), false);
    });

    test("a button further out than the limit (an old message's) opens the current period", async () => {
        let handler;
        register({ command() {}, action: (trigger, fn) => (handler = fn) });
        const ctx = {
            match: ['cal_m_2', 'm', '2'],
            state: { chatData: chat() },
            callbackQuery: { message: { reply_markup: { inline_keyboard: [[{ callback_data: 'subs_o' }]] } } },
            answered: 0,
            edited: [],
            answerCbQuery() {
                this.answered += 1;
            },
            async editMessageText(text) {
                this.edited.push(text);
            }
        };
        await handler(ctx);
        const current = calendar.period('m', 0, 'Europe/Moscow');
        const title = `${calendar.MONTHS_TITLE[Number(current.from.slice(5, 7)) - 1]} ${current.from.slice(0, 4)}`;
        assert.equal(ctx.answered, 1);
        assert.match(ctx.edited[0], new RegExp(`^📅 <b>${title}</b>`));
    });
});

describe('digests', () => {
    // Monday 19 October 2026, 10:30 in Moscow; and 09:30
    const MONDAY = new Date('2026-10-19T07:30:00Z');
    const EARLY = new Date('2026-10-19T06:30:00Z');

    test('due from 10:00 of its day, once per period; a missed one later the same week', () => {
        const c = chat({
            digest_week: true,
            digest_week_sent: '2026-10-12',
            digest_month: true,
            digest_month_sent: '2026-10'
        });
        assert.deepEqual(dueDigests(c, EARLY), []);
        assert.deepEqual(dueDigests(c, MONDAY), ['w']);
        assert.deepEqual(dueDigests({ ...c, digest_week_sent: '2026-10-19' }, MONDAY), []);
        assert.deepEqual(dueDigests({ ...c, digest_week_sent: '2026-10-12' }, new Date('2026-10-21T12:00:00Z')), ['w']);
        assert.deepEqual(dueDigests({ ...c, digest_month_sent: '2026-09' }, MONDAY), ['w', 'm']);
        assert.deepEqual(dueDigests(chat(), MONDAY), [], 'off');
    });

    test('turned on before 10:00 of its day: comes today; any later: with the next period', () => {
        assert.equal(sentMarkOnEnable('w', chat(), EARLY), null);
        assert.equal(sentMarkOnEnable('w', chat(), MONDAY), '2026-10-19');
        assert.equal(sentMarkOnEnable('w', chat(), NOW), '2026-10-12');
        assert.equal(sentMarkOnEnable('m', chat(), NOW), '2026-10');
        assert.equal(sentMarkOnEnable('m', chat(), new Date('2026-11-01T05:00:00Z')), null);
    });

    test('sent and marked; not in quiet hours; an empty one marked unsent; a failed one kept', async () => {
        const updates = [];
        const row = (fields) => ({
            ...chat(fields),
            async update(changes) {
                updates.push({ id: this.id, ...changes });
                Object.assign(this, changes);
            }
        });
        const chats = [
            row({ id: 1, digest_week: true, digest_week_sent: '2026-10-12' }),
            row({ id: 2, digest_week: true, quiet_start: 9, quiet_end: 11 }),
            row({ id: 3, digest_month: true, digest_month_sent: '2026-09' })
        ];
        mock.method(Chat, 'findAll', async () => chats);
        // Chat 3's month has nothing: its subscriptions are empty
        mock.method(Subscription, 'findAll', async ({ where }) => (where.chatId === 3 ? [] : [{ Series: SERIES }]));
        mock.method(Watchlist, 'findAll', async ({ where }) => (where.chatId === 3 ? [] : FILMS));
        const sent = [];
        const bot = { telegram: { sendMessage: async (id, text) => sent.push({ id, text }) } };

        await sendDigests(bot, MONDAY);
        assert.deepEqual(
            sent.map((s) => s.id),
            [1]
        );
        assert.match(sent[0].text, /^📬 <b>Сводка недели<\/b>\n\n📅 <b>Неделя 19–25 октября/);
        assert.deepEqual(updates, [
            { id: 1, digest_week_sent: '2026-10-19' },
            { id: 3, digest_month_sent: '2026-10' }
        ]);
    });

    test('a digest the chat no longer takes is listed for the day as such', async (t) => {
        const c = { ...chat({ id: 1, digest_week: true, digest_week_sent: '2026-10-12' }), async update() {} };
        t.mock.method(Chat, 'findAll', async () => [c]);
        t.mock.method(Subscription, 'findAll', async () => [{ Series: SERIES }]);
        t.mock.method(Watchlist, 'findAll', async () => FILMS);
        const kept = [];
        t.mock.method(SendFailure, 'create', async (fields) => kept.push(fields));
        t.mock.method(SendFailure, 'destroy', async () => 0);
        const bot = {
            telegram: {
                sendMessage: async () => {
                    throw Object.assign(new Error('403: Forbidden: bot was kicked'), { response: { error_code: 403 } });
                }
            }
        };
        await sendDigests(bot, MONDAY);
        assert.deepEqual(
            kept.map((k) => [k.chatId, k.about, k.status]),
            [[1, 'Weekly digest', 'gone']]
        );
    });
});
