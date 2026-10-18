/**
 * What the search shows, as data: the results list and a title's card. Pure — no Telegram
 * calls — so search.js decides how to put them on screen and tests can check them directly.
 */
const { Markup } = require('telegraf');
const { NOTIFY_LABELS_SHORT, isFinishedStatus, escapeHtml, formatRuDate, extraFilmDates } = require('../constants');
const { watchButtonRows } = require('./keyboards');
// The release check's own rule, so the card never says "out" before the notification does
const { isMovieReleased } = require('../cron/films');

// Results per page: enough to spot the right one at a glance, few enough to fit a phone screen
const PER_PAGE = 5;
// Telegram shortens long button labels anyway; this keeps the year visible at the end
const MAX_LABEL_NAME = 40;
// A photo caption may not exceed 1024 characters; the overview gets what the rest leaves
const MAX_OVERVIEW = 350;

const KIND_EMOJI = { movie: '🎬', tv: '📺' };

const yearOf = (item) => (item.release_date || item.first_air_date || '').slice(0, 4) || null;
const nameOf = (item) => item.title || item.name || item.original_title || item.original_name || 'Без названия';
const shorten = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const posterOf = (path) => (path ? `https://image.tmdb.org/t/p/w500${path}` : null);

const backRow = [Markup.button.callback('⬅️ К результатам', 'back_to_results')];

/**
 * The results list: one button per result (🎬 film / 📺 series, name, year), then ⬅️ page ➡️ ✖️.
 * @param {object[]} results TMDB search results (films and series)
 * @param {number} page 0-based
 * @param {string} query what was searched, shown in the heading
 */
function resultsList(results, page, query) {
    const pages = Math.max(1, Math.ceil(results.length / PER_PAGE));
    const current = Math.min(Math.max(page, 0), pages - 1);
    const items = results.slice(current * PER_PAGE, (current + 1) * PER_PAGE);

    const rows = items.map((item) => {
        const year = yearOf(item);
        const label = `${KIND_EMOJI[item.media_type] || ''} ${shorten(nameOf(item), MAX_LABEL_NAME)}${year ? ` (${year})` : ''}`;
        return [Markup.button.callback(label.trim(), `card_${item.media_type}_${item.id}`)];
    });

    const nav = [];
    if (current > 0) nav.push(Markup.button.callback('⬅️', `page_${current - 1}`));
    if (pages > 1) nav.push(Markup.button.callback(`${current + 1} / ${pages}`, 'noop'));
    if (current < pages - 1) nav.push(Markup.button.callback('➡️', `page_${current + 1}`));
    nav.push(Markup.button.callback('✖️', 'cancel_search'));
    rows.push(nav);

    const count = results.length;
    const found = `${count} ${plural(count, 'вариант', 'варианта', 'вариантов')}`;
    return {
        page: current,
        text: `🔍 «${escapeHtml(query)}» — ${found}. Выберите:`,
        keyboard: Markup.inlineKeyboard(rows)
    };
}

/** 1 вариант, 2 варианта, 5 вариантов */
function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

/** The heading every card starts with: bold name and year, then a muted kind line. */
function cardHead(name, year, kindLine) {
    return `<b>${escapeHtml(name)}</b>${year ? ` (${year})` : ''}\n<i>${escapeHtml(kindLine)}</i>\n`;
}

const overviewBlock = (overview) => (overview ? `\n${escapeHtml(shorten(overview.trim(), MAX_OVERVIEW))}\n` : '');

/**
 * A series' card: seasons and status, the next episode, the overview, then the notification
 * modes (or, for a finished show, a warning and "subscribe anyway").
 * @param {object} data TMDB series details
 * @param {{ subscribedMode?: string | null }} [chat] what this chat already has
 */
