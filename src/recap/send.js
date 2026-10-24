/**
 * Sending the year's recap, by hand from the panel only: one chat (the preview's button) or every
 * chat with something to show (Users / Chats). Each becomes a RecapSend row, queued; the queue goes
 * out here one chat at a time, an album of the six cards, in the background (the panel can be
 * closed) and again every ten minutes (src/cron/index.js) for chats that were in their quiet
 * hours. A chat gets a year once: its row stays. The Settings switch (RECAP_SCHEDULE) is for a
 * sending by date that isn't built yet; it has no say over these buttons.
 */
const { Op } = require('sequelize');
const { Chat, Subscription, Watchlist, RecapSend } = require('../db');
const { deliverAlbum } = require('../delivery');
const { isQuietNow } = require('../quiet');
const { plural } = require('../calendar');
const { recapImages } = require('./render');
const { log } = require('../log');

// A temporary failure (Telegram or the network down) is tried again on the next round, this often
const MAX_ATTEMPTS = 3;
// Between two chats: Telegram's limit is about 30 messages a second overall, an album counts as six
const PAUSE_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The years that can be sent: this one and the one before; nothing ahead. */
const sendableYear = (year, now = new Date()) => year === now.getFullYear() || year === now.getFullYear() - 1;

/** The text under the first card. */
function caption(year, stats) {
    const hours = Math.round((stats.episodes.minutes + stats.films.minutes) / 60);
    const parts = [
        stats.episodes.count && plural(stats.episodes.count, 'серия', 'серии', 'серий'),
        stats.films.released.length && plural(stats.films.released.length, 'фильм', 'фильма', 'фильмов'),
        hours && `${plural(hours, 'час', 'часа', 'часов')} премьер`
    ].filter(Boolean);
    const summary = parts.length
        ? `${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} и ${parts[parts.length - 1]}` : parts[0]}. `
        : '';
    return `🎬 <b>Ваш ${year} в сериалах и фильмах</b>\n${summary}Листайте карточки →\n<i>Можно переслать друзьям.</i>`;
}

/**
 * Who the year would go to: chats with a subscription or a film (the rest have nothing to show),
 * not blocked in the panel, not sent or queued for that year already.
 * @returns {Promise<{ eligible: string[], sent: number, queued: number, failed: number, nothing: number, blocked: number }>}
 */
async function audience(year, now = new Date()) {
    const [chats, subs, films, rows] = await Promise.all([
        Chat.findAll({ attributes: ['id', 'blockedUntil'] }),
        Subscription.findAll({ attributes: ['chatId'], group: ['chatId'], raw: true }),
        Watchlist.findAll({ attributes: ['chatId'], group: ['chatId'], raw: true }),
        RecapSend.findAll({ where: { year }, attributes: ['chatId', 'status'], raw: true })
    ]);
    const following = new Set([...subs, ...films].map((r) => String(r.chatId)));
    const status = new Map(rows.map((r) => [String(r.chatId), r.status]));
    const result = { eligible: [], sent: 0, queued: 0, failed: 0, nothing: 0, blocked: 0 };
    for (const chat of chats) {
        const id = String(chat.id);
        const row = status.get(id);
        if (row === 'sent') result.sent += 1;
        else if (row === 'queued' || row === 'sending') result.queued += 1;
        else if (row === 'failed') result.failed += 1;
        else if (!following.has(id)) result.nothing += 1;
        else if (chat.blockedUntil && new Date(chat.blockedUntil) > now) result.blocked += 1;
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

/** Takes what is still queued off the queue (all years); sent rows stay. */
const stop = () => RecapSend.destroy({ where: { status: 'queued' } });

let running = false;

/**
 * Sends what is queued, oldest first, one chat at a time; a chat in its quiet hours waits for the
 * next round. One run at a time.
 */
async function processQueue(bot, { now = () => new Date(), pause = PAUSE_MS, wait, timeout } = {}) {
    if (running) return;
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
                // Taken only if still queued: Stop may have removed it meanwhile
                const [taken] = await RecapSend.update(
                    { status: 'sending' },
                    { where: { id: row.id, status: 'queued' } }
                );
                if (!taken) continue;
                await sendOne(bot, row, chat, { wait, timeout });
                if (row.status === 'sent') sent += 1;
                if (pause) await sleep(pause);
            }
        }
        if (sent) log.info(`[Recap] Sent ${sent} year recap(s)`);
    } catch (err) {
        log.error(`[Recap] Sending failed: ${err.message}`);
    } finally {
        running = false;
    }
}

/** One chat's album; the row says how it went. */
async function sendOne(bot, row, chat, { wait, timeout }) {
    try {
        const recap = await recapImages(row.chatId, row.year);
        if (!recap) {
            await row.update({ status: 'failed', error: 'Chat not found' });
            return;
        }
        const result = await deliverAlbum(bot, row.chatId, recap.images, caption(row.year, recap.stats), {
            ...(wait ? { wait } : {}),
            ...(timeout ? { timeout } : {})
        });
        if (result.status === 'sent') {
            await row.update({ status: 'sent', sentAt: new Date(), error: null });
            log.info(`[Recap] ${row.year} sent to chat ${row.chatId} (${chat.username || 'no name'})`);
            return;
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

module.exports = { sendableYear, caption, audience, progress, enqueue, stop, processQueue, MAX_ATTEMPTS };
