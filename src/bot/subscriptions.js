/**
 * "Мои подписки": one message, edited in place. Overview (text) -> "⚙️ Настроить подписки"
 * (one button per item) -> item card. Ended/canceled series live in a separate
 * "Завершённые" archive list.
 */
const { Markup } = require('telegraf');
const { Chat, Series, Subscription, Watchlist } = require('../db');
const {
    NOTIFY_LABELS,
    FINISHED_STATUS_LABELS,
    isFinishedStatus,
    escapeHtml,
    formatDigitalDate
} = require('../constants');
const { getState, setState } = require('./state');
const { mainMenu } = require('./keyboards');

const SUBS_PER_PAGE = 8;
const EMPTY_SUBS_TEXT = 'У вас пока нет подписок. Нажмите 🔍 <b>Поиск</b> или используйте /search!';

const truncate = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// Callback data carries a "loc" token so a card's "back" button returns to the list it was
// opened from: "3" is page 3 of the settings list, "a3" is page 3 of the archive.
const isArchiveLoc = (loc) => String(loc).startsWith('a');
const listCallback = (loc) => (isArchiveLoc(loc) ? `subs_a_${String(loc).slice(1)}` : `subs_p_${loc}`);

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

const paginate = (items, page) => {
    const pages = Math.max(Math.ceil(items.length / SUBS_PER_PAGE), 1);
    page = Math.min(Math.max(page, 0), pages - 1);
    const start = page * SUBS_PER_PAGE;
    return { page, pages, start, pageItems: items.slice(start, start + SUBS_PER_PAGE) };
};

const navRow = (prefix, page, pages) => [
    Markup.button.callback('◀️', `${prefix}${(page - 1 + pages) % pages}`),
    Markup.button.callback(`${page + 1}/${pages}`, 'subs_noop'),
    Markup.button.callback('▶️', `${prefix}${(page + 1) % pages}`)
];

// One title per row: the settings screen exists to pick an item, so full names matter more
// than compactness.
const itemRows = (pageItems, loc) =>
    pageItems.map((item) => {
        const icon = item.kind === 'movie' ? '🎬' : isFinishedStatus(item.status) ? '🏁' : '📺';
        const data = item.kind === 'series' ? `subs_s_${item.id}_${loc}` : `subs_m_${item.id}_${loc}`;
        return [Markup.button.callback(`${icon} ${truncate(item.title, 40)}`, data)];
    });

const OVERVIEW_MAX_LINES = 40;

const itemLine = (item) => {
    const title = escapeHtml(item.title);
    if (item.kind === 'series') return `• ${title} — ${NOTIFY_LABELS[item.notifyType] || item.notifyType}`;
    const year = item.year ? ` (${item.year})` : '';
    return `• ${title}${year} — 📅 ${formatDigitalDate(item.date)}`;
};

// Overview: read-only text summary. Changing anything goes through "⚙️ Настроить подписки",
// so the list itself stays clean instead of being a wall of buttons.
const buildOverview = ({ active, archived }) => {
    if (active.length === 0 && archived.length === 0) {
        return { text: EMPTY_SUBS_TEXT, keyboard: Markup.inlineKeyboard([]) };
    }
    const lines = [`📺 <b>Мои подписки</b> · ${active.length}`];
    if (active.length === 0) lines.push('', 'Активных подписок нет — все ваши сериалы завершены.');

    const shown = active.slice(0, OVERVIEW_MAX_LINES);
    let section = null;
    for (const item of shown) {
        if (item.kind !== section) {
            section = item.kind;
            lines.push('', section === 'series' ? '<b>Сериалы</b>' : '<b>Фильмы в ожидании</b>');
        }
        lines.push(itemLine(item));
    }
    if (active.length > shown.length) {
        lines.push('', `<i>…и ещё ${active.length - shown.length} — все есть в настройках.</i>`);
    }

    const rows = [];
    if (active.length > 0) rows.push([Markup.button.callback('⚙️ Настроить подписки', 'subs_p_0')]);
    if (archived.length > 0) rows.push([Markup.button.callback(`🗄 Завершённые (${archived.length})`, 'subs_a_0')]);
    return { text: lines.join('\n'), keyboard: Markup.inlineKeyboard(rows) };
};

