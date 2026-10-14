/**
 * The digests a chat may turn on: the week (src/bot/calendar.js) on Mondays and the month on the
 * 1st, from 10:00 in the chat's time zone. Checked every few minutes with the quiet hours
 * (src/cron/index.js): a digest due in a chat's quiet hours waits for them to end; one missed
 * (the bot was down) goes out later the same week or month. Nothing to list, nothing sent.
 */
const { Op } = require('sequelize');
const { Chat } = require('../db');
const { deliver } = require('../delivery');
const { isQuietNow, hourIn } = require('../quiet');
const { todayIn, weekStart } = require('../calendar');
const { calendarView } = require('../bot/calendar');
const stats = require('../stats-log');

const DIGEST_HOUR = 10;
const NO_PREVIEW = { link_preview_options: { is_disabled: true } };
const TITLES = { w: '📬 <b>Сводка недели</b>', m: '📬 <b>Сводка месяца</b>' };

/** The period a digest is for, as stored in digest_*_sent: the week's Monday, or "2026-10". */
const periodKey = (kind, today) => (kind === 'w' ? weekStart(today) : today.slice(0, 7));

/** The digests due for a chat now: ['w'], ['m'], both or none. */
function dueDigests(chat, now = new Date()) {
    if (hourIn(chat.timezone, now) < DIGEST_HOUR) return [];
    const today = todayIn(chat.timezone, now);
    const due = [];
    if (chat.digest_week && chat.digest_week_sent !== periodKey('w', today)) due.push('w');
    if (chat.digest_month && chat.digest_month_sent !== periodKey('m', today)) due.push('m');
    return due;
}

/**
 * What digest_*_sent to store when a digest is turned on: this period's key if its moment has
 * passed (the first digest then comes with the next period, not straight away mid-week), else
 * null (later today it comes as usual).
 */
function sentMarkOnEnable(kind, chat, now = new Date()) {
    const today = todayIn(chat.timezone, now);
    const firstDay = kind === 'w' ? weekStart(today) : `${today.slice(0, 7)}-01`;
    const beforeTen = today === firstDay && hourIn(chat.timezone, now) < DIGEST_HOUR;
    return beforeTen ? null : periodKey(kind, today);
}

let running = false;

async function sendDigests(bot, now = new Date()) {
    if (running) return;
    running = true;
    try {
        const chats = await Chat.findAll({ where: { [Op.or]: [{ digest_week: true }, { digest_month: true }] } });
        for (const chat of chats) {
            if (chat.blockedUntil && new Date(chat.blockedUntil) > now) continue;
            if (isQuietNow(chat, now)) continue;
            for (const kind of dueDigests(chat, now)) {
                const field = kind === 'w' ? 'digest_week_sent' : 'digest_month_sent';
                const key = periodKey(kind, todayIn(chat.timezone, now));
                let view;
                try {
                    view = await calendarView(chat, kind, 0, { digest: true, now });
                } catch (err) {
                    console.error(`[Digest] Couldn't put together the ${kind} digest for ${chat.id}:`, err.message);
                    continue;
                }
                if (!view.empty) {
                    const result = await deliver(bot, chat.id, `${TITLES[kind]}\n\n${view.text}`, {
                        extra: { ...NO_PREVIEW, ...view.keyboard }
                    });
                    // Telegram or the network down: the next round tries again
                    if (result.status === 'failed') continue;
                    stats.count(result.status === 'sent' ? 'sent' : 'failed');
                    if (result.status !== 'sent') {
                        console.error(
                            `[Digest] ${kind} digest for ${chat.id} dropped (${result.status}): ${result.error}`
                        );
                    }
                }
                await chat.update({ [field]: key });
            }
        }
    } catch (err) {
        console.error('[Digest] Sending digests failed:', err.message);
    } finally {
        running = false;
    }
}

module.exports = { sendDigests, dueDigests, sentMarkOnEnable, periodKey };
