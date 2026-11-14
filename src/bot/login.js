/**
 * Signing in to the panel from the bot (src/account/auth.js):
 * - "Войти через Telegram" on the sign-in page opens the bot with /start L<code>: the bot asks
 *   "Войти в панель?" and the page lets the user in only after "Да, это я".
 * - /code (or ⚙️ Настройки → 🔑 Вход по коду): the six digits from the sign-in page, for a device
 *   without Telegram; they sign that page in at once, the bot only says whether it worked.
 * - /app: the Mini App button; in a group it opens on that group's page (in /help).
 * One-time sign-in links come only from login-link.js on the server now. Who may sign in: src/account/roles.js (with sign-up open, everyone who
 * started the bot).
 */
const auth = require('../account/auth');
const { confirmation } = require('../account/confirmation');
const { placeLine } = require('../account/devices');
const { escapeHtml } = require('../constants');
const { getState, setState } = require('./state');
const { log } = require('../log');
const events = require('../chat-events');
const { isGroupChat } = require('./access');
const { appUrl } = require('../app-links');
const { plural } = require('../words');

const CLOSED = 'Вход в панель пока в закрытом тесте.';
const GONE = 'Этот вход устарел. Нажмите «Continue with Telegram» на странице ещё раз.';

const CODE_STATE = 'waiting_for_login_code';
const CODE_ASK = '🔑 <b>Вход по коду</b>\n\nПришлите 6 цифр с экрана входа в панель. Код действует 5 минут.';
const CODE_PRIVATE = 'Вход по коду — в личном чате с ботом.';
// Something that looks like the six digits (a typo included): taken as a try, anything else isn't
const DIGITS_LIKE = /^[\d\s-]{1,16}$/;

/** "1 минуту", "3 минуты", "5 минут". */
const minutes = (n) => plural(n, 'минуту', 'минуты', 'минут');

const HEADS = {
    known: '✅ <b>Вход выполнен</b>',
    new: '✅ <b>Вход выполнен на новом устройстве</b>',
    odd: '⚠️ <b>Незнакомый вход</b>'
};

/**
 * "✅ Вход выполнен" and where: a browser the user signed in from before gets one short line, a new
 * one its address too and a button to cancel (see tryCheck), like Telegram's "Новый вход". No
 * question: the user has just sent the digits themselves (05.11).
 */
function signedInText({ device, seen }) {
    const name = device?.name ? escapeHtml(device.name) : '';
    if (seen === 'known') {
        const line = [name, escapeHtml(placeLine(device && { ...device, ip: null }))].filter(Boolean).join(' · ');
        return HEADS.known + (line ? `\n${line}` : '');
    }
    const lines = [name, escapeHtml(placeLine(device))].filter(Boolean).join('\n');
    return (HEADS[seen] || HEADS.new) + (lines ? `\n${lines}` : '');
}

/** The bot's answer to the digits (auth.answerCheck). */
function checkReply(result) {
    if (result.state === 'in') return signedInText(result);
    if (result.state === 'closed') return CLOSED;
    if (result.state === 'again') return 'Этот код уже принят: вход выполнен.';
    if (result.state === 'empty') return 'Пришлите 6 цифр с экрана входа в панель.';
    if (result.state === 'paused')
        return `⏸ <b>Слишком много неверных кодов.</b>\nПопробуйте через ${minutes(result.minutes)}.`;
    return (
        '❌ <b>Код не подошёл</b>\nТакого кода нет или его время вышло. Начните вход в панели заново.' +
        `\n<i>Осталось попыток: ${result.left}</i>`
    );
}

const codeBack = { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'settings_root' }]] } };

const userOf = (ctx) => ({ id: ctx.from.id, name: events.actor(ctx).userName });

/**
 * In a group: the bot's Mini App opened on this group's page (`startapp`, signed into the launch data:
 * src/account/miniapp.js). Not a sign-in link: whoever opens it signs in as themselves, and the panel
 * opens the group only for its members. Needs the bot's Main Mini App set in BotFather.
 */
