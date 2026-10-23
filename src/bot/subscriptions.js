/**
 * "Мои подписки": one message, edited in place (the screens: subscriptions-views.js). Overview (text) -> "⚙️ Настроить подписки"
 * (one button per item) -> item card. Ended/canceled series live in a separate
 * "Завершённые" archive list.
 */
const { Chat, Series, Subscription, Watchlist } = require('../db');
const { NOTIFY_LABELS, isFinishedStatus } = require('../constants');
const { getState, setState } = require('./state');
const { mainMenu } = require('./keyboards');
const events = require('../chat-events');
const { log } = require('../log');
const {
    EMPTY_SUBS_TEXT,
    isArchiveLoc,
    buildOverview,
    buildSettingsView,
    buildArchiveView,
    buildSeriesCard,
    buildMovieCard,
    buildUnsubscribeConfirm,
    buildWatchlistRemoveConfirm
} = require('./subscriptions-views');

// Active list: running series first, then pending movies — one flat list so numbering and
// paging are shared. Archive: series that ended or were canceled.
const loadSubscriptionItems = async (chatId) => {
    const [chat, watchlistItems] = await Promise.all([
        Chat.findByPk(chatId, { include: [Series] }),
        Watchlist.findAll({ where: { chatId, notified: false }, order: [['id', 'ASC']] })
    ]);
    const series = (chat?.Series || [])
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title, 'ru'))
        .map((s) => ({
            kind: 'series',
            id: s.tmdb_id,
            title: s.title,
            status: s.status,
            notifyType: s.Subscription.notify_type
        }));
    const movies = watchlistItems.map((w) => ({
        kind: 'movie',
        id: w.id,
        title: w.title,
        year: w.year,
        date: w.premiere_digital
    }));
    return {
        active: [...series.filter((s) => !isFinishedStatus(s.status)), ...movies],
        archived: series.filter((s) => isFinishedStatus(s.status))
    };
};

const editView = async (ctx, { text, keyboard }) => {
    try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch (error) {
        // Re-rendering an unchanged view is harmless; anything else is a real failure.
        if (!String(error.description || error.message).includes('message is not modified')) throw error;
    }
};

// Re-render the list a card belongs to (settings page or archive page). A list that has
// become empty falls back to the overview.
const showSubsList = async (ctx, loc) => {
    const items = await loadSubscriptionItems(ctx.chat.id);
    const page = Number(String(loc).replace(/^a/, ''));
    if (isArchiveLoc(loc)) {
        await editView(ctx, items.archived.length ? buildArchiveView(items, page) : buildOverview(items));
    } else {
        await editView(ctx, items.active.length ? buildSettingsView(items, page) : buildOverview(items));
    }
};

// One query for both rows a series card needs
const findSubscriptionWithSeries = (chatId, tmdbId) =>
    Subscription.findOne({ where: { chatId, seriesId: tmdbId }, include: [Series] });

const showOverview = async (ctx) => editView(ctx, buildOverview(await loadSubscriptionItems(ctx.chat.id)));

const sendSubscriptionList = async (ctx) => {
    // /subs can arrive mid-search while the reply keyboard is the "❌ Отмена" one. The overview
    // carries an inline keyboard and a message can't hold both, so restore the main menu first.
    const wasBusy = ['waiting_for_search', 'searching'].includes(getState(ctx).state);
    setState(ctx, { state: 'idle' });
    try {
        if (wasBusy) await ctx.reply('Поиск отменён.', mainMenu(ctx));
        const items = await loadSubscriptionItems(ctx.chat.id);
        if (items.active.length === 0 && items.archived.length === 0) {
            return ctx.reply(EMPTY_SUBS_TEXT, { parse_mode: 'HTML', ...mainMenu(ctx) });
        }
        const { text, keyboard } = buildOverview(items);
        await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    } catch (error) {
        log.error({ err: error }, '[Bot] List subscriptions error');
        await ctx.reply('Ошибка получения списка подписок.');
    }
};

