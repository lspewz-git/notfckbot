/** Bot actions renew the actor's valid panel sessions, never the whole group's. */
const { touchSessions } = require('../account/auth');
const { log } = require('../log');

async function accountActivity(ctx, next) {
    await next();
    const text = ctx.message && ctx.message.text;
    if (!ctx.from || ctx.from.is_bot || ctx.message?.sender_chat) return;
    const active = ctx.callbackQuery || (text && (ctx.chat?.type === 'private' || text.startsWith('/')));
    if (!active) return;
    try {
        await touchSessions({ userId: ctx.from.id });
    } catch (err) {
        log.warn(`[Account] Bot activity renewal failed: ${err.message}`);
    }
}

module.exports = { accountActivity };
