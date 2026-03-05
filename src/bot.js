const { Telegraf, Markup } = require('telegraf');
const { searchSeries, getSeriesData, getSeasons } = require('./api/kinopoisk');
const { Chat, Series, Subscription, Watchlist } = require('./db');
const { NOTIFY_LABELS, NOTIFY_LABELS_SHORT, NOTIFY_CYCLE, SERIES_TYPES, getWatchLink } = require('./constants');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// ============================================================
// In-Memory State Management
// ============================================================

const userStates = {};

const getStateKey = (ctx) => {
    const chatId = ctx.chat.id;
    const fromId = ctx.from ? ctx.from.id : 'unknown';
    return `${chatId}:${fromId}`;
};

const getState = (ctx) => userStates[getStateKey(ctx)] || { state: 'idle' };

const setState = (ctx, data) => {
    const key = getStateKey(ctx);
    userStates[key] = { ...(userStates[key] || {}), ...data, _lastActivity: Date.now() };
};

// FIX: Memory leak — purge idle state entries older than 30 minutes
const STATE_TTL_MS = 30 * 60 * 1000; // 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const key of Object.keys(userStates)) {
        const last = userStates[key]._lastActivity || 0;
        if (now - last > STATE_TTL_MS) {
            delete userStates[key];
        }
    }
}, 10 * 60 * 1000); // Run cleanup every 10 minutes

// Anti-Spam: throttle to 1 request/second per user
const lastMessageTimes = {};
setInterval(() => {
    // FIX: Memory leak — purge old anti-spam entries (older than 1 minute)
    const cutoff = Date.now() - 60_000;
    for (const userId of Object.keys(lastMessageTimes)) {
        if (lastMessageTimes[userId] < cutoff) {
            delete lastMessageTimes[userId];
        }
    }
}, 60_000);

bot.use(async (ctx, next) => {
    const userId = ctx.from ? ctx.from.id : null;
    if (!userId) return next();

    const now = Date.now();
    if (now - (lastMessageTimes[userId] || 0) < 1000) {
        console.log(`[Anti-Spam] Ignoring rapid message from User ${userId}`);
        return;
    }
    lastMessageTimes[userId] = now;
    return next();
});

// ============================================================
// Keyboard Helpers
// ============================================================

const mainMenu = (ctx) => {
    if (ctx.state && ctx.state.chatData && ctx.state.chatData.menu_enabled === false) {
        return Markup.removeKeyboard();
    }
    return Markup.keyboard([
        ['🔍 Поиск', '📺 Мои подписки'],
        ['ℹ️ Помощь'],
    ]).resize();
};

const cancelMenu = Markup.keyboard([['❌ Отмена']]).resize();

const getCancelMenu = (ctx) => {
    if (ctx.state && ctx.state.chatData && ctx.state.chatData.menu_enabled === false) {
        return Markup.removeKeyboard();
    }
    return cancelMenu;
};

// ============================================================
// Chat Data Middleware
// ============================================================

bot.use(async (ctx, next) => {
    if (ctx.chat) {
        const [chatData] = await Chat.findOrCreate({
            where: { id: ctx.chat.id },
            defaults: { type: ctx.chat.type },
        });
        ctx.state = ctx.state || {};
        ctx.state.chatData = chatData;
    }
    return next();
});

// ============================================================
// Search Pagination Helpers
// ============================================================

const showSearchPage = async (ctx, chatId, page = 0) => {
    const state = getState(ctx);
    const results = state.results || [];
    const total = results.length;
    const perPage = 2;
    const start = page * perPage;
    const end = start + perPage;
    const items = results.slice(start, end);

    if (items.length === 0) {
        setState(ctx, { state: 'idle' });
        return ctx.reply('Больше ничего не найдено.', mainMenu(ctx));
    }

    const messageIds = [];
    for (const item of items) {
        const year = item.year || 'н/д';
        const name = item.name || item.alternativeName || item.enName || 'Без названия';
        const caption = `<b>${name}</b> (${year})`;
        const posterUrl = item.poster ? (item.poster.previewUrl || item.poster.url) : null;
        const keyboard = Markup.inlineKeyboard([[Markup.button.callback('✨ Подписаться', `sub_${item.id}`)]]);

        let sentMsg;
        if (posterUrl) {
            try {
                sentMsg = await ctx.replyWithPhoto(posterUrl, { caption, parse_mode: 'HTML', ...keyboard });
            } catch {
                sentMsg = await ctx.replyWithHTML(caption, keyboard);
            }
        } else {
            sentMsg = await ctx.replyWithHTML(caption, keyboard);
        }
        messageIds.push(sentMsg.message_id);
    }

    const navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('⬅️ Назад', `page_${page - 1}`));
    navRow.push(Markup.button.callback('❌ Стоп', 'cancel_search'));
    if (end < total) navRow.push(Markup.button.callback('Вперед ➡️', `page_${page + 1}`));

    const navMsg = await ctx.reply(
        `Результаты ${start + 1}-${Math.min(end, total)} из ${total}`,
        Markup.inlineKeyboard([navRow])
    );
    messageIds.push(navMsg.message_id);
    setState(ctx, { currentPage: page, lastMessageIds: messageIds });
};

