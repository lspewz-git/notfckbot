const { Telegraf, Markup } = require('telegraf');
const { searchMulti, getDetails, getRandomMovie } = require('./api/tmdb');
const { Chat, Series, Subscription, Watchlist } = require('./db');
const {
    NOTIFY_LABELS,
    NOTIFY_LABELS_SHORT,
    FINISHED_STATUS_LABELS,
    isFinishedStatus,
    escapeHtml,
    formatRuDate,
    getWatchLinks
} = require('./constants');
const { findKinopoiskIdQuick } = require('./api/kinopoisk');
const { getProxyAgent } = require('./proxy');
require('dotenv').config();

// Route Bot API traffic through the proxy too, not just TMDB. The agent is
// swapped at runtime by the admin panel via applyProxyToBot().
const bot = new Telegraf(process.env.BOT_TOKEN, {
    telegram: { agent: getProxyAgent() }
});

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
setInterval(
    () => {
        const now = Date.now();
        for (const key of Object.keys(userStates)) {
            const last = userStates[key]._lastActivity || 0;
            if (now - last > STATE_TTL_MS) {
                delete userStates[key];
            }
        }
    },
    10 * 60 * 1000
); // Run cleanup every 10 minutes

// Anti-Spam: throttle to 1 request/second per user
// And track identical rapid commands for auto-blocking
const lastMessageTimes = {};
// Store shape: { text: lastCommandStr, count: duplicateCount, lastTime: timestamp }
const commandTracking = {};

setInterval(() => {
    // FIX: Memory leak — purge old anti-spam entries (older than 1 minute)
    const cutoff = Date.now() - 60_000;
    for (const userId of Object.keys(lastMessageTimes)) {
        if (lastMessageTimes[userId] < cutoff) {
            delete lastMessageTimes[userId];
        }
        if (commandTracking[userId] && commandTracking[userId].lastTime < cutoff) {
            delete commandTracking[userId];
        }
    }
}, 60_000);

bot.use(async (ctx, next) => {
    // Determine userId whether it's a message, callback query, inline query, etc.
    const userId = ctx.from ? ctx.from.id : null;
    if (!userId) return next();

    // Button taps get a shorter window than messages: two quick taps are normal UI use,
    // and a dropped tap is answered with a hint instead of silence.
    const now = Date.now();
    const minGap = ctx.callbackQuery ? 400 : 1000;
    if (now - (lastMessageTimes[userId] || 0) < minGap) {
        console.log(`[Anti-Spam] Global Throttle: Ignoring rapid event from User ${userId}`);
        if (ctx.callbackQuery) {
            try {
                await ctx.answerCbQuery('⏳ Секунду…');
            } catch (e) {}
        }
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
        ['🎲 Случайный фильм', 'ℹ️ Помощь']
    ]).resize();
};

const cancelMenu = Markup.keyboard([['❌ Отмена']]).resize();

/** One URL button per watch/info link: HDRezka, SSPoisk (when the Kinopoisk ID is known), Kinopoisk. */
const watchButtonRows = (opts) =>
    getWatchLinks(opts).map((l) => [Markup.button.url(`${l.kind === 'watch' ? '▶️' : '🎬'} ${l.label}`, l.url)]);

const getCancelMenu = (ctx) => {
    if (ctx.state && ctx.state.chatData && ctx.state.chatData.menu_enabled === false) {
        return Markup.removeKeyboard();
    }
    return cancelMenu;
};

// ============================================================
// Chat and Global Spam Middleware
// ============================================================