function appButton(ctx) {
    const url = appUrl(ctx.botInfo, isGroupChat(ctx.chat) ? `c${ctx.chat.id}` : '');
    return url ? { reply_markup: { inline_keyboard: [[{ text: '📱 Открыть в приложении', url }]] } } : {};
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
        const answered = await auth.answerCode(ctx.match[2], userOf(ctx), yes);
        await ctx.answerCbQuery();
        const text = !answered ? GONE : yes ? '✅ Готово: вернитесь на страницу панели.' : 'Вход отменён.';
        await ctx.editMessageText(text).catch(() => {});
        if (answered) log.info(`[Account] Telegram sign-in ${yes ? 'confirmed' : 'refused'} by ${ctx.from.id}`);
    });

    // The digits from the sign-in page: "/code 042719", or /code and then the digits
    const tryCheck = async (ctx, digits) => {
        const clean = digits.replace(/[\s-]/g, '');
        // Only spaces or dashes: not a try
        const result = clean ? await auth.answerCheck(clean, userOf(ctx)) : { state: 'empty' };
        // A wrong try keeps waiting for the digits; anything else ends that wait (and only that:
        // "/code 042719" during a search leaves the search alone)
        if (!['wrong', 'empty'].includes(result.state) && getState(ctx).state === CODE_STATE)
            setState(ctx, { state: 'idle' });
        if (result.state !== 'in') return ctx.replyWithHTML(checkReply(result));
        log.info(`[Account] Code sign-in by ${ctx.from.id}`);
        // In already; from a new browser the button ends that sign-in (auth.denyClaim)
        if (result.seen === 'known') return ctx.replyWithHTML(checkReply(result));
        await ctx.replyWithHTML(checkReply(result), {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🚫 Не моё устройство — отменить вход', callback_data: `login_notme_${result.claim}` }]
                ]
            }
        });
    };

    bot.action(/^login_(me|notme)_([A-Za-z0-9_-]{22})$/, async (ctx) => {
        // "✅ Это я" under replies sent before 05.11: only the buttons go (a browser becomes known by a
        // sign-in confirmed in Telegram, not by digits)
        if (ctx.match[1] === 'me') {
            await ctx.answerCbQuery('Хорошо');
            await ctx.editMessageReplyMarkup(undefined).catch(() => {});
            return;
        }
        const ended = await auth.denyClaim(ctx.match[2], ctx.from.id);
        await ctx.answerCbQuery();
        const text = ended
            ? '🚫 <b>Вход отменён:</b> тот сеанс завершён.'
            : 'Этот вход уже не отменить. Завершить сеансы можно в панели: My account → Devices.';
        await ctx.editMessageText(text, { parse_mode: 'HTML' }).catch(() => {});
    });
    const askCode = (ctx) => setState(ctx, { state: CODE_STATE });

    bot.command('code', async (ctx) => {
        if (ctx.chat.type !== 'private') return ctx.reply(CODE_PRIVATE);
        const digits = String(ctx.message.text || '')
            .split(/\s+/)
            .slice(1)
            .join('');
        if (digits) return tryCheck(ctx, digits);
        askCode(ctx);
        await ctx.replyWithHTML(CODE_ASK);
    });
    // From ⚙️ Настройки in a private chat (src/bot/settings.js)
    bot.action('login_code', async (ctx) => {
        await ctx.answerCbQuery();
        if (ctx.chat.type !== 'private') return;
        askCode(ctx);
        await ctx.editMessageText(CODE_ASK, { parse_mode: 'HTML', ...codeBack }).catch(() => {});
    });
    bot.on('text', async (ctx, next) => {
        if (ctx.chat.type !== 'private' || getState(ctx).state !== CODE_STATE) return next();
        const text = ctx.message.text.trim();
        if (!DIGITS_LIKE.test(text)) {
            // A menu button or a search: the code screen is left
            setState(ctx, { state: 'idle' });
            return next();
        }
        await tryCheck(ctx, text);
    });

    // /app: the Mini App button, in a group on that group's page. Anyone may call it: the panel itself
    // decides who gets in and which chats they see
    bot.command('app', async (ctx) => {
        const button = appButton(ctx);
        if (!button.reply_markup) return ctx.reply('Приложение пока не настроено.');
        const text = isGroupChat(ctx.chat)
            ? `📱 Панель группы «${escapeHtml(ctx.chat.title || '')}»: подписки, календарь и настройки.`
            : '📱 Панель: подписки, календарь и настройки.';
        await ctx.reply(text, { parse_mode: 'HTML', ...button });
    });
}

module.exports = { register };
