/** Search: results with paging, a title's card, subscribing to a series, adding a film. */
const { Markup } = require('telegraf');
const { searchMulti, getDetails, nextEpisodeFields } = require('../api/tmdb');
const { findKinopoiskIdQuick } = require('../api/kinopoisk');
const { Series, Subscription, Watchlist } = require('../db');
const { NOTIFY_LABELS_SHORT, isFinishedStatus, escapeHtml, formatRuDate, formatDigitalDate } = require('../constants');
const { getState, setState } = require('./state');
const { mainMenu, watchButtonRows } = require('./keyboards');

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
        const year = (item.release_date || item.first_air_date || '').substring(0, 4) || 'н/д';
        const name = item.title || item.name || item.original_title || item.original_name || 'Без названия';

        const caption = `<b>${escapeHtml(name)}</b> (${year})`;
        const posterUrl = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✨ Подписаться', `sub_${item.media_type}_${item.id}`)]
        ]);

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
        try {
            await ctx.telegram.deleteMessage(chatId, msgId);
        } catch {
            /* already deleted */
        }
    }
};

function register(bot) {
    bot.action('cancel_search', async (ctx) => {
        await clearLastMessages(ctx, ctx.chat.id);
        setState(ctx, { state: 'idle', results: [] });
        await ctx.reply('Поиск завершен.', mainMenu(ctx));
        await ctx.answerCbQuery();
    });

    bot.on('text', async (ctx, next) => {
        const text = ctx.message.text;
        const BUTTON_TEXTS = [
            '🔍 Поиск',
            '📺 Мои подписки',
            '❌ Отмена',
            'ℹ️ Помощь',
            '❓ Помощь',
            '🎲 Случайный фильм'
        ];
        if (BUTTON_TEXTS.includes(text) || text.startsWith('/')) return next();

        const state = getState(ctx);
        if (state.state !== 'waiting_for_search') return;

        try {
            console.log(`[Bot] Search query: "${text}" from ${ctx.from.id}`);
            const results = await searchMulti(text);
            if (!results || results.length === 0) {
                setState(ctx, { state: 'idle' });
                return ctx.reply(
                    'Ничего не найдено 😕',
                    Markup.inlineKeyboard([[Markup.button.callback('🏠 В главное меню', 'cancel_search')]])
                );
            }
            setState(ctx, { results, state: 'searching' });
            await showSearchPage(ctx, ctx.chat.id, 0);
        } catch (error) {
            console.error('[Bot] Search error:', error);
            await ctx.reply('Ошибка при поиске. Попробуйте позже.', mainMenu(ctx));
            setState(ctx, { state: 'idle' });
        }
    });

    bot.action(/^page_(\d+)$/, async (ctx) => {
        const page = parseInt(ctx.match[1]);
        await clearLastMessages(ctx, ctx.chat.id);
        await showSearchPage(ctx, ctx.chat.id, page);
        await ctx.answerCbQuery();
    });

    bot.action(/^sub_(movie|tv)_(\d+)$/, async (ctx) => {
        const mediaType = ctx.match[1];
        const filmId = ctx.match[2];
        const tmdbId = `${mediaType}_${filmId}`;
        try {
            const data = await getDetails(filmId, mediaType);
            if (!data) return ctx.answerCbQuery('Данные не найдены.');

            if (mediaType === 'movie') {
                // ——— MOVIE: smart release detection ———
                await clearLastMessages(ctx, ctx.chat.id);
                setState(ctx, { lastMessageIds: [] });

                const title = data.title || data.original_title || 'Без названия';
                const movieYear = data.release_date ? data.release_date.substring(0, 4) : null;
                const status = data.status; // e.g. 'Released', 'Post Production'

                let isAlreadyReleased = false;
                let releaseDateLabel = null;

                if (data.release_date) {
                    const releaseDate = new Date(data.release_date);
                    if (!isNaN(releaseDate) && releaseDate <= new Date()) {
                        isAlreadyReleased = true;
                        releaseDateLabel = formatRuDate(releaseDate);
                    }
                }
                if (status === 'Released') isAlreadyReleased = true;

                if (isAlreadyReleased) {
                    // Film is already out
                    const kinopoiskId = await findKinopoiskIdQuick(tmdbId, data.imdb_id);
                    const keyboard = Markup.inlineKeyboard([
                        ...watchButtonRows({ title, kinopoiskId, mediaType: 'movie' }),
                        [Markup.button.callback('⬅️ К результатам', 'back_to_results')]
                    ]);
                    await ctx.reply(
                        `🎬 <b>${escapeHtml(title)}</b>${movieYear ? ` (${movieYear})` : ''}\n\n` +
                            `✅ Фильм уже вышел${releaseDateLabel ? ` — <b>${releaseDateLabel}</b>` : ''}.\n`,
                        { parse_mode: 'HTML', ...keyboard }
                    );
                    return ctx.answerCbQuery();
                }

                // Film is upcoming — offer to add to watchlist
                const comingDateLabel = formatDigitalDate(data.release_date);

                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.callback('📌 В список ожидания', `watchlist_add_${tmdbId}`)],
                    [Markup.button.callback('⬅️ К результатам', 'back_to_results')]
                ]);

                const directorLabel = data.director_name
                    ? `🎬 Режиссер: <b>${escapeHtml(data.director_name)}</b>\n`
                    : '';

                await ctx.reply(
                    `🎬 <b>${escapeHtml(title)}</b>${movieYear ? ` (${movieYear})` : ''}\n${directorLabel}\n` +
                        `Это фильм, который ещё не вышел.\n` +
                        `📅 Релиз: <b>${comingDateLabel}</b>\n\n` +
                        `Добавить в список ожидания? Как только выйдет — пришлю уведомление.`,
                    { parse_mode: 'HTML', ...keyboard }
                );
                return ctx.answerCbQuery();
            }

            // ——— TV SERIES: existing subscription flow ———
            const [series] = await Series.findOrCreate({
                where: { tmdb_id: tmdbId },
                defaults: {
                    title: data.name || data.original_name || 'Без названия',
                    last_season: 0,
                    last_episode: 0,
                    poster_url: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
                    status: data.status || null,
                    ...nextEpisodeFields(data)
                }
            });

            const currentSub = await Subscription.findOne({ where: { chatId: ctx.chat.id, seriesId: series.tmdb_id } });
            if (currentSub) return ctx.answerCbQuery('Вы уже подписаны!', { show_alert: true });

            const directorLabel = data.director_name ? `🎬 Создатель: <b>${escapeHtml(data.director_name)}</b>\n` : '';

            // A finished show won't air anything, so instead of a mode picker explain that and let
            // the user subscribe anyway — the subscription lands straight in the archive and only
            // matters if the show gets renewed.
            if (isFinishedStatus(data.status)) {
                const what = data.status === 'Canceled' ? 'отменён' : 'завершён';
                await ctx.reply(
                    `<b>«${escapeHtml(series.title)}»</b>\n${directorLabel}\n` +
                        `⚠️ Сериал ${what} — новых серий не будет.\n\n` +
                        'Если всё же подписаться, сериал попадёт в 📺 Мои подписки → 🗄 Завершённые, ' +
                        'и я сообщу, если его продлят.',
                    {
                        parse_mode: 'HTML',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('🔔 Всё равно подписаться', `sub_set_${tmdbId}_episode`)],
                            [Markup.button.callback('⬅️ К результатам', 'back_to_results')]
                        ])
                    }
                );
                return ctx.answerCbQuery();
            }

            const keyboard = Markup.inlineKeyboard([
                [
                    Markup.button.callback('🔔 Каждую серию', `sub_set_${tmdbId}_episode`),
                    Markup.button.callback('📦 Весь сезон', `sub_set_${tmdbId}_season`)
                ],
                [Markup.button.callback('🆕 1-я серия + Сезон', `sub_set_${tmdbId}_first_and_full`)],
                [Markup.button.callback('⬅️ К результатам', 'back_to_results')]
            ]);

            await ctx.reply(`<b>«${escapeHtml(series.title)}»</b>\n${directorLabel}\nВыберите режим уведомлений:`, {
                parse_mode: 'HTML',
                ...keyboard
            });
            await ctx.answerCbQuery();
        } catch (error) {
            console.error('[Bot] Subscription error:', error);
            await ctx.answerCbQuery('Ошибка подписки.');
        }
    });

    bot.action(/^sub_set_([a-z0-9_]+)_(episode|season|first_and_full)$/, async (ctx) => {
        const tmdbId = ctx.match[1];
        const notifyType = ctx.match[2];
        const chatId = ctx.chat.id;

        try {
            const series = await Series.findByPk(tmdbId);
            if (!series) return ctx.answerCbQuery('Сериал не найден.');

            const [subscription, created] = await Subscription.findOrCreate({
                where: { chatId, seriesId: tmdbId },
                defaults: { notify_type: notifyType }
            });
            if (!created) await subscription.update({ notify_type: notifyType });

            console.log(
                `[Bot] ${created ? 'New subscription' : 'Subscription updated'} for User ${chatId}: ${tmdbId} (Mode: ${notifyType})`
            );

            // Initialize the baseline episode tracking on first subscribe
            if (series.last_season === 0) {
                const [mediaType, filmId] = tmdbId.split('_');
                const data = await getDetails(filmId, mediaType);
                if (data && data.last_episode_to_air) {
                    await series.update({
                        last_season: data.last_episode_to_air.season_number,
                        last_episode: data.last_episode_to_air.episode_number,
                        last_episode_name: data.last_episode_to_air.name || ''
                    });
                }
            }

            const typeLabel = NOTIFY_LABELS_SHORT[notifyType] || notifyType;

            // Fetch seasons to find the next episode
            let nextEpisodeText = 'информации о ближайшей серии пока нет';
            let finished = isFinishedStatus(series.status);
            try {
                const [mediaType, filmId] = tmdbId.split('_');
                const data = await getDetails(filmId, mediaType);

                if (data) {
                    finished = isFinishedStatus(data.status);
                    if (finished) {
                        nextEpisodeText = 'Сериал завершён/закрыт';
                    } else if (data.next_episode_to_air) {
                        const nextEp = data.next_episode_to_air;
                        if (nextEp.air_date) {
                            const dateStr = formatRuDate(nextEp.air_date);
                            nextEpisodeText = `Ближайшая серия (${nextEp.season_number} сезон, ${nextEp.episode_number} серия) ожидается <b>${dateStr}</b>`;
                        }
                    }
                }
            } catch (e) {
                console.error('[Bot] Failed to get next episode info:', e);
            }

            // FIX: Delete all search result cards (posters + nav) to keep chat clean
            await clearLastMessages(ctx, chatId);
            setState(ctx, { results: [], lastMessageIds: [], state: 'idle' });

            await ctx.answerCbQuery('Успешно подписаны! ✅');
            const details = finished
                ? '🗄 Сериал завершён, поэтому подписка лежит в 📺 Мои подписки → 🗄 Завершённые. Если его продлят — сообщу.'
                : `🔔 Режим уведомлений: <b>${typeLabel}</b>\n\n📅 ${nextEpisodeText}`;
            await ctx.editMessageText(
                `✅ Вы успешно подписались на <b>«${escapeHtml(series.title)}»</b>\n\n${details}`,
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🏠 В главное меню', 'cancel_search')]])
                }
            );
        } catch (error) {
            console.error('[Bot] Finalize subscription error:', error);
            await ctx.answerCbQuery('Ошибка сохранения подписки.');
        }
    });

    // ============================================================
    // Watchlist add / remove
    // ============================================================

    bot.action(/^watchlist_add_([a-z0-9_]+)$/, async (ctx) => {
        const tmdbId = ctx.match[1];
        const [mediaType, filmId] = tmdbId.split('_');
        try {
            const data = await getDetails(filmId, mediaType);
            if (!data) return ctx.answerCbQuery('Данные не найдены.');

            const title = data.title || data.original_title || 'Без названия';
            const posterUrl = data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null;
            const digitalDate = data.release_date || null;
            const year = data.release_date ? parseInt(data.release_date.substring(0, 4)) : null;

            const [, created] = await Watchlist.findOrCreate({
                where: { chatId: ctx.chat.id, tmdb_id: tmdbId, notified: false },
                defaults: { title, poster_url: posterUrl, year, premiere_digital: digitalDate }
            });

            if (!created) {
                return ctx.answerCbQuery('Уже в списке ожидания! 📌', { show_alert: false });
            }

            await clearLastMessages(ctx, ctx.chat.id);
            setState(ctx, { results: [], lastMessageIds: [], state: 'idle' });

            const dateLabel = formatRuDate(digitalDate) || 'пока не объявлена';
            const digitalLine = data.digital_release_date
                ? `💻 Цифровой релиз: <b>${formatRuDate(data.digital_release_date)}</b>\n`
                : '';

            await ctx.answerCbQuery('Добавлено в список ожидания! 📌');
            await ctx.editMessageText(
                `📌 <b>«${escapeHtml(title)}»</b> добавлен в список ожидания!\n\n` +
                    `📅 Выход: <b>${dateLabel}</b>\n` +
                    digitalLine +
                    '\n' +
                    `<i>Как только фильм выйдет — пришлю ссылки для просмотра.</i>`,
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

    bot.action('back_to_results', async (ctx) => {
        await ctx.deleteMessage();
        const state = getState(ctx);
        await showSearchPage(ctx, ctx.chat.id, state.currentPage || 0);
        await ctx.answerCbQuery();
    });
}

module.exports = { register, clearLastMessages };
