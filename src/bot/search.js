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
const { recordOwner } = require('./access');

const mainMenuButton = Markup.inlineKeyboard([[Markup.button.callback('🏠 В главное меню', 'cancel_search')]]);

// One search is one message on screen, the list or a card, and its state lives with that message
// rather than with a user: in a chat whose buttons are open to everyone (see access.js) anyone may
// page it. Who may press at all is decided there; here only whether the search still exists.
const sessions = new Map(); // "chatId:messageId" -> { chatId, messageId, starter, results, query, page, busy, at }
const SESSION_TTL_MS = 30 * 60 * 1000;
const sessionKey = (chatId, messageId) => `${chatId}:${messageId}`;

setInterval(
    () => {
        const cutoff = Date.now() - SESSION_TTL_MS;
        for (const [key, session] of sessions) if (session.at < cutoff) sessions.delete(key);
    },
    10 * 60 * 1000
    // unref: the bot keeps the process alive anyway; a test using this module can exit
).unref();

/** The search whose message a button was pressed on, or undefined if it has lapsed. */
function sessionOf(ctx) {
    const message = ctx.callbackQuery && ctx.callbackQuery.message;
    const session = message && sessions.get(sessionKey(ctx.chat.id, message.message_id));
    if (session) session.at = Date.now();
    return session;
}

/** The search now lives on `message` (the list was edited, or replaced by a card or back). */
function moveSession(session, message) {
    sessions.delete(sessionKey(session.chatId, session.messageId));
    session.messageId = message.message_id;
    sessions.set(sessionKey(session.chatId, session.messageId), session);
    // A search stays its starter's, even when someone else (in a chat open to all) opened the
    // card it now shows: switch the chat to "owner" later, and the starter can still use it
    recordOwner(session.chatId, message.message_id, session.starter);
}

/** Removes this user's searches in this chat from the screen, e.g. before a new one or on /cancel. */
const clearLastMessages = async (ctx, chatId) => {
    const userId = ctx.from && ctx.from.id;
    for (const [key, session] of sessions) {
        if (session.chatId !== chatId || session.starter !== userId) continue;
        sessions.delete(key);
        await ctx.telegram.deleteMessage(chatId, session.messageId).catch(() => {});
    }
};

/**
 * Runs before every button of a search: the search must still exist (it lapses after 30 min, or
 * with a restart), and it takes one press at a time. A double tap would otherwise open two cards
 * or subscribe twice; a press while another is being handled is answered quietly and dropped.
 */
async function searchGuard(ctx, next) {
    const session = sessionOf(ctx);
    if (!session) {
        return ctx.answerCbQuery('Этот поиск устарел. Начните новый: 🔍 Поиск', { show_alert: true });
    }
    if (session.busy) return ctx.answerCbQuery();
    session.busy = true;
    ctx.state.search = session;
    try {
        await next();
    } finally {
        session.busy = false;
    }
}

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
async function showList(ctx, session, page) {
    const list = resultsList(session.results, page, session.query);
    const msg = await showText(ctx, list.text, list.keyboard);
    session.page = list.page;
    moveSession(session, msg);
    prefetch(session.results.slice(list.page * PER_PAGE, (list.page + 1) * PER_PAGE));
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
async function showCard(ctx, session, card) {
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
    moveSession(session, msg);
}

/** A series row for the update check, created on the first subscription. */
async function ensureSeries(tmdbId, data) {
    const [series] = await Series.findOrCreate({ where: { tmdb_id: tmdbId }, defaults: newSeriesFields(data) });
    return series;
}

/** The search is done (subscribed, added): its message is now a confirmation, not a search. */
function endSearch(ctx) {
    const session = ctx.state.search;
    if (session) sessions.delete(sessionKey(session.chatId, session.messageId));
    if (session && session.starter === ctx.from.id) setState(ctx, { state: 'idle' });
}

function register(bot) {
    bot.action('cancel_search', async (ctx) => {
        // ✖️ on a list or card ends that search (whoever started it); "main menu" under a
        // confirmation has none, and ends whatever this user still has open
        const session = sessionOf(ctx);
        if (session) {
            sessions.delete(sessionKey(session.chatId, session.messageId));
            await ctx.deleteMessage().catch(() => {});
        }
        await clearLastMessages(ctx, ctx.chat.id);
        setState(ctx, { state: 'idle' });
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
            '⚙️ Настройки',
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
            setState(ctx, { state: 'searching' });
            const session = {
                chatId: ctx.chat.id,
                starter: ctx.from.id,
                results,
                query: text,
                page: 0,
                at: Date.now()
            };
            await showList(ctx, session, 0);
        } catch (error) {
            console.error('[Bot] Search error:', error);
            await ctx.reply('Ошибка при поиске. Попробуйте позже.', mainMenu(ctx));
            setState(ctx, { state: 'idle' });
        }
    });

    bot.action(/^page_(\d+)$/, searchGuard, async (ctx) => {
        await ctx.answerCbQuery();
        await showList(ctx, ctx.state.search, parseInt(ctx.match[1], 10));
    });

    bot.action('back_to_results', searchGuard, async (ctx) => {
        await ctx.answerCbQuery();
        await showList(ctx, ctx.state.search, ctx.state.search.page);
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
                return showCard(ctx, ctx.state.search, filmCard(data, { kinopoiskId, onWatchlist }));
            }

            const sub = await Subscription.findOne({ where: { chatId: ctx.chat.id, seriesId: tmdbId } });
            return showCard(ctx, ctx.state.search, seriesCard(data, { subscribedMode: sub ? sub.notify_type : null }));
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
            endSearch(ctx);
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
            endSearch(ctx);
        } catch (error) {
            console.error('[Bot] Watchlist add error:', error);
            await ctx.answerCbQuery('Ошибка при добавлении.').catch(() => {});
        }
    });
}

module.exports = { register, clearLastMessages };
