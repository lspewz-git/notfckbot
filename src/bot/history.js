/**
 * 🗓 The calendar's year: what came out last year and this year among the chat's subscriptions
 * and watchlist, and what TMDB lists for the next one. Opened from the calendar's «Год» or with
 * /history. One message; the year buttons switch it in place.
 */
const { Markup } = require('telegraf');
const { escapeHtml } = require('../constants');
const { releaseHistory, upcomingHistory } = require('../history');
const { todayIn, plural } = require('../calendar');
const { viewRows, canGoBack, isDigest } = require('./calendar');

// Telegram's limit is 4096 characters; the links make each line long, so stop well before it
const MAX_TEXT = 3800;
// No previews: a message with a dozen links would otherwise show the first one's page
const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

/** "сезон 4", "сезоны 2, 3"; null for a film. */
const seasonsText = (seasons) =>
    seasons && seasons.length ? `${seasons.length > 1 ? 'сезоны' : 'сезон'} ${seasons.join(', ')}` : null;

const line = (item) =>
    [
        `<a href="${escapeHtml(item.kinopoiskUrl)}">${escapeHtml(item.title)}</a>`,
        seasonsText(item.seasons),
        item.genres.length ? escapeHtml(item.genres.join(', ')) : null
    ]
        .filter(Boolean)
        .join(' · ');

/** Last year, this year, the next one: the chat's own "this year". */
const yearsAround = (thisYear) => [thisYear - 1, thisYear, thisYear + 1];

/**
 * The message for one year: serials, then films, each title a link to its Kinopoisk page; this
 * year also what is still to come in it.
 * @param {{ year: number, thisYear: number, series: object[], films: object[],
 *   later?: { series: object[], films: object[] } | null, failed?: number }} data
 * @param {{ back?: boolean }} [options] back: the way back to the subscriptions
 */
function historyView({ year, thisYear, series, films, later = null, failed = 0 }, { back = true } = {}) {
    const ahead = year > thisYear;
    const lines = [`🗓 <b>${ahead ? 'Выйдет' : 'Вышло'} в ${year}</b>`];
    const sections = [
        { heading: '📺 <b>Сериалы</b>', texts: series.map(line) },
        { heading: '🎬 <b>Фильмы</b>', texts: films.map(line) },
        {
            heading: `⏳ <b>Ещё выйдет в ${year}</b>`,
            toCome: true,
            texts: later
                ? [...later.series.map((i) => `📺 ${line(i)}`), ...later.films.map((i) => `🎬 ${line(i)}`)]
                : []
        }
    ].filter((s) => s.texts.length);
    // Telegram's limit: what is still to come gets its room first, then serials, then films
    let length = lines[0].length + sections.reduce((n, s) => n + s.heading.length + 2, 0);
    for (const s of [...sections].sort((a, b) => Number(Boolean(b.toCome)) - Number(Boolean(a.toCome)))) {
        s.shown = s.texts.filter((text) => {
            if (length + text.length + 1 > MAX_TEXT) return false;
            length += text.length + 1;
            return true;
        });
    }

    if (!series.length && !films.length) {
        lines.push(
            '',
            ahead
                ? `На ${year} у подписок пока ничего не объявлено.`
                : `В ${year} у подписок ${year === thisYear ? 'пока ' : ''}ничего не выходило.`
        );
    }
    let left = 0;
    // The panel's History has what came out, not what is to come
    let inPanel = !ahead;
    for (const s of sections) {
        if (s.shown.length) lines.push('', s.heading, ...s.shown);
        left += s.texts.length - s.shown.length;
        if (s.toCome && s.shown.length < s.texts.length) inPanel = false;
    }
    if (sections.length) {
        if (left) lines.push('', `<i>…и ещё ${left}${inPanel ? ' — полный список в панели' : ''}.</i>`);
        lines.push('', '<i>Название — ссылка на Кинопоиск.</i>');
    }
    if (failed) {
        lines.push(
            '',
            `<i>TMDB не ответил по ${plural(failed, 'сериалу', 'сериалам', 'сериалам')} — ${ahead ? 'их здесь нет' : 'в «Ещё выйдет» их нет'}.</i>`
        );
    }

    const yearRow = yearsAround(thisYear).map((y) =>
        Markup.button.callback(y === year ? `${y} ✓` : String(y), `hist_${y}`)
    );
    return { text: lines.join('\n'), keyboard: Markup.inlineKeyboard([yearRow, ...viewRows('y', { back })]) };
}

/**
 * The view of a year for a chat; any year but the three falls back to this one.
 * @param {{ id: number | string, timezone?: string, buttons_mode?: string }} chat
 */
async function yearView(chat, requested, { digest = false, now = new Date() } = {}) {
    const today = todayIn(chat.timezone, now);
    const thisYear = Number(today.slice(0, 4));
    const year = yearsAround(thisYear).includes(requested) ? requested : thisYear;
    const options = { back: !digest || canGoBack(chat) };
    if (year > thisYear) {
        return historyView({ ...(await upcomingHistory({ chatId: chat.id, year })), year, thisYear }, options);
    }
    const [history, later] = await Promise.all([
        releaseHistory({ chatId: chat.id, year, now }),
        year === thisYear ? upcomingHistory({ chatId: chat.id, year, from: today }) : null
    ]);
    // A year with nothing out comes back as another one: here it is just empty
    const out = history.year === year ? history : { series: [], films: [] };
    if (later) {
        // A film out today is out: not also to come (a series with more episodes is both)
        const outFilms = new Set(out.films.map((f) => f.tmdbId));
        later.films = later.films.filter((f) => !outFilms.has(f.tmdbId));
    }
    return historyView(
        { series: out.series, films: out.films, later, failed: later ? later.failed : 0, year, thisYear },
        options
    );
}

function register(bot) {
    bot.command('history', async (ctx) => {
        if (!ctx.state.chatData) return;
        await ctx.sendChatAction('typing').catch(() => {});
        const view = await yearView(ctx.state.chatData, null);
        await ctx.reply(view.text, { parse_mode: 'HTML', ...NO_PREVIEW, ...view.keyboard });
    });

    // hist_0: this year, from the calendar's tabs; hist_2027: that year
    bot.action(/^hist_(\d{1,4})$/, async (ctx) => {
        // Answered first: the year ahead may take TMDB a few seconds
        await ctx.answerCbQuery();
        if (!ctx.state.chatData) return;
        const view = await yearView(ctx.state.chatData, Number(ctx.match[1]), { digest: isDigest(ctx) });
        await ctx.editMessageText(view.text, { parse_mode: 'HTML', ...NO_PREVIEW, ...view.keyboard }).catch((err) => {
            // The same year pressed again
            if (!/not modified/.test(err.message)) throw err;
        });
    });
}

module.exports = { register, historyView, yearView };
