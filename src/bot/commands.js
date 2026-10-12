/** Slash commands and the reply-keyboard buttons. */
const { Markup } = require('telegraf');
const { getDetails, getRandomMovie } = require('../api/tmdb');
const { findKinopoiskIdQuick } = require('../api/kinopoisk');
const { escapeHtml } = require('../constants');
const { setState, clearState } = require('./state');
const { mainMenu, getCancelMenu, watchButtonRows } = require('./keyboards');
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

    const handleRandomMovie = async (ctx) => {
        setState(ctx, { state: 'idle' });
        try {
            const item = await getRandomMovie();
            if (!item) return ctx.reply('Не удалось найти подходящий фильм. Попробуйте еще раз!', mainMenu(ctx));

            const year = (item.release_date || '').substring(0, 4) || 'н/д';
            const name = item.title || item.original_title || 'Без названия';
            const rating = item.vote_average ? `⭐️ ${item.vote_average.toFixed(1)}/10` : '';

            // Random movie uses discover, but we need details for director
            const fullDetails = await getDetails(item.id, 'movie');
            const directorLine = fullDetails.director_name
                ? `🎬 Режиссер: ${escapeHtml(fullDetails.director_name)}\n`
                : '';

            const caption = `🎲 <b>${escapeHtml(name)}</b> (${year})\n${rating}\n${directorLine}\n<i>${escapeHtml(item.overview) || 'Описание отсутствует.'}</i>`;
            const posterUrl = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;

            // Inline keyboard: watch links, or add to watchlist
            const tmdbId = `movie_${item.id}`;
            const kinopoiskId = await findKinopoiskIdQuick(tmdbId, fullDetails.imdb_id);

            const keyboard = Markup.inlineKeyboard([
                ...watchButtonRows({ title: name, kinopoiskId, mediaType: 'movie' }),
                [Markup.button.callback('📌 В список ожидания', `watchlist_add_${tmdbId}`)]
            ]);

            if (posterUrl) {
                try {
                    await ctx.replyWithPhoto(posterUrl, { caption, parse_mode: 'HTML', ...keyboard });
                } catch {
                    await ctx.replyWithHTML(caption, keyboard);
                }
            } else {
                await ctx.replyWithHTML(caption, keyboard);
            }
        } catch (error) {
            console.error('[Bot] Random movie error:', error);
            await ctx.reply('Ошибка получения случайного фильма.', mainMenu(ctx));
        }
    };

    bot.command('random', handleRandomMovie);
    bot.hears('🎲 Случайный фильм', handleRandomMovie);

    const handleCancel = async (ctx) => {
        await clearLastMessages(ctx, ctx.chat.id);
        setState(ctx, { state: 'idle', results: [] });
        await ctx.reply('Действие отменено.', mainMenu(ctx));
    };

    bot.command('cancel', handleCancel);
    bot.hears('❌ Отмена', handleCancel);
}

module.exports = { register };