const clearLastMessages = async (ctx, chatId) => {
    const state = getState(ctx);
    if (!state.lastMessageIds) return;
    for (const msgId of state.lastMessageIds) {
        try { await ctx.telegram.deleteMessage(chatId, msgId); } catch { /* already deleted */ }
    }
};

// ============================================================
// FIX: Single handler covering both subscriptions and watchlist
const sendSubscriptionList = async (ctx) => {
    setState(ctx, { state: 'idle' });
    try {
        const [chat, watchlistItems] = await Promise.all([
            Chat.findByPk(ctx.chat.id, { include: [Series] }),
            Watchlist.findAll({ where: { chatId: ctx.chat.id, notified: false } })
        ]);

        const hasSubs = chat && chat.Series && chat.Series.length > 0;
        const hasWatchlist = watchlistItems && watchlistItems.length > 0;

        if (!hasSubs && !hasWatchlist) {
            return ctx.reply('У вас пока нет подписок. Нажмите 🔍 <b>Поиск</b> или используйте /search!', {
                parse_mode: 'HTML',
                ...mainMenu(ctx),
            });
        }

        if (hasSubs) {
            await ctx.reply('📺 <b>Ваши сериалы:</b>', { parse_mode: 'HTML', ...mainMenu(ctx) });
            for (const s of chat.Series) {
                const notifyType = s.Subscription.notify_type;
                const typeLabel = NOTIFY_LABELS[notifyType] || notifyType;
                await ctx.reply(
                    `📺 ${s.title}\nРежим: ${typeLabel}`,
                    Markup.inlineKeyboard([[
                        Markup.button.callback('⚙️ Сменить режим', `toggle_notify_${s.kp_id}`),
                        Markup.button.callback('❌ Отписаться', `unsub_${s.kp_id}`),
                    ]])
                );
            }
        }

        if (hasWatchlist) {
            await ctx.reply('📌 <b>Список ожидания (фильмы):</b>', {
                parse_mode: 'HTML',
                ...(!hasSubs ? mainMenu(ctx) : {})
            });
            for (const item of watchlistItems) {
                const dateLabel = item.premiere_digital
                    ? new Date(item.premiere_digital).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
                    : 'дата не объявлена';
                await ctx.reply(
                    `🎬 ${item.title}${item.year ? ` (${item.year})` : ''}\n📅 Цифровой релиз: ${dateLabel}`,
                    Markup.inlineKeyboard([[
                        Markup.button.callback('❌ Удалить', `unwatchlist_${item.id}`),
                    ]])
                );
            }
        }
    } catch (error) {
        console.error('[Bot] List subscriptions error:', error);
        await ctx.reply('Ошибка получения списка подписок.');
    }
};

// ============================================================
// Commands
// ============================================================

bot.command('start', async (ctx) => {
    delete userStates[getStateKey(ctx)];
    setState(ctx, { state: 'idle', results: [], currentPage: 0, lastMessageIds: [] });
    await ctx.reply(
        '👋 <b>Привет!</b>\n\nЯ помогу тебе не пропустить выход новых серий твоих любимых сериалов и цифровой релиз фильмов.\n\nИспользуй меню ниже, чтобы начать работу.',
        { parse_mode: 'HTML', ...mainMenu(ctx) }
    );
});

