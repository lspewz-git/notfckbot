/** Slash commands and the reply-keyboard buttons. */
const { setState, clearState } = require('./state');
const { MENU, mainMenu, getCancelMenu } = require('./keyboards');
const { clearLastMessages, askForQuery } = require('./search');
const { sendSubscriptionList } = require('./subscriptions');
const { log } = require('../log');

function register(bot) {
    bot.command('start', async (ctx) => {
        clearState(ctx);
        log.info(`[Bot] /start from ${ctx.from.id} (${ctx.from.username || 'N/A'})`);
        await ctx.reply(
            '👋 <b>Привет!</b>\n\nЯ помогу тебе не пропустить выход новых серий твоих любимых сериалов и релизы фильмов.\n\nИспользуй меню ниже, чтобы начать работу.',
            { parse_mode: 'HTML', ...mainMenu(ctx) }
        );
    });

    bot.command('reset', async (ctx) => {
        clearState(ctx);
        await ctx.reply('🔄 Состояние сброшено. Кнопки должны снова работать!', mainMenu(ctx));
    });

    const sendHelp = async (ctx) => {
        const helpText = `
📖 <b>Как пользоваться ботом:</b>

<b>Сериалы:</b>
1. Нажми 🔍 <b>Поиск</b> или используй команду /search и введи название.
2. Выбери нужный сериал из списка — откроется его карточка.
3. Выбери режим уведомлений:
   • 🔔 <b>Каждую серию</b> — уведомление сразу после выхода новой серии.
   • 📦 <b>Весь сезон</b> — одно уведомление, когда весь сезон станет доступен.
   • 🆕 <b>1-я серия + Сезон</b> — уведомление о первой серии и когда сезон выйдет целиком.

<b>Фильмы:</b>
• В карточке фильма нажми <b>📌 В список ожидания</b>.
• Когда фильм выйдет — пришлю ссылки для просмотра 🎬

В разделе 📺 <b>Мои подписки</b> или по команде /subs ты можешь:
• Просмотреть сериалы и фильмы из списка ожидания.
• Изменить режим уведомлений и отписаться.
• 📅 <b>Календарь</b> — что выходит и выходило у подписок: неделя по дням и месяц по неделям (/week), год — прошлый, текущий и следующий, со ссылками на Кинопоиск (/history).

💡 <i>Бот проверяет обновления каждые несколько часов.</i>

⚙️ <b>Настройки</b> или /settings: кто может нажимать кнопки бота в группе, нижнее меню, тихие часы (ночью уведомления копятся и приходят утром одним сообщением) и сводки недели и месяца. В группе их меняют только админы.

🔑 /code — вход в панель по коду, если на том устройстве нет Telegram: пришлите 6 цифр с экрана входа. Это же есть в ⚙️ Настройки личного чата.

📱 /app — приложение в Telegram: подписки, календарь и настройки на одном экране. В группе оно открывается сразу на странице этой группы.

<b>Дополнительные команды:</b>
 • /menu_off — Отключить нижнее меню (кнопки).
 • /menu_on — Включить нижнее меню.
 • /cancel — Отменить текущее действие.
    `;
        return ctx.replyWithHTML(helpText, mainMenu(ctx));
    };

    bot.command('help', sendHelp);
    bot.hears([MENU.help, MENU.oldHelp], sendHelp);

    bot.hears(MENU.search, (ctx) => askForQuery(ctx, getCancelMenu(ctx)));
    bot.command('search', (ctx) => askForQuery(ctx, mainMenu(ctx)));

    bot.command('subs', sendSubscriptionList);
    bot.hears(MENU.subs, sendSubscriptionList);

    // /menu_on and /menu_off live in settings.js, next to the settings screen

    // "Случайный фильм" was removed. Chats still have the old keyboard with its button (Telegram
    // keeps a reply keyboard until the bot sends another), and someone may type /random: answer
    // both with the current menu, so the button disappears instead of turning into a search
    const handleRemovedRandom = (ctx) => ctx.reply('Этой функции больше нет. Обновил меню.', mainMenu(ctx));
    bot.command('random', handleRemovedRandom);
    bot.hears(MENU.random, handleRemovedRandom);

    const handleCancel = async (ctx) => {
        await clearLastMessages(ctx, ctx.chat.id);
        setState(ctx, { state: 'idle' });
        await ctx.reply('Действие отменено.', mainMenu(ctx));
    };

    bot.command('cancel', handleCancel);
    bot.hears(MENU.cancel, handleCancel);
}

module.exports = { register };