const buildSettingsView = ({ active }, requestedPage) => {
    const { page, pages, pageItems } = paginate(active, requestedPage);
    const lines = [
        '⚙️ <b>Настройка подписок</b>',
        '',
        'Выберите сериал или фильм, чтобы изменить режим или отписаться:'
    ];
    if (pages > 1) lines.push('', `<i>Страница ${page + 1} из ${pages}</i>`);

    const rows = itemRows(pageItems, String(page));
    if (pages > 1) rows.push(navRow('subs_p_', page, pages));
    rows.push([Markup.button.callback('⬅️ К подпискам', 'subs_o')]);
    return { text: lines.join('\n'), keyboard: Markup.inlineKeyboard(rows) };
};

const buildArchiveView = ({ archived }, requestedPage) => {
    const { page, pages, pageItems } = paginate(archived, requestedPage);
    const lines = [
        `🗄 <b>Завершённые</b> · ${archived.length}`,
        '',
        'Новых серий у этих сериалов не будет. Если какой-то продлят — пришлю уведомление и верну его в активные.',
        ''
    ];
    for (const item of pageItems) {
        lines.push(`• ${escapeHtml(item.title)} — ${FINISHED_STATUS_LABELS[item.status]}`);
    }
    if (pages > 1) lines.push('', `<i>Страница ${page + 1} из ${pages}</i>`);

    const rows = itemRows(pageItems, `a${page}`);
    if (pages > 1) rows.push(navRow('subs_a_', page, pages));
    rows.push([Markup.button.callback('⬅️ К подпискам', 'subs_o')]);
    return { text: lines.join('\n'), keyboard: Markup.inlineKeyboard(rows) };
};

const buildSeriesCard = (series, notifyType, loc) => {
    const title = `📺 <b>${escapeHtml(series.title)}</b>`;
    if (isFinishedStatus(series.status)) {
        return {
            text:
                `${title}\n\n${FINISHED_STATUS_LABELS[series.status]} — новых серий не будет.\n\n` +
                'Подписка лежит в архиве: если сериал продлят, я пришлю уведомление и верну его в активные.',
            keyboard: Markup.inlineKeyboard([
                [
                    Markup.button.callback('❌ Удалить', `subs_cs_${series.tmdb_id}_${loc}`),
                    Markup.button.callback('⬅️ К списку', listCallback(loc))
                ]
            ])
        };
    }
    const modeRows = Object.keys(NOTIFY_LABELS).map((type) => [
        Markup.button.callback(
            `${type === notifyType ? '✅ ' : ''}${NOTIFY_LABELS[type]}`,
            `subs_mode_${series.tmdb_id}_${type}_${loc}`
        )
    ]);
    return {
        text: `${title}\n\nРежим уведомлений: ${NOTIFY_LABELS[notifyType] || notifyType}\n\nВыберите режим или отпишитесь:`,
        keyboard: Markup.inlineKeyboard([
            ...modeRows,
            [
                Markup.button.callback('❌ Отписаться', `subs_cs_${series.tmdb_id}_${loc}`),
                Markup.button.callback('⬅️ К списку', listCallback(loc))
            ]
        ])
    };
};

