/**
 * Search: one message that is the results list or a title's card, subscribing to a series and
 * adding a film. The views themselves are in search-views.js.
 */
const { Markup } = require('telegraf');
const { searchMulti, getDetails, getDetailsCached, newSeriesFields } = require('../api/tmdb');
const { findKinopoiskId, findKinopoiskIdQuick } = require('../api/kinopoisk');
const { isMovieReleased } = require('../cron/films');
const { Series, Subscription, Watchlist } = require('../db');
const { NOTIFY_LABELS_SHORT, isFinishedStatus, escapeHtml, formatRuDate } = require('../constants');
const { getState, setState } = require('./state');
const { mainMenu } = require('./keyboards');
const { resultsList, seriesCard, filmCard, PER_PAGE } = require('./search-views');

const mainMenuButton = Markup.inlineKeyboard([[Markup.button.callback('🏠 В главное меню', 'cancel_search')]]);

/** Deletes the search's message(s) still on screen; ids are kept in the state. */
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

/**
 * Whether the pressed message is this user's search. The state is per user, so in a group a
 * press on someone else's search (or on one this user's state no longer knows, after a restart)
 * would page or replace a list it doesn't own: answer with a note and leave it alone.
 */
async function ownSearch(ctx) {
    const id = ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.message_id;
    if ((getState(ctx).lastMessageIds || []).includes(id)) return true;
    await ctx.answerCbQuery('Этот поиск устарел или его начал другой участник. Начните свой: 🔍 Поиск', {
        show_alert: true
    });
    return false;
}

/**
 * Runs before every button of a search: the press must be on this user's search (see ownSearch),
 * and only one at a time. A double tap would otherwise open two cards or subscribe twice; a press
 * while another is being handled is answered quietly and dropped.
 */
async function searchGuard(ctx, next) {
    if (!(await ownSearch(ctx))) return;
    if (getState(ctx).busy) return ctx.answerCbQuery();
    setState(ctx, { busy: true });
    try {
        await next();
    } finally {
        setState(ctx, { busy: false });
    }
}

/** The message a button was pressed on is the search's message from now on. */
const remember = (ctx, message) => setState(ctx, { lastMessageIds: [message.message_id] });

/**
 * Puts text in place of the message whose button was pressed. A text message is edited in place;
 * a photo (a card) can't become text, so it is replaced. Returns the message now on screen.
 */
async function showText(ctx, text, keyboard) {
    const current = ctx.callbackQuery && ctx.callbackQuery.message;
    if (current && !current.photo) {
        try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
            return current;
        } catch (err) {
            // "message is not modified": the same page pressed again
            if (/not modified/.test(err.message)) return current;
            throw err;
        }
    }
    if (current) await ctx.deleteMessage().catch(() => {});
    return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
}

/** The results list for `page`, in place of the pressed message (or as a new one). */
async function showList(ctx, page) {
    const { results = [], query = '' } = getState(ctx);
    if (!results.length) {
        // The state lapsed (30 min idle, or the bot restarted): nothing to go back to
        const msg = await showText(ctx, 'Результаты поиска устарели. Начните поиск заново: 🔍 Поиск.', mainMenuButton);
        remember(ctx, msg);
        return;
    }
    const list = resultsList(results, page, query);
    const msg = await showText(ctx, list.text, list.keyboard);
    setState(ctx, { currentPage: list.page, lastMessageIds: [msg.message_id] });
    prefetch(results.slice(list.page * PER_PAGE, (list.page + 1) * PER_PAGE));
}

/**
 * While the list is being read, fetches what the page's cards will need, so a tap opens one at
 * once: TMDB details (into its cache) and, for a film that is out, the Kinopoisk ID (into the
 * lookup's cache). Fire and forget; a failure only means that card asks again when opened.
 */
function prefetch(items) {
    for (const item of items) {
        getDetailsCached(item.id, item.media_type)
            .then((data) => {
                if (item.media_type === 'movie' && isMovieReleased(data)) {
                    return findKinopoiskId(`movie_${item.id}`, data.imdb_id);
                }
                return null;
            })
            .catch(() => {});
    }
}

// Telegram's own id for each poster it has already fetched: sending that again skips the
// download from TMDB, the slowest part of opening a card. Bounded, oldest out first.
const posterFileIds = new Map();
const POSTER_IDS_MAX = 500;

