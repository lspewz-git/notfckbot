/**
 * Sending the year's recap: by hand from the panel, one chat (the preview's button) or every chat
 * with something to show (Users / Chats), or by date (schedule.js). Each becomes a RecapSend row,
 * queued; the queue goes out here one chat at a time, an album of the six cards, in the background
 * (the panel can be closed) and again every ten minutes (src/cron/index.js) for chats that were in
 * their quiet hours. A chat gets a year once: its row stays. The schedule's switch
 * (RECAP_SCHEDULE) has no say over the buttons.
 */
const { Op } = require('sequelize');
const { Chat, Subscription, Watchlist, RecapSend } = require('../db');
const { deliverAlbum } = require('../delivery');
const { isLeft } = require('../bot-status');
const { isQuietNow } = require('../quiet');
const { plural } = require('../calendar');
const { escapeHtml } = require('../constants');
const { recapImages } = require('./render');
const { leader } = require('../chat-stats');
const { log } = require('../log');

// A temporary failure (Telegram or the network down) is tried again on the next round, this often
const MAX_ATTEMPTS = 3;
// Between two chats: Telegram's limit is about 30 messages a second overall, an album counts as six
const PAUSE_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The years that can be sent: this one and the one before; nothing ahead. */
const sendableYear = (year, now = new Date()) => year === now.getFullYear() || year === now.getFullYear() - 1;

const MONTHS = [
    'Январь',
    'Февраль',
    'Март',
    'Апрель',
    'Май',
    'Июнь',
    'Июль',
    'Август',
    'Сентябрь',
    'Октябрь',
    'Ноябрь',
    'Декабрь'
];

/**
 * The playful last lines, each from the chat's own figures; only those it has the figures for.
 * The bot knows what came out, not what was watched, so none of them says anyone watched it.
 */
function jokes(stats, hours) {
    const lines = [];
    const days = hours / 24;
    if (days >= 1) {
        const text = Number.isInteger(days)
            ? plural(days, 'сутки', 'суток', 'суток')
            : `${days.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} суток`;
        lines.push(`Если смотреть всё подряд — это ${text} без перерыва. Запасайтесь пледом.`);
    }
    const buckets = Math.round(hours / 2);
    if (buckets >= 2) {
        lines.push(
            `Чтобы посмотреть всё, понадобится примерно ${plural(buckets, 'ведро', 'ведра', 'вёдер')} попкорна 🍿`
        );
    }
    const busiest = stats.episodes.busiestMonth;
    if (busiest && busiest.count >= 5) {
        const month = MONTHS[Number(busiest.month.slice(5, 7)) - 1];
        lines.push(
            `${month} выдался жарким: ${plural(busiest.count, 'новая серия', 'новые серии', 'новых серий')}. Надеемся, вы всё успели.`
        );
    }
    const wait = stats.films.longestWait;
    if (wait && wait.waited >= 30) {
        lines.push(
            `«${escapeHtml(wait.title)}» вы ждали ${plural(wait.waited, 'день', 'дня', 'дней')}. Терпение — ваша суперсила.`
        );
    }
    return lines;
}

/**
 * In a group, the member who added clearly the most series and films. No "добавил(а)": Telegram
 * doesn't say whether a member is he or she.
 */
function leaderLine(stats) {
    const top = leader(stats.members);
    if (!top) return '';
    const what = [
        top.series && plural(top.series, 'сериал', 'сериала', 'сериалов'),
        top.films && plural(top.films, 'фильм', 'фильма', 'фильмов')
    ].filter(Boolean);
    return `\n🏆 Главный по новинкам — ${escapeHtml(top.name)}: ${what.join(' и ')}.`;
}

/**
 * The text under the first card: the year, its figures, in a group who added the most, and one
 * playful line picked at random.
 */