bot.command('reset', async (ctx) => {
    delete userStates[getStateKey(ctx)];
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
• Когда фильм выйдет в цифре — пришлю ссылку для просмотра 🎬

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
        await ctx.reply('Нижнее меню отключено. Теперь используйте команды: /search, /subs, /help', Markup.removeKeyboard());
    }
});

bot.command('menu_on', async (ctx) => {
    if (ctx.state.chatData) {
        await ctx.state.chatData.update({ menu_enabled: true });
        await ctx.reply('Нижнее меню включено!', mainMenu(ctx));
    }
});

const handleCancel = async (ctx) => {
    await clearLastMessages(ctx, ctx.chat.id);
    setState(ctx, { state: 'idle', results: [] });
    await ctx.reply('Действие отменено.', mainMenu(ctx));
};

bot.command('cancel', handleCancel);
bot.hears('❌ Отмена', handleCancel);

// ============================================================
// Inline Actions
// ============================================================

bot.action('cancel_search', async (ctx) => {
    await clearLastMessages(ctx, ctx.chat.id);
    setState(ctx, { state: 'idle', results: [] });
    await ctx.reply('Поиск завершен.', mainMenu(ctx));
    await ctx.answerCbQuery();
});

bot.on('text', async (ctx, next) => {
    const text = ctx.message.text;
    const BUTTON_TEXTS = ['🔍 Поиск', '📺 Мои подписки', '❌ Отмена', 'ℹ️ Помощь', '❓ Помощь'];
    if (BUTTON_TEXTS.includes(text) || text.startsWith('/')) return next();

    const state = getState(ctx);
    if (state.state !== 'waiting_for_search') return;

    try {
        const results = await searchSeries(text);
        if (!results || results.length === 0) {
            setState(ctx, { state: 'idle' });
            return ctx.reply('Ничего не найдено 😕', Markup.inlineKeyboard([
                [Markup.button.callback('🏠 В главное меню', 'cancel_search')],
            ]));
        }
        setState(ctx, { results, state: 'searching' });
        await showSearchPage(ctx, ctx.chat.id, 0);
    } catch (error) {
        console.error('[Bot] Search error:', error);
        await ctx.reply('Ошибка при поиске. Попробуйте позже.', mainMenu(ctx));
        setState(ctx, { state: 'idle' });
    }
});

bot.action(/page_(\d+)/, async (ctx) => {
    const page = parseInt(ctx.match[1]);
    await clearLastMessages(ctx, ctx.chat.id);
    await showSearchPage(ctx, ctx.chat.id, page);
    await ctx.answerCbQuery();
});