bot.use(async (ctx, next) => {
    if (ctx.from) {
        // Track the specific user explicitly, whether they are in a group or private
        const userId = ctx.from.id;
        const username = ctx.from.username
            ? `@${ctx.from.username}`
            : `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();

        const [userData] = await Chat.findOrCreate({
            where: { id: userId },
            defaults: { type: 'private', username }
        });

        // Always update username if it changed
        if (userData.username !== username) {
            await userData.update({ username });
        }

        const now = Date.now();
        // Check if user is blocked
        if (userData.blockedUntil && userData.blockedUntil.getTime() > now) {
            // Text messages are dropped silently (the block notice was already sent), but a
            // button tap gets a popup so the user knows why nothing happens. Popups don't
            // add messages to the chat, so this can't be abused for spam.
            if (ctx.callbackQuery) {
                const minutesLeft = Math.ceil((userData.blockedUntil.getTime() - now) / 60000);
                try {
                    await ctx.answerCbQuery(
                        `🚫 Бот временно не отвечает из-за слишком частых действий. Осталось ~${minutesLeft} мин.`,
                        { show_alert: true }
                    );
                } catch {
                    /* query expired */
                }
            }
            return;
        }

        ctx.state = ctx.state || {};
        ctx.state.userData = userData; // Store the personal user record

        // Also ensure the actual group chat exists purely for settings like menu_enabled
        if (ctx.chat && ctx.chat.id !== userId) {
            // Groups/channels have a title; public ones also have a @username
            const chatTitle = ctx.chat.title || (ctx.chat.username ? `@${ctx.chat.username}` : null);

            const [chatData] = await Chat.findOrCreate({
                where: { id: ctx.chat.id },
                defaults: { type: ctx.chat.type, username: chatTitle }
            });

            // Groups get renamed — keep the stored title fresh
            if (chatTitle && chatData.username !== chatTitle) {
                await chatData.update({ username: chatTitle });
            }

            ctx.state.chatData = chatData;
        } else {
            ctx.state.chatData = userData; // In private chats, user == chat
        }

        // --- SPAM PROTECTION LOGIC ---
        // Only repeated text messages can trigger the auto-block. Button taps are already rate
        // limited by the throttle above, and repeating one is normal UI use (re-opening a card,
        // paging back and forth), not spam.
        const spamText = ctx.message && ctx.message.text ? ctx.message.text : null;
        const spamMsgId = spamText ? ctx.message.message_id : null;

        if (spamText) {
            const trk = commandTracking[userId] || { text: '', count: 0, lastTime: 0, msgIds: [] };

            // If they sent the EXACT same text/button within 5 seconds...
            if (trk.text === spamText && now - trk.lastTime < 5000) {
                trk.count += 1;
                if (spamMsgId && !trk.msgIds.includes(spamMsgId)) trk.msgIds.push(spamMsgId);
            } else {
                trk.text = spamText;
                trk.count = 1;
                trk.msgIds = spamMsgId ? [spamMsgId] : [];
            }
            trk.lastTime = now;
            commandTracking[userId] = trk;

            if (trk.count >= 3) {
                // Auto-block for 5 minutes
                const blockUntil = new Date(now + 5 * 60 * 1000);
                await userData.update({ blockedUntil: blockUntil });
                console.log(`[Anti-Spam] Auto-blocked user ${userId} for spamming: "${spamText}"`);

                // 🧹 Clean up the spammed messages from the chat
                const chatToClean = ctx.chat ? ctx.chat.id : null;
                if (chatToClean && trk.msgIds.length > 0) {
                    for (const mId of trk.msgIds) {
                        try {
                            await ctx.telegram.deleteMessage(chatToClean, mId);
                        } catch (err) {
                            // Message might already be deleted or bot lacks rights
                        }
                    }
                }

                delete commandTracking[userId];
                delete userStates[getStateKey(ctx)];

                // A duration rather than a clock time: users are in different time zones.
                const notice =
                    '🚫 Слишком много одинаковых сообщений подряд, поэтому бот не будет отвечать 5 минут.\n\n' +
                    'Это защита от спама. После паузы всё снова заработает.';
                try {
                    await ctx.reply(notice);
                } catch (e) {
                    console.error('[Anti-Spam] Failed to send block notice:', e.message);
                }

                return; // Stop execution
            }
        }
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

// ============================================================
// Subscriptions view: one message, edited in place.
// Overview (text) -> "⚙️ Настроить подписки" (one button per item) -> item card.
// Ended/canceled series live in a separate "Завершённые" archive list.
// ============================================================

const SUBS_PER_PAGE = 8;
const EMPTY_SUBS_TEXT = 'У вас пока нет подписок. Нажмите 🔍 <b>Поиск</b> или используйте /search!';

const truncate = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const formatDigitalDate = (date) => formatRuDate(date) || 'дата не объявлена';

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

// ============================================================
// Commands
// ============================================================

bot.command('start', async (ctx) => {
    delete userStates[getStateKey(ctx)];
    setState(ctx, { state: 'idle', results: [], currentPage: 0, lastMessageIds: [] });
    console.log(`[Bot] /start from ${ctx.from.id} (${ctx.from.username || 'N/A'})`);
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
        const directorLine = fullDetails.director_name ? `🎬 Режиссер: ${escapeHtml(fullDetails.director_name)}\n` : '';

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
    const BUTTON_TEXTS = ['🔍 Поиск', '📺 Мои подписки', '❌ Отмена', 'ℹ️ Помощь', '❓ Помощь', '🎲 Случайный фильм'];
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

            const directorLabel = data.director_name ? `🎬 Режиссер: <b>${escapeHtml(data.director_name)}</b>\n` : '';

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
                status: data.status || null
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
        await ctx.editMessageText(`✅ Вы успешно подписались на <b>«${escapeHtml(series.title)}»</b>\n\n${details}`, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('🏠 В главное меню', 'cancel_search')]])
        });
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

// ============================================================
// Setup Bot Commands Menu (Slash commands highlighting)
// ============================================================
bot.telegram
    .setMyCommands([
        { command: 'start', description: 'Перезапустить бота' },
        { command: 'search', description: 'Найти фильм или сериал' },
        { command: 'subs', description: 'Мои подписки и список ожидания' },
        { command: 'random', description: 'Случайный фильм на вечер' },
        { command: 'help', description: 'Как пользоваться ботом' },
        { command: 'cancel', description: 'Отменить текущее действие' },
        { command: 'menu_on', description: 'Включить нижнее меню' },
        { command: 'menu_off', description: 'ОТКЛЮЧИТЬ нижнее меню' }
    ])
    .catch((err) => console.error('[Bot] Failed to set commands:', err));

module.exports = bot;