function register(bot) {
    // --- Single-message subscriptions view ---
    // "loc" groups below are the list a card came from: "3" = settings page 3, "a3" = archive page 3.

    bot.action('subs_noop', (ctx) => ctx.answerCbQuery());

    bot.action('subs_o', async (ctx) => {
        try {
            await showOverview(ctx);
            await ctx.answerCbQuery();
        } catch (error) {
            log.error({ err: error }, '[Bot] Subs overview error');
            await ctx.answerCbQuery('Ошибка загрузки списка.');
        }
    });

    bot.action(/^subs_(p|a)_(\d+)$/, async (ctx) => {
        const [, list, page] = ctx.match;
        try {
            await showSubsList(ctx, list === 'a' ? `a${page}` : page);
            await ctx.answerCbQuery();
        } catch (error) {
            log.error({ err: error }, '[Bot] Subs page error');
            await ctx.answerCbQuery('Ошибка загрузки списка.');
        }
    });

    const openSeriesCard = async (ctx, tmdbId, loc) => {
        try {
            const sub = await findSubscriptionWithSeries(ctx.chat.id, tmdbId);
            const series = sub && sub.Series;
            if (!series) {
                await showSubsList(ctx, loc);
                return ctx.answerCbQuery('Подписка уже удалена.');
            }
            await editView(ctx, buildSeriesCard(series, sub.notify_type, loc));
            await ctx.answerCbQuery();
        } catch (error) {
            log.error({ err: error }, '[Bot] Subs series card error');
            await ctx.answerCbQuery('Ошибка.');
        }
    };
    bot.action(/^subs_s_([a-z0-9_]+)_(a?\d+)$/, (ctx) => openSeriesCard(ctx, ctx.match[1], ctx.match[2]));

    bot.action(/^subs_m_(\d+)_(a?\d+)$/, async (ctx) => {
        const [, watchlistId, loc] = ctx.match;
        try {
            const item = await Watchlist.findOne({ where: { id: watchlistId, chatId: ctx.chat.id } });
            if (!item) {
                await showSubsList(ctx, loc);
                return ctx.answerCbQuery('Фильм уже удалён.');
            }
            await editView(ctx, buildMovieCard(item, loc));
            await ctx.answerCbQuery();
        } catch (error) {
            log.error({ err: error }, '[Bot] Subs movie card error');
            await ctx.answerCbQuery('Ошибка.');
        }
    });

    bot.action(/^subs_mode_([a-z0-9_]+)_(episode|season|first_and_full)_(a?\d+)$/, async (ctx) => {
        const [, tmdbId, newType, loc] = ctx.match;
        try {
            const sub = await findSubscriptionWithSeries(ctx.chat.id, tmdbId);
            const series = sub && sub.Series;
            if (!series) {
                await showSubsList(ctx, loc);
                return ctx.answerCbQuery('Подписка уже удалена.');
            }
            if (sub.notify_type !== newType) {
                await sub.update({ notify_type: newType });
                events.record(ctx.chat.id, {
                    kind: 'mode',
                    detail: newType,
                    tmdb_id: tmdbId,
                    title: series.title,
                    ...events.actor(ctx)
                });
            }
            await editView(ctx, buildSeriesCard(series, newType, loc));
            await ctx.answerCbQuery(`Режим: ${NOTIFY_LABELS[newType]}`);
        } catch (error) {
            log.error({ err: error }, '[Bot] Subs mode error');
            await ctx.answerCbQuery('Ошибка при смене режима.');
        }
    });

    // Confirmation step: same message, "yes" performs the removal, "no" returns to the card.
    const confirmUnsubscribe = async (ctx, tmdbId, loc) => {
        try {
            const series = await Series.findByPk(tmdbId);
            await editView(ctx, buildUnsubscribeConfirm(series, tmdbId, loc));
            await ctx.answerCbQuery();
        } catch (error) {
            log.error({ err: error }, '[Bot] Subs unsubscribe confirm error');
            await ctx.answerCbQuery('Ошибка.');
        }
    };
    bot.action(/^subs_cs_([a-z0-9_]+)_(a?\d+)$/, (ctx) => confirmUnsubscribe(ctx, ctx.match[1], ctx.match[2]));

    const confirmWatchlistRemove = async (ctx, watchlistId, loc) => {
        try {
            const item = await Watchlist.findOne({ where: { id: watchlistId, chatId: ctx.chat.id } });
            await editView(ctx, buildWatchlistRemoveConfirm(item, watchlistId, loc));
            await ctx.answerCbQuery();
        } catch (error) {
            log.error({ err: error }, '[Bot] Subs watchlist remove confirm error');
            await ctx.answerCbQuery('Ошибка.');
        }
    };
    bot.action(/^subs_cm_(\d+)_(a?\d+)$/, (ctx) => confirmWatchlistRemove(ctx, ctx.match[1], ctx.match[2]));

    // Buttons on messages sent by the old one-message-per-item list: route them into the new
    // views so that message turns into a card instead of acting immediately.
    bot.action(/^toggle_notify_([a-z0-9_]+)$/, (ctx) => openSeriesCard(ctx, ctx.match[1], '0'));
    bot.action(/^unsub_([a-z0-9_]+)$/, (ctx) => confirmUnsubscribe(ctx, ctx.match[1], '0'));
    bot.action(/^unwatchlist_(\d+)$/, (ctx) => confirmWatchlistRemove(ctx, ctx.match[1], '0'));

    bot.action(/^subs_us_([a-z0-9_]+)_(a?\d+)$/, async (ctx) => {
        const [, tmdbId, loc] = ctx.match;
        try {
            const removed = await Subscription.destroy({ where: { chatId: ctx.chat.id, seriesId: tmdbId } });
            if (removed) {
                const series = await Series.findByPk(tmdbId);
                events.record(ctx.chat.id, {
                    kind: 'unsubscribed',
                    tmdb_id: tmdbId,
                    title: series && series.title,
                    ...events.actor(ctx)
                });
            }
            await showSubsList(ctx, loc);
            await ctx.answerCbQuery('Вы отписались ❌');
        } catch (error) {
            log.error({ err: error }, '[Bot] Subs unsubscribe error');
            await ctx.answerCbQuery('Ошибка при отписке.');
        }
    });

    bot.action(/^subs_um_(\d+)_(a?\d+)$/, async (ctx) => {
        const [, watchlistId, loc] = ctx.match;
        try {
            const entry = await Watchlist.findOne({ where: { id: watchlistId, chatId: ctx.chat.id } });
            if (entry) {
                await entry.destroy();
                events.record(ctx.chat.id, {
                    kind: 'film_removed',
                    tmdb_id: entry.tmdb_id,
                    title: entry.title,
                    ...events.actor(ctx)
                });
            }
            await showSubsList(ctx, loc);
            await ctx.answerCbQuery('Удалено из списка ожидания ❌');
        } catch (error) {
            log.error({ err: error }, '[Bot] Subs watchlist remove error');
            await ctx.answerCbQuery('Ошибка при удалении.');
        }
    });
}

module.exports = { register, sendSubscriptionList };