function seriesCard(data, { subscribedMode = null } = {}) {
    const name = data.name || data.original_name || 'Без названия';
    const seasons = data.number_of_seasons || 0;
    const finished = isFinishedStatus(data.status);
    const state = data.status === 'Canceled' ? 'отменён' : finished ? 'завершён' : 'идёт';
    const kindLine = `Сериал · ${seasons} ${plural(seasons, 'сезон', 'сезона', 'сезонов')} · ${state}`;

    const next = data.next_episode_to_air;
    const nextLine =
        !finished && next
            ? `📅 Следующая серия: ${next.season_number}×${next.episode_number}, ` +
              `<b>${formatRuDate(next.air_date) || 'дата не объявлена'}</b>\n`
            : '';

    const tmdbId = `tv_${data.id}`;
    let footer;
    let rows;
    if (finished && !subscribedMode) {
        footer =
            `\n⚠️ Сериал ${state} — новых серий не будет. Если всё же подписаться, он попадёт в ` +
            '📺 Мои подписки → 🗄 Завершённые, и я сообщу, если его продлят.';
        rows = [[Markup.button.callback('🔔 Всё равно подписаться', `sub_set_${tmdbId}_episode`)]];
    } else {
        footer = subscribedMode
            ? `\n✅ Вы уже подписаны: ${NOTIFY_LABELS_SHORT[subscribedMode] || subscribedMode}. Сменить режим:`
            : '\nКак уведомлять?';
        rows = [
            [
                Markup.button.callback('🔔 Каждую серию', `sub_set_${tmdbId}_episode`),
                Markup.button.callback('📦 Весь сезон', `sub_set_${tmdbId}_season`)
            ],
            [Markup.button.callback('🆕 1-я серия + сезон', `sub_set_${tmdbId}_first_and_full`)]
        ];
    }
    rows.push(backRow);

    return {
        caption: cardHead(name, yearOf(data), kindLine) + nextLine + overviewBlock(data.overview) + footer,
        keyboard: Markup.inlineKeyboard(rows),
        posterUrl: posterOf(data.poster_path)
    };
}

/**
 * A film's card. Out already: the release date and where to watch. Not yet: the release date
 * and "add to the watchlist" (or a note that it's there).
 * Both with the premiere in Russia and the digital releases when known (extraFilmDates).
 * @param {object} data TMDB film details
 * @param {{ kinopoiskId?: number | null, onWatchlist?: boolean, now?: Date, ru?: object }} [opts]
 *   ru: Kinopoisk's Russian dates (russianDates)
 */
function filmCard(data, { kinopoiskId = null, onWatchlist = false, now = new Date(), ru = {} } = {}) {
    const name = data.title || data.original_title || 'Без названия';
    const kindLine = data.director_name ? `Фильм · режиссёр ${data.director_name}` : 'Фильм';
    const released = isMovieReleased(data, now);
    const date = formatRuDate(data.release_date);

    let dates;
    let rows;
    const more = extraFilmDates(data, ru).join('');
    if (released) {
        dates = `✅ Уже вышел${date ? ` — <b>${date}</b>` : ''}\n` + more;
        rows = watchButtonRows({ title: name, kinopoiskId, mediaType: 'movie' });
    } else {
        dates = `📅 Релиз: <b>${date || 'дата не объявлена'}</b>\n` + more;
        rows = onWatchlist ? [] : [[Markup.button.callback('📌 В список ожидания', `watchlist_add_movie_${data.id}`)]];
    }
    rows.push(backRow);

    const footer = released
        ? ''
        : onWatchlist
          ? '\n📌 Уже в вашем списке ожидания — пришлю уведомление, когда выйдет.'
          : '\nДобавить в список ожидания? Как только выйдет — пришлю уведомление.';
    return {
        caption: cardHead(name, yearOf(data), kindLine) + dates + overviewBlock(data.overview) + footer,
        keyboard: Markup.inlineKeyboard(rows),
        posterUrl: posterOf(data.poster_path)
    };
}

module.exports = { resultsList, seriesCard, filmCard, plural, PER_PAGE };
