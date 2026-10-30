/**
 * A chat's change log: who changed its list or its settings, from where (the bot, the panel, the
 * account pages) and when. These are its ChatEvent rows of the kinds below; settings changes are
 * kept only for the log, CHANGES_KEEP_DAYS (Settings), and the log shows no older rows of any kind.
 */
const { Op } = require('sequelize');
const { ChatEvent } = require('./db');
const events = require('./chat-events');
const { zoneOf, hasQuietHours, pad } = require('./quiet');
const { z } = require('./admin/validate');

const KINDS = ['subscribed', 'mode', 'unsubscribed', 'film_added', 'film_removed', 'settings', 'bot_on', 'bot_off'];
const KEEP_CHOICES = [7, 30, 90, 365];
const KEEP_DEFAULT = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// The panel's page sizes (admin/js/pager.js)
const PAGE_SIZES = [10, 25, 50, 100];

/** A page of the log as the panel and the account pages ask for it: ?page=2&size=25&q=… */
const changesQuery = z.object({
    page: z.coerce.number({ error: 'Bad page' }).int({ error: 'Bad page' }).min(1, { error: 'Bad page' }).default(1),
    size: z.coerce
        .number({ error: 'Bad page size' })
        .refine((n) => PAGE_SIZES.includes(n), { error: 'Bad page size' })
        .default(10),
    q: z.string({ error: 'Bad search' }).max(100, { error: 'Search: 100 characters at most' }).default('')
});

/** How many days the log keeps, from .env; a value not offered is the default. */
function keepDays(env = process.env) {
    const days = Number(env.CHANGES_KEEP_DAYS);
    return KEEP_CHOICES.includes(days) ? days : KEEP_DEFAULT;
}

const since = (now = new Date()) => new Date(now.getTime() - keepDays() * DAY_MS);

// A setting's name and its value in the words of the bot's ⚙️ Settings screen (src/bot/settings.js)
const SHOWN = {
    quiet: ['Тихие часы', (s) => (hasQuietHours(s) ? `${pad(s.quiet_start)}–${pad(s.quiet_end)}` : 'выключены')],
    timezone: ['Часовой пояс', (s) => `${zoneOf(s.timezone).city} (UTC+${zoneOf(s.timezone).offset})`],
    digest_week: ['Сводка недели', (s) => (s.digest_week ? 'по понедельникам в 10:00' : 'выключена')],
    digest_month: ['Сводка месяца', (s) => (s.digest_month ? '1-го числа в 10:00' : 'выключена')],
    buttons_mode: [
        'Кнопки бота нажимают',
        (s) => (s.buttons_mode === 'all' ? 'все участники' : 'только тот, кто их вызвал')
    ],
    menu_enabled: ['Нижнее меню', (s) => (s.menu_enabled !== false ? 'включено' : 'выключено')]
};

/**
 * "Часовой пояс: Москва (UTC+3) → Омск (UTC+6)", one per setting that really changed.
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 * @returns {{ setting: string, line: string }[]}
 */
function settingLines(before, after) {
    return Object.entries(SHOWN)
        .map(([setting, [name, show]]) => ({ setting, from: show(before), to: show(after), name }))
        .filter((s) => s.from !== s.to)
        .map((s) => ({ setting: s.setting, line: `${s.name}: ${s.from} → ${s.to}` }));
}

/**
 * Notes the settings changes for the log.
 * @param {{ userId?: number | string | null, userName?: string | null, source?: string }} who
 * @returns {string[]} the lines, for a message to the chat
 */
function recordSettings(chatId, before, after, who = {}) {
    const lines = settingLines(before, after);
    for (const { setting, line } of lines) {
        events.record(chatId, { kind: 'settings', detail: setting, title: line, ...who });
    }
    return lines.map((l) => l.line);
}

const rowOf = (row) => ({
    at: new Date(row.createdAt).toISOString(),
    kind: row.kind,
    detail: row.detail ?? null,
    title: row.title ?? null,
    userName: row.userName ?? null,
    source: row.source ?? null
});

/**
 * One page of a chat's log, the newest first; `q` looks in the title and in who did it. The
 * changes not yet written (src/chat-events.js writes every ten minutes) are on it too.
 * @returns {Promise<{ total: number, rows: ReturnType<typeof rowOf>[], keepDays: number }>}
 */
async function changesOf(chatId, { page = 1, size = 10, q = '' } = {}, now = new Date()) {
    await events.settled();
    const from = since(now);
    const needle = String(q).trim().toLowerCase();
    const matches = (row) =>
        !needle || [row.title, row.userName].some((v) => v && String(v).toLowerCase().includes(needle));
    const fresh = events
        .unwritten()
        .filter(
            (row) =>
                String(row.chatId) === String(chatId) &&
                KINDS.includes(row.kind) &&
                new Date(row.createdAt) >= from &&
                matches(row)
        )
        .reverse();

    const where = { chatId, kind: KINDS, createdAt: { [Op.gte]: from } };
    if (needle) {
        const like = `%${needle.replace(/[\\%_]/g, '\\$&')}%`;
        where[Op.or] = [{ title: { [Op.like]: like } }, { userName: { [Op.like]: like } }];
    }
    // The unwritten ones are the newest: they come first, then the written ones
    const start = (page - 1) * size;
    const own = fresh.slice(start, start + size);
    const limit = size - own.length;
    const offset = Math.max(0, start - fresh.length);
    const [count, rows] = await Promise.all([
        ChatEvent.count({ where }),
        limit > 0
            ? ChatEvent.findAll({
                  where,
                  order: [
                      ['createdAt', 'DESC'],
                      ['id', 'DESC']
                  ],
                  offset,
                  limit
              })
            : []
    ]);
    return { total: fresh.length + count, rows: [...own, ...rows].map(rowOf), keepDays: keepDays() };
}

/** Drops the settings changes past the time kept; the rest stays for the statistics and the recap. */
const sweepChanges = (now = new Date()) =>
    ChatEvent.destroy({ where: { kind: 'settings', createdAt: { [Op.lt]: since(now) } } });

module.exports = {
    KINDS,
    KEEP_CHOICES,
    keepDays,
    changesQuery,
    settingLines,
    recordSettings,
    changesOf,
    sweepChanges
};