function rememberPoster(url, message) {
    const sizes = message && message.photo;
    if (!sizes || !sizes.length) return;
    if (posterFileIds.size >= POSTER_IDS_MAX) posterFileIds.delete(posterFileIds.keys().next().value);
    posterFileIds.set(url, sizes[sizes.length - 1].file_id);
}

/** A card (with its poster when there is one) in place of the list. */
async function showCard(ctx, card) {
    let msg = null;
    if (card.posterUrl) {
        const extra = { caption: card.caption, parse_mode: 'HTML', ...card.keyboard };
        const known = posterFileIds.get(card.posterUrl);
        try {
            msg = await ctx.replyWithPhoto(known || card.posterUrl, extra);
        } catch {
            // A stale file id: once more by URL. A poster Telegram can't fetch at all: as text below.
            if (known) msg = await ctx.replyWithPhoto(card.posterUrl, extra).catch(() => null);
        }
        rememberPoster(card.posterUrl, msg);
    }
    if (!msg) msg = await ctx.replyWithHTML(card.caption, card.keyboard);
    // The list goes once the card is there, so the chat is never empty in between
    ctx.deleteMessage().catch(() => {});
    remember(ctx, msg);
}

/** A series row for the update check, created on the first subscription. */
async function ensureSeries(tmdbId, data) {
    const [series] = await Series.findOrCreate({ where: { tmdb_id: tmdbId }, defaults: newSeriesFields(data) });
    return series;
}

