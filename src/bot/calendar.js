/**
 * 📅 Week and month: what came out and comes out among the chat's subscriptions, by day (week)
 * or by week (month), back and ahead (src/calendar.js). /week, the button in 📺 Мои подписки,
 * the weekly and monthly digests (src/cron/digests.js). One message, edited in place.
 */
const { Markup } = require('telegraf');
const { period, periodItems, calendarText, addMonths, MONTHS_TITLE } = require('../calendar');

// How far the arrows go: two years either way is past anything TMDB lists usefully
const LIMIT = { w: 104, m: 24 };
const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

const monthName = (p, n) => MONTHS_TITLE[Number(addMonths(p.from, n).slice(5, 7)) - 1];

/**
 * The buttons: back, current, ahead; week or month; back to the subscriptions (not on a digest,
 * which the group's members didn't call up themselves).
 */
function calendarKeyboard(p, { digest = false } = {}) {
    const { kind, offset } = p;
    const go = (n) => `cal_${kind}_${n}`;
    const nav = [];
    if (offset > -LIMIT[kind])
        nav.push(Markup.button.callback(kind === 'm' ? `◀️ ${monthName(p, -1)}` : '◀️ Прошлая', go(offset - 1)));
    nav.push(Markup.button.callback(kind === 'm' ? 'Текущий' : 'Текущая', go(0)));
    if (offset < LIMIT[kind])
        nav.push(Markup.button.callback(kind === 'm' ? `${monthName(p, 1)} ▶️` : 'Следующая ▶️', go(offset + 1)));
    const rows = [
        nav,
        [
            Markup.button.callback(`${kind === 'w' ? '✅ ' : ''}Неделя`, 'cal_w_0'),
            Markup.button.callback(`${kind === 'm' ? '✅ ' : ''}Месяц`, 'cal_m_0')
        ]
    ];
    if (!digest) rows.push([Markup.button.callback('⬅️ К подпискам', 'subs_o')]);
    return Markup.inlineKeyboard(rows);
}

/**
 * The text and buttons for a chat.
 * @param {{ id: number | string, timezone?: string }} chat
 * @returns {Promise<{ text: string, keyboard: object, empty: boolean }>}
 */
async function calendarView(chat, kind, offset, { digest = false, now = new Date() } = {}) {
    const p = period(kind, offset, chat.timezone, now);
    const data = await periodItems(chat.id, p.from, p.to);
    return { text: calendarText(p, data), keyboard: calendarKeyboard(p, { digest }), empty: !data.items.length };
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
        const offset = Number(ctx.match[2]);
        if (Math.abs(offset) > LIMIT[kind] || !ctx.state.chatData) return ctx.answerCbQuery();
        // Answered first: the seasons may take TMDB a few seconds the first time
        await ctx.answerCbQuery();
        // A digest's buttons keep it a digest (no way back to a menu nobody here called up)
        const rows = (ctx.callbackQuery.message && ctx.callbackQuery.message.reply_markup) || {};
        const digest = !(rows.inline_keyboard || []).flat().some((b) => b.callback_data === 'subs_o');
        const view = await calendarView(ctx.state.chatData, kind, offset, { digest });
        await ctx.editMessageText(view.text, { parse_mode: 'HTML', ...NO_PREVIEW, ...view.keyboard }).catch((err) => {
            if (!/not modified/.test(err.message)) throw err;
        });
    });
}

module.exports = { register, calendarView, calendarKeyboard };