const buildMovieCard = (item, loc) => ({
    text: `🎬 <b>${escapeHtml(item.title)}</b>${item.year ? ` (${item.year})` : ''}\n\n📅 Выход: ${formatDigitalDate(item.premiere_digital)}\n\nПришлю уведомление, когда фильм выйдет.`,
    keyboard: Markup.inlineKeyboard([
        [
            Markup.button.callback('❌ Удалить', `subs_cm_${item.id}_${loc}`),
            Markup.button.callback('⬅️ К списку', listCallback(loc))
        ]
    ])
});

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
        console.error('[Bot] List subscriptions error:', error);
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
            console.error('[Bot] Subs overview error:', error);
            await ctx.answerCbQuery('Ошибка загрузки списка.');
        }
    });

    bot.action(/^subs_(p|a)_(\d+)$/, async (ctx) => {
        const [, list, page] = ctx.match;
        try {
            await showSubsList(ctx, list === 'a' ? `a${page}` : page);
            await ctx.answerCbQuery();
        } catch (error) {
            console.error('[Bot] Subs page error:', error);
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
            console.error('[Bot] Subs series card error:', error);
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
            console.error('[Bot] Subs movie card error:', error);
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
            if (sub.notify_type !== newType) await sub.update({ notify_type: newType });
            await editView(ctx, buildSeriesCard(series, newType, loc));
            await ctx.answerCbQuery(`Режим: ${NOTIFY_LABELS[newType]}`);
        } catch (error) {
            console.error('[Bot] Subs mode error:', error);
            await ctx.answerCbQuery('Ошибка при смене режима.');
        }
    });

    // Confirmation step: same message, "yes" performs the removal, "no" returns to the card.
    const confirmUnsubscribe = async (ctx, tmdbId, loc) => {
        try {
            const series = await Series.findByPk(tmdbId);
            const consequence = isFinishedStatus(series?.status)
                ? 'Если сериал продлят, уведомление не придёт.'
                : 'Уведомления о новых сериях приходить перестанут.';
            await editView(ctx, {
                text: `Отписаться от <b>${escapeHtml(series?.title || 'сериала')}</b>?\n\n${consequence}`,
                keyboard: Markup.inlineKeyboard([
                    [
                        Markup.button.callback('✅ Да, отписаться', `subs_us_${tmdbId}_${loc}`),
                        Markup.button.callback('↩️ Нет', `subs_s_${tmdbId}_${loc}`)
                    ]
                ])
            });
            await ctx.answerCbQuery();
        } catch (error) {
            console.error('[Bot] Subs unsubscribe confirm error:', error);
            await ctx.answerCbQuery('Ошибка.');
        }
    };
    bot.action(/^subs_cs_([a-z0-9_]+)_(a?\d+)$/, (ctx) => confirmUnsubscribe(ctx, ctx.match[1], ctx.match[2]));

    const confirmWatchlistRemove = async (ctx, watchlistId, loc) => {
        try {
            const item = await Watchlist.findOne({ where: { id: watchlistId, chatId: ctx.chat.id } });
            await editView(ctx, {
                text: `Удалить <b>${escapeHtml(item?.title || 'фильм')}</b> из списка ожидания?\n\nУведомление о цифровом релизе не придёт.`,
                keyboard: Markup.inlineKeyboard([
                    [
                        Markup.button.callback('✅ Да, удалить', `subs_um_${watchlistId}_${loc}`),
                        Markup.button.callback('↩️ Нет', `subs_m_${watchlistId}_${loc}`)
                    ]
                ])
            });
            await ctx.answerCbQuery();
        } catch (error) {
            console.error('[Bot] Subs watchlist remove confirm error:', error);
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
            await Subscription.destroy({ where: { chatId: ctx.chat.id, seriesId: tmdbId } });
            await showSubsList(ctx, loc);
            await ctx.answerCbQuery('Вы отписались ❌');
        } catch (error) {
            console.error('[Bot] Subs unsubscribe error:', error);
            await ctx.answerCbQuery('Ошибка при отписке.');
        }
    });

    bot.action(/^subs_um_(\d+)_(a?\d+)$/, async (ctx) => {
        const [, watchlistId, loc] = ctx.match;
        try {
            await Watchlist.destroy({ where: { id: watchlistId, chatId: ctx.chat.id } });
            await showSubsList(ctx, loc);
            await ctx.answerCbQuery('Удалено из списка ожидания ❌');
        } catch (error) {
            console.error('[Bot] Subs watchlist remove error:', error);
            await ctx.answerCbQuery('Ошибка при удалении.');
        }
    });
}

module.exports = { register, sendSubscriptionList };