bot.action(/sub_(\d+)/, async (ctx) => {
    const filmId = ctx.match[1];
    try {
        const data = await getSeriesData(filmId);
        if (!data) return ctx.answerCbQuery('Данные не найдены.');

        const isSeries = SERIES_TYPES.includes(data.type);

        if (!isSeries) {
            // ——— MOVIE: smart release detection ———
            // Clear search result cards immediately so chat stays clean
            await clearLastMessages(ctx, ctx.chat.id);
            setState(ctx, { lastMessageIds: [] });

            const title = data.name || data.alternativeName || data.enName || 'Без названия';
            const movieYear = data.year || null;
            const digitalDate = data.premiere?.digital || null;
            const watchLink = getWatchLink(filmId);
            const now = new Date();
            const currentYear = now.getFullYear();

            // A movie is considered "already released" if:
            //  1. premiere.digital date exists AND it is in the past, OR
            //  2. No digital date, but the movie year is <= current year (classic/old films)
            let isAlreadyReleased = false;
            let releaseDateLabel = null;

            if (digitalDate) {
                const releaseDate = new Date(digitalDate);
                if (!isNaN(releaseDate) && releaseDate <= now) {
                    isAlreadyReleased = true;
                    releaseDateLabel = releaseDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
                }
            }

            // Fallback for old movies without premiere.digital
            if (!isAlreadyReleased && movieYear && movieYear <= currentYear) {
                isAlreadyReleased = true;
                releaseDateLabel = `${movieYear} г.`;
            }

            if (isAlreadyReleased) {
                // Film is already out — show sspoisk link directly
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.url(`▶️ Смотреть на sspoisk.ru`, watchLink)],
                    [Markup.button.callback('⬅️ К результатам', 'back_to_results')],
                ]);
                await ctx.reply(
                    `🎬 <b>${title}</b>${movieYear ? ` (${movieYear})` : ''}\n\n` +
                    `✅ Фильм уже вышел${releaseDateLabel ? ` — <b>${releaseDateLabel}</b>` : ''}.\n\n` +
                    `Можешь посмотреть прямо сейчас:`,
                    { parse_mode: 'HTML', ...keyboard }
                );
                return ctx.answerCbQuery();
            }

            // Film is upcoming — offer to add to watchlist
            let comingDateLabel = 'дата не объявлена';
            if (digitalDate) {
                comingDateLabel = new Date(digitalDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
            } else if (movieYear && movieYear > currentYear) {
                comingDateLabel = `ожидается в ${movieYear} г.`;
            }

            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('📌 В список ожидания', `watchlist_add_${filmId}`)],
                [Markup.button.callback('⬅️ К результатам', 'back_to_results')],
            ]);

            await ctx.reply(
                `🎬 <b>${title}</b>${movieYear ? ` (${movieYear})` : ''}\n\n` +
                `Это фильм, который ещё не вышел в цифре.\n` +
                `📅 Цифровой релиз: <b>${comingDateLabel}</b>\n\n` +
                `Добавить в список ожидания? Как только выйдет — пришлю ссылку.`,
                { parse_mode: 'HTML', ...keyboard }
            );
            return ctx.answerCbQuery();
        }

        // ——— TV SERIES: existing subscription flow ———
        const [series] = await Series.findOrCreate({
            where: { kp_id: filmId },
            defaults: {
                title: data.name || data.alternativeName || data.enName || 'Без названия',
                last_season: 0,
                last_episode: 0,
                poster_url: data.poster ? (data.poster.url || data.poster.previewUrl) : null,
            },
        });

        const currentSub = await Subscription.findOne({ where: { chatId: ctx.chat.id, seriesId: series.kp_id } });
        if (currentSub) return ctx.answerCbQuery('Вы уже подписаны!', { show_alert: true });

        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('🔔 Каждую серию', `sub_set_${filmId}_episode`),
                Markup.button.callback('📦 Весь сезон', `sub_set_${filmId}_season`),
            ],
            [Markup.button.callback('🆕 1-я серия + Сезон', `sub_set_${filmId}_first_and_full`)],
            [Markup.button.callback('⬅️ К результатам', 'back_to_results')],
        ]);

        await ctx.reply(`Выберите режим уведомлений для «${series.title}»:`, keyboard);
        await ctx.answerCbQuery();
    } catch (error) {
        console.error('[Bot] Subscription error:', error);
        await ctx.answerCbQuery('Ошибка подписки.');
    }
});

