/**
 * After quiet hours: what was held for a chat goes out as one message, "🌅 Пока вы спали", a line
 * per notification and a button for each that sends the notification itself (with its links and
 * poster). Run every few minutes (src/cron/index.js), so the list comes soon after the hours end.
 */
const { Op } = require('sequelize');
const { Markup } = require('telegraf');
const { HeldNotification, Chat } = require('../db');
const { deliver } = require('../delivery');
const { isQuietNow } = require('../quiet');
const stats = require('../stats-log');

// Telegram's limit is 4096 characters; the lines carry HTML, so stop well before it
const MAX_TEXT = 3500;
const MAX_BUTTONS = 10;
// The list's buttons answer for a week; then the rows go
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const truncate = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The message for a chat's held notifications, oldest first. */
function heldView(items) {
    const lines = ['🌅 <b>Пока вы спали</b>', ''];
    let length = lines[0].length;
    let left = 0;
    for (const item of items) {
        if (length + item.line.length + 1 > MAX_TEXT) {
            left += 1;
            continue;
        }
        lines.push(item.line);
        length += item.line.length + 1;
    }
    if (left) lines.push(`<i>…и ещё ${left}</i>`);
    lines.push('', '<i>Нажмите кнопку — пришлю уведомление целиком, со ссылками на просмотр.</i>');

    const buttons = items
        .slice(0, MAX_BUTTONS)
        .map((item) => Markup.button.callback(truncate(item.label, 30), `held_${item.id}`));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    rows.push([Markup.button.callback('📅 На этой неделе', 'cal_w_0')]);
    return { text: lines.join('\n'), keyboard: Markup.inlineKeyboard(rows) };
}

let running = false;

/** Sends the list to every chat whose quiet hours are over; clears out rows past their week. */
async function releaseHeld(bot, now = new Date()) {
    if (running) return;
    running = true;
    try {
        const held = await HeldNotification.findAll({ where: { sentAt: null }, order: [['id', 'ASC']] });
        const byChat = new Map();
        for (const item of held) {
            const key = String(item.chatId);
            if (!byChat.has(key)) byChat.set(key, []);
            byChat.get(key).push(item);
        }
        for (const [chatId, items] of byChat) {
            const chat = await Chat.findByPk(chatId);
            if (chat && isQuietNow(chat, now)) continue;
            const { text, keyboard } = heldView(items);
            const result = await deliver(bot, chatId, text, { extra: keyboard });
            // A temporary failure: try again on the next round
            if (result.status === 'failed') continue;
            if (result.status !== 'sent') {
                stats.count('failed', items.length);
                console.error(`[Quiet] List for chat ${chatId} dropped (${result.status}): ${result.error}`);
            } else {
                console.log(`[Quiet] Sent chat ${chatId} the ${items.length} notification(s) held overnight`);
                stats.count('sent', items.length);
            }
            await HeldNotification.update({ sentAt: now }, { where: { id: items.map((i) => i.id) } });
        }
        await HeldNotification.destroy({ where: { sentAt: { [Op.lt]: new Date(now.getTime() - KEEP_MS) } } });
    } catch (err) {
        console.error('[Quiet] Releasing held notifications failed:', err.message);
    } finally {
        running = false;
    }
}

module.exports = { releaseHeld, heldView };
