/**
 * Signing in to the panel from the bot (src/account/auth.js):
 * - "Войти через Telegram" on the sign-in page opens the bot with /start L<code>: the bot asks
 *   "Войти в панель?" and the page lets the user in only after "Да, это я".
 * - /login: a one-time link, always in the user's private chat: in a group, the link would let any
 *   member in under their name.
 * Neither is in /help. Who may sign in: src/account/roles.js (with sign-up open, everyone who
 * started the bot).
 */
const { Markup } = require('telegraf');
const auth = require('../account/auth');
const { escapeHtml } = require('../constants');
const { log } = require('../log');

const CLOSED = 'Вход в панель пока в закрытом тесте.';
const MINUTES = auth.LINK_TTL_MS / 60000;
const GONE = 'Этот вход устарел. Нажмите «Continue with Telegram» на странице ещё раз.';

const nameOf = (from) =>
    from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ') || null;
const userOf = (from) => ({ id: from.id, name: nameOf(from) });

function register(bot) {
    // Before the usual /start (src/bot/commands.js): only "/start L<code>" is ours
    bot.command('start', async (ctx, next) => {
        const payload = String(ctx.message.text || '').split(/\s+/)[1] || '';
        if (!payload.startsWith('L')) return next();
        const code = payload.slice(1);
        if (ctx.chat.type !== 'private') return;
        if (!(await auth.isAllowed(ctx.from.id))) return ctx.reply(CLOSED);
        if (!auth.isWaiting(code)) return ctx.reply(GONE);
        await ctx.reply(
            `🔐 <b>Войти в панель NotFckBot?</b>\n\nПроверочный код: <b>${auth.checkWord(code)}</b>. Нажмите «Да», только если ` +
                'этот же код сейчас на вашей странице входа. Если вы не нажимали «Continue with Telegram», нажмите «Нет».',
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Да, это я', `login_ok_${code}`)],
                    [Markup.button.callback('✖️ Нет', `login_no_${code}`)]
                ])
            }
        );
    });

    bot.action(/^login_(ok|no)_([A-Za-z0-9_-]{32})$/, async (ctx) => {
        const yes = ctx.match[1] === 'ok';
        const answered = await auth.answerCode(ctx.match[2], userOf(ctx.from), yes);
        await ctx.answerCbQuery();
        const text = !answered ? GONE : yes ? '✅ Готово: вернитесь на страницу панели.' : 'Вход отменён.';
        await ctx.editMessageText(text).catch(() => {});
        if (answered) log.info(`[Account] Telegram sign-in ${yes ? 'confirmed' : 'refused'} by ${ctx.from.id}`);
    });

    bot.command('login', async (ctx) => {
        const from = ctx.from;
        if (!from || !(await auth.isAllowed(from.id))) return ctx.reply(CLOSED);
        const group = ctx.chat.type !== 'private';
        let link;
        try {
            link = await auth.createLink(userOf(from), ctx.chat.id);
        } catch (err) {
            log.error(`[Account] Sign-in link failed: ${err.message}`);
            return ctx.reply('Не удалось создать ссылку. Попробуйте ещё раз.');
        }
        if (!link) {
            log.warn('[Account] /login: PANEL_URL is not set');
            return ctx.reply('Вход в панель ещё не настроен.');
        }
        const where = group ? `аккаунт группы «${escapeHtml(ctx.chat.title || '')}»` : 'панель';
        const text =
            `🔐 <a href="${link}">Открыть ${where}</a>\n\n` +
            `Ссылка работает ${MINUTES} минут и открывается один раз. Никому её не пересылайте.`;
        try {
            // The private chat with the user: in a group that is a message of its own, not a reply
            await ctx.telegram.sendMessage(from.id, text, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true }
            });
            if (group) await ctx.reply('Отправил ссылку вам в личные сообщения.');
            log.info(`[Account] Sign-in link sent to ${from.id}${group ? ` for ${ctx.chat.id}` : ''}`);
        } catch (err) {
            log.warn(`[Account] Sign-in link to ${from.id} failed: ${err.message}`);
            await ctx.reply(
                group
                    ? 'Не могу написать вам в личку: откройте чат со мной, нажмите «Старт» и повторите /login.'
                    : 'Не удалось отправить ссылку. Попробуйте ещё раз.'
            );
        }
    });
}

module.exports = { register };
