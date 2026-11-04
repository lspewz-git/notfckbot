/**
 * Signing in to the panel from the bot (src/account/auth.js):
 * - "Войти через Telegram" on the sign-in page opens the bot with /start L<code>: the bot asks
 *   "Войти в панель?" and the page lets the user in only after "Да, это я".
 * - /app: the Mini App button; in a group it opens on that group's page (in /help).
 * One-time sign-in links come only from login-link.js on the server now. Who may sign in: src/account/roles.js (with sign-up open, everyone who
 * started the bot).
 */
const auth = require('../account/auth');
const { confirmation } = require('../account/confirmation');
const { escapeHtml } = require('../constants');
const { log } = require('../log');

const CLOSED = 'Вход в панель пока в закрытом тесте.';
const GONE = 'Этот вход устарел. Нажмите «Continue with Telegram» на странице ещё раз.';

const nameOf = (from) =>
    from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ') || null;
const userOf = (from) => ({ id: from.id, name: nameOf(from) });

/**
 * In a group: the bot's Mini App opened on this group's page (`startapp`, signed into the launch data:
 * src/account/miniapp.js). Not a sign-in link: whoever opens it signs in as themselves, and the panel
 * opens the group only for its members. Needs the bot's Main Mini App set in BotFather.
 */
function appButton(ctx) {
    const username = ctx.botInfo?.username;
    if (!username || !ctx.botInfo?.has_main_web_app) return {};
    const inGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const url = `https://t.me/${username}?startapp${inGroup ? `=c${ctx.chat.id}` : ''}`;
    return { reply_markup: { inline_keyboard: [[{ text: '📱 Открыть в приложении', url }]] } };
}

function register(bot) {
    // Before the usual /start (src/bot/commands.js): only "/start L<code>" is ours
    bot.command('start', async (ctx, next) => {
        const payload = String(ctx.message.text || '').split(/\s+/)[1] || '';
        if (!payload.startsWith('L')) return next();
        const code = payload.slice(1);
        if (ctx.chat.type !== 'private') return;
        if (!(await auth.isAllowed(ctx.from.id))) return ctx.reply(CLOSED);
        if (!auth.isWaiting(code)) return ctx.reply(GONE);
        const ask = confirmation(code);
        await ctx.reply(ask.text, ask.extra);
    });

    bot.action(/^login_(ok|no)_([A-Za-z0-9_-]{32})$/, async (ctx) => {
        const yes = ctx.match[1] === 'ok';
        const answered = await auth.answerCode(ctx.match[2], userOf(ctx.from), yes);
        await ctx.answerCbQuery();
        const text = !answered ? GONE : yes ? '✅ Готово: вернитесь на страницу панели.' : 'Вход отменён.';
        await ctx.editMessageText(text).catch(() => {});
        if (answered) log.info(`[Account] Telegram sign-in ${yes ? 'confirmed' : 'refused'} by ${ctx.from.id}`);
    });

    // /app: the Mini App button, in a group on that group's page. Anyone may call it: the panel itself
    // decides who gets in and which chats they see
    bot.command('app', async (ctx) => {
        const button = appButton(ctx);
        if (!button.reply_markup) return ctx.reply('Приложение пока не настроено.');
        const group = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        const text = group
            ? `📱 Панель группы «${escapeHtml(ctx.chat.title || '')}»: подписки, календарь и настройки.`
            : '📱 Панель: подписки, календарь и настройки.';
        await ctx.reply(text, { parse_mode: 'HTML', ...button });
    });
}

module.exports = { register };
