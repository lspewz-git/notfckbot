/**
 * 📅 The calendar: what came out and comes out among the chat's subscriptions in a week (by day),
 * a month (by week) or a year (src/bot/history.js), with the neighbouring period on either side.
 * /week, the button in 📺 Мои подписки, the weekly and monthly digests (src/cron/digests.js).
 * One message, edited in place.
 */
const { Markup } = require('telegraf');
const { period, periodItems, calendarText, addMonths, MONTHS_TITLE } = require('../calendar');

// The previous and the next week or month; further is a click-through nobody needs
const LIMIT = 1;
const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

const monthName = (p, n) => MONTHS_TITLE[Number(addMonths(p.from, n).slice(5, 7)) - 1];

/**
 * Whether "⬅️ К подпискам" works for whoever presses it. A digest has no owner: in a group where
 * only a menu's owner may press its buttons, the button would only say the menu is out of date.
 * @param {{ id: number | string, buttons_mode?: string }} chat
 */
const canGoBack = (chat) => Number(chat.id) > 0 || chat.buttons_mode === 'all';

/** A digest, or a view opened from one: its buttons have no way back to the subscriptions. */
const isDigest = (ctx) => {
    const markup = (ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.reply_markup) || {};
    return !(markup.inline_keyboard || []).flat().some((b) => b.callback_data === 'subs_o');
};

/** Week, month, year: the shown one ticked; then the way back to the subscriptions, if any. */
function viewRows(active, { back = true } = {}) {
    const tab = (key, label, data) => Markup.button.callback(`${key === active ? '✅ ' : ''}${label}`, data);
    const rows = [[tab('w', 'Неделя', 'cal_w_0'), tab('m', 'Месяц', 'cal_m_0'), tab('y', 'Год', 'hist_0')]];
    if (back) rows.push([Markup.button.callback('⬅️ К подпискам', 'subs_o')]);
    return rows;
}

/** The buttons: the neighbouring week or month (only those), then the tabs. */
function calendarKeyboard(p, { back = true } = {}) {
    const { kind, offset } = p;
    const label = (n) =>
        kind === 'm' ? monthName(p, n - offset) : n === 0 ? 'Текущая' : n < 0 ? 'Прошлая' : 'Следующая';
    const nav = [];
    if (offset > -LIMIT) nav.push(Markup.button.callback(`◀️ ${label(offset - 1)}`, `cal_${kind}_${offset - 1}`));
    if (offset < LIMIT) nav.push(Markup.button.callback(`${label(offset + 1)} ▶️`, `cal_${kind}_${offset + 1}`));
    return Markup.inlineKeyboard([nav, ...viewRows(kind, { back })]);
}

/**
 * The text and buttons for a chat.
 * @param {{ id: number | string, timezone?: string, buttons_mode?: string }} chat
 * @returns {Promise<{ text: string, keyboard: object, empty: boolean }>}
 */
async function calendarView(chat, kind, offset, { digest = false, now = new Date() } = {}) {
    const p = period(kind, offset, chat.timezone, now);
    const data = await periodItems(chat.id, p.from, p.to);
    const back = !digest || canGoBack(chat);
    return { text: calendarText(p, data), keyboard: calendarKeyboard(p, { back }), empty: !data.items.length };
}

function register(bot) {
    bot.command('week', async (ctx) => {
        if (!ctx.state.chatData) return;
        await ctx.sendChatAction('typing').catch(() => {});
        const view = await calendarView(ctx.state.chatData, 'w', 0);
        await ctx.reply(view.text, { parse_mode: 'HTML', ...NO_PREVIEW, ...view.keyboard });
    });

    bot.action(/^cal_(w|m)_(-?\d{1,3})$/, async (ctx) => {
        const kind = ctx.match[1];
        // A message from before the limit may still have buttons further out: the current period
        const offset = Math.abs(Number(ctx.match[2])) > LIMIT ? 0 : Number(ctx.match[2]);
        if (!ctx.state.chatData) return ctx.answerCbQuery();
        // Answered first: the seasons may take TMDB a few seconds the first time
        await ctx.answerCbQuery();
        // A digest's buttons keep it a digest (no way back to a menu nobody here called up)
        const view = await calendarView(ctx.state.chatData, kind, offset, { digest: isDigest(ctx) });
        await ctx.editMessageText(view.text, { parse_mode: 'HTML', ...NO_PREVIEW, ...view.keyboard }).catch((err) => {
            if (!/not modified/.test(err.message)) throw err;
        });
    });
}

module.exports = { register, calendarView, calendarKeyboard, viewRows, canGoBack, isDigest };
