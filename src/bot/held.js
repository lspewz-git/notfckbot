/**
 * The buttons of the list that comes after quiet hours (src/cron/held.js): each sends the
 * notification it stands for, in full. Anyone in a group may press them, as the list is for all.
 */
const { HeldNotification } = require('../db');

function register(bot) {
    bot.action(/^held_(\d+)$/, async (ctx) => {
        const item = await HeldNotification.findOne({ where: { id: Number(ctx.match[1]), chatId: ctx.chat.id } });
        if (!item) return ctx.answerCbQuery('Это уведомление уже недоступно.', { show_alert: true });
        await ctx.answerCbQuery();
        const extra = { parse_mode: 'HTML' };
        if (item.photo) {
            // A poster Telegram can't fetch any more: the text still goes
            const sent = await ctx.replyWithPhoto(item.photo, { caption: item.text, ...extra }).catch(() => null);
            if (sent) return;
        }
        await ctx.reply(item.text, extra);
    });
}

module.exports = { register };
