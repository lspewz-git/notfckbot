/**
 * 🗓 What came out, year by year, among this chat's subscriptions and watchlist: opened from
 * 📺 Мои подписки or with /history. One message; the year buttons switch it in place.
 */
const { Markup } = require('telegraf');
const { escapeHtml } = require('../constants');
const { releaseHistory } = require('../history');

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

/**
 * The message for one year: serials, then films, each title a link to its Kinopoisk page.
 * @param {{ years: number[], year: number | null, series: object[], films: object[] }} history
 */
function historyView({ years, year, series, films }) {
    const back = [Markup.button.callback('⬅️ К подпискам', 'subs_o')];
    if (year === null) {
        return {
            text: '🗓 <b>Вышло по годам</b>\n\nУ подписок этого чата пока ничего не выходило.',
            keyboard: Markup.inlineKeyboard([back])
        };
    }

    const lines = [`🗓 <b>Вышло в ${year}</b>`];
    let length = lines[0].length;
    let left = 0;
    for (const [heading, items] of [
        ['📺 <b>Сериалы</b>', series],
        ['🎬 <b>Фильмы</b>', films]
    ]) {
        if (!items.length) continue;
        lines.push('', heading);
        length += heading.length + 2;
        for (const item of items) {
            const text = line(item);
            if (length + text.length + 1 > MAX_TEXT) {
                left += 1;
                continue;
            }
            lines.push(text);
            length += text.length + 1;
        }
    }
    if (left) lines.push('', `<i>…и ещё ${left} — полный список в панели.</i>`);
    lines.push('', '<i>Название — ссылка на Кинопоиск.</i>');

    return { text: lines.join('\n'), keyboard: Markup.inlineKeyboard([yearRow(years, year), back]) };
}

/** One button per year (src/history.js keeps the last three), oldest first; the shown one ticked. */
const yearRow = (years, year) =>
    [...years].reverse().map((y) => Markup.button.callback(y === year ? `${y} ✓` : String(y), `hist_${y}`));

function register(bot) {
    bot.command('history', async (ctx) => {
        const view = historyView(await releaseHistory({ chatId: ctx.chat.id }));
        await ctx.reply(view.text, { parse_mode: 'HTML', ...NO_PREVIEW, ...view.keyboard });
    });

    // hist_0: the latest year, from the subscriptions menu; hist_2025: that year
    bot.action(/^hist_(\d+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        const year = Number(ctx.match[1]) || null;
        const view = historyView(await releaseHistory({ chatId: ctx.chat.id, year }));
        await ctx.editMessageText(view.text, { parse_mode: 'HTML', ...NO_PREVIEW, ...view.keyboard }).catch((err) => {
            // The same year pressed again
            if (!/not modified/.test(err.message)) throw err;
        });
    });
}

module.exports = { register, historyView };