function register(bot) {
    bot.action('cancel_search', async (ctx) => {
        await clearLastMessages(ctx, ctx.chat.id);
        setState(ctx, { state: 'idle', results: [], lastMessageIds: [] });
        await ctx.reply('Поиск завершен.', mainMenu(ctx));
        await ctx.answerCbQuery();
    });

    // The "2 / 3" button between the arrows only shows where you are
    bot.action('noop', (ctx) => ctx.answerCbQuery());

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
            // "typing…" in the chat header while TMDB searches (up to a second)
            ctx.sendChatAction('typing').catch(() => {});
            const results = await searchMulti(text);
            if (!results || results.length === 0) {
                setState(ctx, { state: 'idle' });
                return ctx.reply(
                    'Ничего не найдено 😕',
                    Markup.inlineKeyboard([[Markup.button.callback('🏠 В главное меню', 'cancel_search')]])
                );
            }
            // A previous search's message goes: the chat keeps one search at a time
            await clearLastMessages(ctx, ctx.chat.id);
            setState(ctx, { results, query: text, state: 'searching', lastMessageIds: [] });
            await showList(ctx, 0);
        } catch (error) {
            console.error('[Bot] Search error:', error);
            await ctx.reply('Ошибка при поиске. Попробуйте позже.', mainMenu(ctx));
            setState(ctx, { state: 'idle' });
        }
    });

    bot.action(/^page_(\d+)$/, searchGuard, async (ctx) => {
        await ctx.answerCbQuery();
        await showList(ctx, parseInt(ctx.match[1], 10));
    });

    bot.action('back_to_results', searchGuard, async (ctx) => {
        await ctx.answerCbQuery();
        await showList(ctx, getState(ctx).currentPage || 0);
    });

    // A result's card. "sub_" is what the buttons were called before the list, on older messages.
    bot.action(/^(?:card|sub)_(movie|tv)_(\d+)$/, searchGuard, async (ctx) => {
        const mediaType = ctx.match[1];
        const id = ctx.match[2];
        const tmdbId = `${mediaType}_${id}`;
        try {
            // Usually prefetched while the list was on screen (see prefetch), so no wait here
            const data = await getDetailsCached(id, mediaType);
            if (!data) return ctx.answerCbQuery('Данные не найдены.');
            await ctx.answerCbQuery();

            if (mediaType === 'movie') {
                const [onWatchlist, kinopoiskId] = await Promise.all([
                    Watchlist.findOne({ where: { chatId: ctx.chat.id, tmdb_id: tmdbId, notified: false } }).then(
                        Boolean
                    ),
                    // Only a film that is out shows watch links, the only thing that needs the ID
                    isMovieReleased(data) ? findKinopoiskIdQuick(tmdbId, data.imdb_id) : null
                ]);
                return showCard(ctx, filmCard(data, { kinopoiskId, onWatchlist }));
            }

            const sub = await Subscription.findOne({ where: { chatId: ctx.chat.id, seriesId: tmdbId } });
            return showCard(ctx, seriesCard(data, { subscribedMode: sub ? sub.notify_type : null }));
        } catch (error) {
            console.error('[Bot] Card error:', error);
            await ctx.answerCbQuery('Не удалось открыть карточку.').catch(() => {});
        }
    });

    bot.action(/^sub_set_([a-z0-9_]+)_(episode|season|first_and_full)$/, searchGuard, async (ctx) => {
        const tmdbId = ctx.match[1];
        const notifyType = ctx.match[2];
        const chatId = ctx.chat.id;

        try {
            const [mediaType, filmId] = tmdbId.split('_');
            const data = await getDetails(filmId, mediaType);
            if (!data) return ctx.answerCbQuery('Сериал не найден.');
            // Saved now, not when the card was opened: a card looked at and left adds nothing
            const series = await ensureSeries(tmdbId, data);

            const [subscription, created] = await Subscription.findOrCreate({
                where: { chatId, seriesId: tmdbId },
                defaults: { notify_type: notifyType }
            });
            if (!created) await subscription.update({ notify_type: notifyType });

            console.log(
                `[Bot] ${created ? 'New subscription' : 'Subscription updated'} for User ${chatId}: ${tmdbId} (Mode: ${notifyType})`
            );

            // No catch-up here for a series already tracked: its position belongs to the update
            // check, and moving it forward for a newcomer would skip an episode its other
            // subscribers are still to be told about

            const typeLabel = NOTIFY_LABELS_SHORT[notifyType] || notifyType;
            const finished = isFinishedStatus(data.status);
            let nextEpisodeText = 'информации о ближайшей серии пока нет';
            const nextEp = data.next_episode_to_air;
            if (nextEp && nextEp.air_date) {
                nextEpisodeText = `Ближайшая серия (${nextEp.season_number} сезон, ${nextEp.episode_number} серия) ожидается <b>${formatRuDate(nextEp.air_date)}</b>`;
            }

            await ctx.answerCbQuery(created ? 'Успешно подписаны! ✅' : 'Режим обновлён ✅');
            const details = finished
                ? '🗄 Сериал завершён, поэтому подписка лежит в 📺 Мои подписки → 🗄 Завершённые. Если его продлят — сообщу.'
                : `🔔 Режим уведомлений: <b>${typeLabel}</b>\n\n📅 ${nextEpisodeText}`;
            const heading = created
                ? `✅ Вы успешно подписались на <b>«${escapeHtml(series.title)}»</b>`
                : `✅ Режим уведомлений для <b>«${escapeHtml(series.title)}»</b> обновлён`;
            await showText(ctx, `${heading}\n\n${details}`, mainMenuButton);
            setState(ctx, { results: [], lastMessageIds: [], state: 'idle' });
        } catch (error) {
            console.error('[Bot] Finalize subscription error:', error);
            await ctx.answerCbQuery('Ошибка сохранения подписки.').catch(() => {});
        }
    });

    // ============================================================
    // Watchlist add
    // ============================================================

    bot.action(/^watchlist_add_([a-z0-9_]+)$/, searchGuard, async (ctx) => {
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

            const dateLabel = formatRuDate(digitalDate) || 'пока не объявлена';
            const digitalLine = data.digital_release_date
                ? `💻 Цифровой релиз: <b>${formatRuDate(data.digital_release_date)}</b>\n`
                : '';

            await ctx.answerCbQuery('Добавлено в список ожидания! 📌');
            await showText(
                ctx,
                `📌 <b>«${escapeHtml(title)}»</b> добавлен в список ожидания!\n\n` +
                    `📅 Выход: <b>${dateLabel}</b>\n` +
                    digitalLine +
                    '\n' +
                    `<i>Как только фильм выйдет — пришлю ссылки для просмотра.</i>`,
                mainMenuButton
            );
            setState(ctx, { results: [], lastMessageIds: [], state: 'idle' });
        } catch (error) {
            console.error('[Bot] Watchlist add error:', error);
            await ctx.answerCbQuery('Ошибка при добавлении.').catch(() => {});
        }
    });
}

module.exports = { register, clearLastMessages };
