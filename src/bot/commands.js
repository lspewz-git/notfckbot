/** Slash commands and the reply-keyboard buttons. */
const { Markup } = require('telegraf');
const { setState, clearState } = require('./state');
const { mainMenu, getCancelMenu } = require('./keyboards');
const { clearLastMessages } = require('./search');
const { sendSubscriptionList } = require('./subscriptions');

function register(bot) {
    bot.command('start', async (ctx) => {
        clearState(ctx);
        setState(ctx, { state: 'idle', results: [], currentPage: 0, lastMessageIds: [] });
        console.log(`[Bot] /start from ${ctx.from.id} (${ctx.from.username || 'N/A'})`);
        await ctx.reply(
            '👋 <b>Привет!</b>\n\nЯ помогу тебе не пропустить выход новых серий твоих любимых сериалов и цифровой релиз фильмов.\n\nИспользуй меню ниже, чтобы начать работу.',
            { parse_mode: 'HTML', ...mainMenu(ctx) }
        );
    });

    bot.command('reset', async (ctx) => {
        clearState(ctx);
        setState(ctx, { state: 'idle', results: [], currentPage: 0, lastMessageIds: [] });
        await ctx.reply('🔄 Состояние сброшено. Кнопки должны снова работать!', mainMenu(ctx));
    });

    const sendHelp = async (ctx) => {
        const helpText = `
📖 <b>Как пользоваться ботом:</b>

<b>Сериалы:</b>
1. Нажми 🔍 <b>Поиск</b> или используй команду /search и введи название.
2. Выбери нужный сериал из списка и нажми <b>✨ Подписаться</b>.
3. Выбери режим уведомлений:
   • 🔔 <b>Каждую серию</b> — уведомление сразу после выхода новой серии.
   • 📦 <b>Весь сезон</b> — одно уведомление, когда весь сезон станет доступен.
   • 🆕 <b>1-я серия + Сезон</b> — уведомление о первой серии и когда сезон выйдет целиком.

<b>Фильмы:</b>
• При поиске фильма нажми <b>✨ Подписаться</b> — добавлю в список ожидания.
• Когда фильм выйдет — пришлю ссылки для просмотра 🎬

В разделе 📺 <b>Мои подписки</b> или по команде /subs ты можешь:
• Просмотреть сериалы и фильмы из списка ожидания.
• Изменить режим уведомлений и отписаться.

💡 <i>Бот проверяет обновления каждые несколько часов.</i>

<b>Дополнительные команды:</b>
 • /menu_off — Отключить нижнее меню (кнопки).
 • /menu_on — Включить нижнее меню.
 • /cancel — Отменить текущее действие.
    `;
        return ctx.replyWithHTML(helpText, mainMenu(ctx));
    };

    bot.command('help', sendHelp);
    bot.hears('ℹ️ Помощь', sendHelp);
    bot.hears('❓ Помощь', sendHelp);

    bot.hears('🔍 Поиск', (ctx) => {
        setState(ctx, { state: 'waiting_for_search', results: [], currentPage: 0 });
        ctx.reply('Введите название фильма или сериала для поиска:', getCancelMenu(ctx));
    });

    bot.command('search', async (ctx) => {
        setState(ctx, { state: 'waiting_for_search', results: [], currentPage: 0 });
        await ctx.reply('Введите название фильма или сериала для поиска:', mainMenu(ctx));
    });

    // FIX: Single handler, no duplication
    bot.command('subs', sendSubscriptionList);
    bot.hears('📺 Мои подписки', sendSubscriptionList);

    bot.command('menu_off', async (ctx) => {
        if (ctx.state.chatData) {
            await ctx.state.chatData.update({ menu_enabled: false });
            await ctx.reply(
                'Нижнее меню отключено. Теперь используйте команды: /search, /subs, /help',
                Markup.removeKeyboard()
            );
        }
    });

    bot.command('menu_on', async (ctx) => {
        if (ctx.state.chatData) {
            await ctx.state.chatData.update({ menu_enabled: true });
            await ctx.reply('Нижнее меню включено!', mainMenu(ctx));
        }
    });

    // "Случайный фильм" was removed. Chats still have the old keyboard with its button (Telegram
    // keeps a reply keyboard until the bot sends another), and someone may type /random: answer
    // both with the current menu, so the button disappears instead of turning into a search
    const handleRemovedRandom = (ctx) => ctx.reply('Этой функции больше нет. Обновил меню.', mainMenu(ctx));
    bot.command('random', handleRemovedRandom);
    bot.hears('🎲 Случайный фильм', handleRemovedRandom);

    const handleCancel = async (ctx) => {
        await clearLastMessages(ctx, ctx.chat.id);
        setState(ctx, { state: 'idle', results: [] });
        await ctx.reply('Действие отменено.', mainMenu(ctx));
    };

    bot.command('cancel', handleCancel);
    bot.hears('❌ Отмена', handleCancel);
}

module.exports = { register };