function caption(year, stats, random = Math.random, group = false) {
    const hours = Math.round((stats.episodes.minutes + stats.films.minutes) / 60);
    const parts = [
        stats.episodes.count && plural(stats.episodes.count, 'серия', 'серии', 'серий'),
        stats.films.released.length && plural(stats.films.released.length, 'фильм', 'фильма', 'фильмов'),
        hours && `${plural(hours, 'час', 'часа', 'часов')} премьер`
    ].filter(Boolean);
    const summary = parts.length
        ? `\n${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} и ${parts[parts.length - 1]}` : parts[0]}.`
        : '';
    const options = jokes(stats, hours);
    const joke = options.length ? `\n\n${options[Math.floor(random() * options.length)]}` : '';
    return `🎬 <b>Ваш ${year} в сериалах и фильмах</b>${summary}${group ? leaderLine(stats) : ''}${joke}`;
}

/**
 * Who the year would go to: chats with a subscription or a film (the rest have nothing to show),
 * not blocked in the panel, still reachable (src/bot-status.js), not sent or queued for that year already.
 * @returns {Promise<{ eligible: string[], sent: number, queued: number, failed: number, nothing: number, blocked: number, left: number }>}
 */
async function audience(year, now = new Date()) {
    const [chats, subs, films, rows] = await Promise.all([
        Chat.findAll({ attributes: ['id', 'blockedUntil', 'bot_status'] }),
        Subscription.findAll({ attributes: ['chatId'], group: ['chatId'], raw: true }),
        Watchlist.findAll({ attributes: ['chatId'], group: ['chatId'], raw: true }),
        RecapSend.findAll({ where: { year }, attributes: ['chatId', 'status'], raw: true })
    ]);
    const following = new Set([...subs, ...films].map((r) => String(r.chatId)));
    const status = new Map(rows.map((r) => [String(r.chatId), r.status]));
    const result = { eligible: [], sent: 0, queued: 0, failed: 0, nothing: 0, blocked: 0, left: 0 };
    for (const chat of chats) {
        const id = String(chat.id);
        const row = status.get(id);
        if (row === 'sent') result.sent += 1;
        else if (row === 'queued' || row === 'sending') result.queued += 1;
        else if (row === 'failed') result.failed += 1;
        else if (!following.has(id)) result.nothing += 1;
        else if (chat.blockedUntil && new Date(chat.blockedUntil) > now) result.blocked += 1;
        else if (isLeft(chat)) result.left += 1;
        else result.eligible.push(id);
    }
    return result;
}

/** How the year's sending goes: rows by status, and those waiting for a chat's quiet hours to end. */
async function progress(year, now = new Date()) {
    const rows = await RecapSend.findAll({ where: { year }, raw: true });
    const counts = { queued: 0, sending: 0, sent: 0, failed: 0, quiet: 0 };
    for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
    const waiting = rows.filter((r) => r.status === 'queued').map((r) => r.chatId);
    if (waiting.length) {
        const chats = await Chat.findAll({ where: { id: waiting } });
        counts.quiet = chats.filter((chat) => isQuietNow(chat, now)).length;
    }
    return { ...counts, total: rows.length, running };
}

/** Queues the year for these chats; a chat already queued or sent for it is left as it is. */
async function enqueue(chatIds, year) {
    if (!chatIds.length) return 0;
    const before = await RecapSend.count({ where: { year } });
    await RecapSend.bulkCreate(
        chatIds.map((chatId) => ({ chatId, year })),
        { ignoreDuplicates: true }
    );
    return (await RecapSend.count({ where: { year } })) - before;
}

/** Takes these chats' year off the queue if they haven't gone yet (Stop while the schedule queued them). */
const unqueue = (chatIds, year) =>
    chatIds.length ? RecapSend.destroy({ where: { chatId: chatIds, year, status: 'queued' } }) : 0;

/** Takes what is still queued off the queue (all years); sent rows stay. */
const stop = () => RecapSend.destroy({ where: { status: 'queued' } });

let running = false;
// Telegram asked to wait (a flood ban over a minute): no sending before this moment
let floodUntil = 0;

/**
 * Sends what is queued, oldest first, one chat at a time; a chat in its quiet hours waits for the
 * next round. One run at a time.
 */
async function processQueue(bot, { now = () => new Date(), pause = PAUSE_MS, wait, timeout } = {}) {
    if (running || Date.now() < floodUntil) return;
    running = true;
    try {
        // A send cut off by a restart may have reached the chat: marked failed, never sent twice
        await RecapSend.update(
            { status: 'failed', error: 'Interrupted by a restart; may have been sent' },
            { where: { status: 'sending', updatedAt: { [Op.lt]: new Date(now().getTime() - 10 * 60 * 1000) } } }
        );
        let sent = 0;
        // Read again after each pass: a chat queued meanwhile (another button) goes now, not in ten
        // minutes. A row looked at once (quiet hours) waits for the next run
        const seen = new Set();
        for (;;) {
            const queued = (await RecapSend.findAll({ where: { status: 'queued' }, order: [['id', 'ASC']] })).filter(
                (row) => !seen.has(row.id)
            );
            if (!queued.length) break;
            for (const row of queued) {
                seen.add(row.id);
                const chat = await Chat.findByPk(row.chatId);
                if (!chat) {
                    await row.update({ status: 'failed', error: 'Chat not found' });
                    continue;
                }
                if (isQuietNow(chat, now())) continue;
                // Drawn while still queued: a restart while drawing (it can take half a minute)
                // leaves it queued, not "may have been sent"
                const recap = await drawFor(row);
                if (!recap) continue;
                // Taken only if still queued: Stop may have removed it meanwhile. From here on a
                // restart can't tell whether it arrived
                const [taken] = await RecapSend.update(
                    { status: 'sending' },
                    { where: { id: row.id, status: 'queued' } }
                );
                if (!taken) continue;
                const outcome = await sendOne(bot, row, chat, recap, { wait, timeout });
                if (row.status === 'sent') sent += 1;
                // Telegram asks to wait long: the rest waits too, rather than each chat asking again
                if (outcome === 'flood') break;
                if (pause) await sleep(pause);
            }
            if (Date.now() < floodUntil) break;
        }
        if (sent) log.info(`[Recap] Sent ${sent} year recap(s)`);
    } catch (err) {
        log.error(`[Recap] Sending failed: ${err.message}`);
    } finally {
        running = false;
    }
}

/**
 * A queued chat's six cards, or null when there is nothing to send now. A failure here comes
 * before anything reached Telegram (the database, the drawing thread, memory): tried again on a
 * later round, up to MAX_ATTEMPTS, like a send that failed for a moment.
 */
async function drawFor(row) {
    try {
        const recap = await recapImages(row.chatId, row.year);
        if (!recap) await row.update({ status: 'failed', error: 'Chat not found' });
        return recap;
    } catch (err) {
        const attempts = row.attempts + 1;
        const final = attempts >= MAX_ATTEMPTS;
        const error = `Drawing failed: ${err.message}`.slice(0, 255);
        await row.update({ status: final ? 'failed' : 'queued', attempts, error }).catch(() => {});
        log.error(`[Recap] ${row.year} for chat ${row.chatId} not drawn: ${err.message}`);
        return null;
    }
}

/**
 * One chat's album; the row says how it went.
 * @returns {Promise<'flood' | undefined>} flood: Telegram asked to wait long, the row is queued again
 */
async function sendOne(bot, row, chat, recap, { wait, timeout }) {
    try {
        const result = await deliverAlbum(
            bot,
            row.chatId,
            recap.images,
            caption(row.year, recap.stats, Math.random, chat.type !== 'private'),
            {
                ...(wait ? { wait } : {}),
                ...(timeout ? { timeout } : {})
            }
        );
        if (result.status === 'sent') {
            await row.update({ status: 'sent', sentAt: new Date(), error: null });
            log.info(`[Recap] ${row.year} sent to chat ${row.chatId} (${chat.username || 'no name'})`);
            return;
        }
        if (result.retryAfter) {
            // Not an attempt: Telegram didn't take it and said when to come back
            floodUntil = Date.now() + result.retryAfter * 1000;
            await row.update({ status: 'queued', error: `Telegram asked to wait ${result.retryAfter} s` });
            log.error(`[Recap] Telegram asked to wait ${result.retryAfter} s: sending paused`);
            return 'flood';
        }
        const attempts = row.attempts + 1;
        // No answer at all: it may have arrived, so it isn't tried again by itself
        const final = result.status !== 'failed' || result.uncertain || attempts >= MAX_ATTEMPTS;
        const error = result.uncertain
            ? `${result.error}; may have been sent, not tried again`
            : String(result.error || result.status);
        await row.update({ status: final ? 'failed' : 'queued', attempts, error: error.slice(0, 255) });
        log.error(`[Recap] ${row.year} to chat ${row.chatId} not sent (${result.status}): ${result.error}`);
    } catch (err) {
        await row.update({ status: 'failed', error: String(err.message).slice(0, 255) }).catch(() => {});
        log.error(`[Recap] ${row.year} to chat ${row.chatId} failed: ${err.message}`);
    }
}

module.exports = {
    sendableYear,
    caption,
    jokes,
    audience,
    progress,
    enqueue,
    unqueue,
    stop,
    processQueue,
    MAX_ATTEMPTS
};
