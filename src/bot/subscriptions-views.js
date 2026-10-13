/**
 * The screens of "Мои подписки" (src/bot/subscriptions.js): text and buttons for each, built
 * from plain data. No Telegram, database or network.
 */
const { Markup } = require('telegraf');
const {
    NOTIFY_LABELS,
    FINISHED_STATUS_LABELS,
    isFinishedStatus,
    escapeHtml,
    formatDigitalDate
} = require('../constants');

const SUBS_PER_PAGE = 8;
const EMPTY_SUBS_TEXT = 'У вас пока нет подписок. Нажмите 🔍 <b>Поиск</b> или используйте /search!';

const truncate = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// Callback data carries a "loc" token so a card's "back" button returns to the list it was
// opened from: "3" is page 3 of the settings list, "a3" is page 3 of the archive.
const isArchiveLoc = (loc) => String(loc).startsWith('a');
const listCallback = (loc) => (isArchiveLoc(loc) ? `subs_a_${String(loc).slice(1)}` : `subs_p_${loc}`);

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
    rows.push([Markup.button.callback('🗓 Вышло по годам', 'hist_0')]);
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

/** "Unsubscribe from …?": yes removes it, no goes back to the card. */
const buildUnsubscribeConfirm = (series, tmdbId, loc) => {
    const consequence = isFinishedStatus(series?.status)
        ? 'Если сериал продлят, уведомление не придёт.'
        : 'Уведомления о новых сериях приходить перестанут.';
    return {
        text: `Отписаться от <b>${escapeHtml(series?.title || 'сериала')}</b>?\n\n${consequence}`,
        keyboard: Markup.inlineKeyboard([
            [
                Markup.button.callback('✅ Да, отписаться', `subs_us_${tmdbId}_${loc}`),
                Markup.button.callback('↩️ Нет', `subs_s_${tmdbId}_${loc}`)
            ]
        ])
    };
};

/** "Remove … from the watchlist?": yes removes it, no goes back to the card. */
const buildWatchlistRemoveConfirm = (item, watchlistId, loc) => ({
    text: `Удалить <b>${escapeHtml(item?.title || 'фильм')}</b> из списка ожидания?\n\nУведомление о цифровом релизе не придёт.`,
    keyboard: Markup.inlineKeyboard([
        [
            Markup.button.callback('✅ Да, удалить', `subs_um_${watchlistId}_${loc}`),
            Markup.button.callback('↩️ Нет', `subs_m_${watchlistId}_${loc}`)
        ]
    ])
});

module.exports = {
    EMPTY_SUBS_TEXT,
    SUBS_PER_PAGE,
    isArchiveLoc,
    buildOverview,
    buildSettingsView,
    buildArchiveView,
    buildSeriesCard,
    buildMovieCard,
    buildUnsubscribeConfirm,
    buildWatchlistRemoveConfirm
};