bot.action(/sub_set_(\d+)_(episode|season|first_and_full)/, async (ctx) => {
    const filmId = ctx.match[1];
    const notifyType = ctx.match[2];
    const chatId = ctx.chat.id;

    try {
        const series = await Series.findByPk(filmId);
        if (!series) return ctx.answerCbQuery('Сериал не найден.');

        const [subscription, created] = await Subscription.findOrCreate({
            where: { chatId, seriesId: filmId },
            defaults: { notify_type: notifyType },
        });
        if (!created) await subscription.update({ notify_type: notifyType });

        // Initialize the baseline episode tracking on first subscribe
        if (series.last_season === 0) {
            const seasons = await getSeasons(filmId);
            if (seasons && seasons.length > 0) {
                const validSeasons = seasons.filter(s => s.episodes && s.episodes.length > 0);
                if (validSeasons.length > 0) {
                    const lastS = validSeasons[validSeasons.length - 1];
                    const lastE = lastS.episodes[lastS.episodes.length - 1];
                    await series.update({
                        last_season: lastS.number,
                        last_episode: lastE.number,
                        last_episode_name: lastE.name || lastE.enName || '',
                    });
                }
            }
        }

        const typeLabel = NOTIFY_LABELS_SHORT[notifyType] || notifyType;

        // FIX: Delete all search result cards (posters + nav) to keep chat clean
        await clearLastMessages(ctx, chatId);
        setState(ctx, { results: [], lastMessageIds: [], state: 'idle' });

        await ctx.answerCbQuery('Успешно подписаны! ✅');
        await ctx.editMessageText(
            `✅ Вы успешно подписались на <b>«${series.title}»</b>\n\n🔔 Режим уведомлений: <b>${typeLabel}</b>`,
            { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🏠 В главное меню', 'cancel_search')]]) }
        );
    } catch (error) {
        console.error('[Bot] Finalize subscription error:', error);
        await ctx.answerCbQuery('Ошибка сохранения подписки.');
    }
});

// ============================================================
// Watchlist add / remove
// ============================================================

bot.action(/watchlist_add_(\d+)/, async (ctx) => {
    const filmId = ctx.match[1];
    try {
        const data = await getSeriesData(filmId);
        if (!data) return ctx.answerCbQuery('Данные не найдены.');

        const title = data.name || data.alternativeName || data.enName || 'Без названия';
        const posterUrl = data.poster ? (data.poster.url || data.poster.previewUrl) : null;
        const digitalDate = data.premiere?.digital || null;
        const year = data.year || null;

        const [, created] = await Watchlist.findOrCreate({
            where: { chatId: ctx.chat.id, kp_id: filmId, notified: false },
            defaults: { title, poster_url: posterUrl, year, premiere_digital: digitalDate }
        });

        if (!created) {
            return ctx.answerCbQuery('Уже в списке ожидания! 📌', { show_alert: false });
        }

        await clearLastMessages(ctx, ctx.chat.id);
        setState(ctx, { results: [], lastMessageIds: [], state: 'idle' });

        const dateLabel = digitalDate
            ? new Date(digitalDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
            : 'пока не объявлена';

        await ctx.answerCbQuery('Добавлено в список ожидания! 📌');
        await ctx.editMessageText(
            `📌 <b>«${title}»</b> добавлен в список ожидания!\n\n` +
            `📅 Цифровой релиз: <b>${dateLabel}</b>\n\n` +
            `<i>Как только фильм выйдет в цифру — пришлю ссылку для просмотра.</i>`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.callback('🏠 В главное меню', 'cancel_search')]])
            }
        );
    } catch (error) {
        console.error('[Bot] Watchlist add error:', error);
        await ctx.answerCbQuery('Ошибка при добавлении.');
    }
});

bot.action(/unwatchlist_(\d+)/, async (ctx) => {
    const watchlistId = ctx.match[1];
    try {
        await Watchlist.destroy({ where: { id: watchlistId, chatId: ctx.chat.id } });
        await ctx.answerCbQuery('Удалено из списка ожидания ❌');
        await ctx.deleteMessage();
    } catch (error) {
        console.error('[Bot] Watchlist remove error:', error);
        await ctx.answerCbQuery('Ошибка при удалении.');
    }
});

bot.action('back_to_results', async (ctx) => {
    await ctx.deleteMessage();
    const state = getState(ctx);
    await showSearchPage(ctx, ctx.chat.id, state.currentPage || 0);
    await ctx.answerCbQuery();
});

bot.action(/toggle_notify_(\d+)/, async (ctx) => {
    const filmId = ctx.match[1];
    const chatId = ctx.chat.id;
    try {
        const sub = await Subscription.findOne({ where: { chatId, seriesId: filmId } });
        if (!sub) return ctx.answerCbQuery('Подписка не найдена.');

        const newType = NOTIFY_CYCLE[sub.notify_type] || 'episode';
        await sub.update({ notify_type: newType });

        const typeLabel = NOTIFY_LABELS[newType] || newType;
        const series = await Series.findByPk(filmId);

        await ctx.editMessageText(
            `📺 ${series.title}\nРежим: ${typeLabel}`,
            Markup.inlineKeyboard([[
                Markup.button.callback('⚙️ Сменить режим', `toggle_notify_${filmId}`),
                Markup.button.callback('❌ Отписаться', `unsub_${filmId}`),
            ]])
        );
        await ctx.answerCbQuery('Режим подписки обновлен!');
    } catch (error) {
        console.error('[Bot] Toggle notify error:', error);
        await ctx.answerCbQuery('Ошибка при смене режима.');
    }
});

bot.action(/unsub_(\d+)/, async (ctx) => {
    const filmId = ctx.match[1];
    try {
        await Subscription.destroy({ where: { chatId: ctx.chat.id, seriesId: filmId } });
        await ctx.answerCbQuery('Удалено! ❌');
        await ctx.deleteMessage();
    } catch (error) {
        console.error('[Bot] Unsubscribe error:', error);
        await ctx.answerCbQuery('Ошибка при отписке.');
    }
});

module.exports = bot;
