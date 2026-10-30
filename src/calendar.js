/**
 * The bot's 📅 week and month views: what came out and what comes out among a chat's
 * subscriptions and films, in a week (Monday to Sunday) or a calendar month of the chat's time
 * zone, any number of periods back or ahead. Episode dates come from TMDB's season lists
 * (cached); which seasons to ask for, from the years each series had episodes in.
 */
const { Subscription, Series, Watchlist } = require('./db');
const { getDetailsCached, getSeasonDetailsCached } = require('./api/tmdb');
const { parseSeasons } = require('./cron/release-seasons');
const { zoneOf } = require('./quiet');
const { escapeHtml } = require('./constants');

// --- Dates as "YYYY-MM-DD" strings: TMDB's air dates are days, not moments ---

/** Today in a time zone. */
const todayIn = (zoneId, now = new Date()) =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone: zoneOf(zoneId).id,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(now);

const toUtc = (day) => new Date(`${day}T00:00:00Z`);
const fromUtc = (date) => date.toISOString().slice(0, 10);
const addDays = (day, n) => fromUtc(new Date(toUtc(day).getTime() + n * 86400000));
/** Monday of the day's week. */
const weekStart = (day) => addDays(day, -((toUtc(day).getUTCDay() + 6) % 7));
const monthStart = (day) => `${day.slice(0, 8)}01`;
function addMonths(day, n) {
    const d = toUtc(monthStart(day));
    d.setUTCMonth(d.getUTCMonth() + n);
    return fromUtc(d);
}
const monthEnd = (day) => addDays(addMonths(day, 1), -1);

const MONTHS = [
    'января',
    'февраля',
    'марта',
    'апреля',
    'мая',
    'июня',
    'июля',
    'августа',
    'сентября',
    'октября',
    'ноября',
    'декабря'
];
const MONTHS_TITLE = [
    'Январь',
    'Февраль',
    'Март',
    'Апрель',
    'Май',
    'Июнь',
    'Июль',
    'Август',
    'Сентябрь',
    'Октябрь',
    'Ноябрь',
    'Декабрь'
];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const dayNum = (day) => Number(day.slice(8, 10));
const monthIdx = (day) => Number(day.slice(5, 7)) - 1;
const year = (day) => Number(day.slice(0, 4));

/** "13–19 октября", "27 октября – 2 ноября", "29 декабря 2026 – 4 января 2027" */
function rangeText(from, to) {
    if (monthIdx(from) === monthIdx(to) && year(from) === year(to)) {
        return `${dayNum(from)}–${dayNum(to)} ${MONTHS[monthIdx(to)]}`;
    }
    const withYear = year(from) !== year(to);
    const end = (d) => `${dayNum(d)} ${MONTHS[monthIdx(d)]}${withYear ? ` ${year(d)}` : ''}`;
    return `${end(from)} – ${end(to)}`;
}

/** "13–19 окт" for the month view's week groups. */
const shortRange = (from, to) =>
    from === to
        ? `${dayNum(from)} ${MONTHS_SHORT[monthIdx(from)]}`
        : monthIdx(from) === monthIdx(to)
          ? `${dayNum(from)}–${dayNum(to)} ${MONTHS_SHORT[monthIdx(to)]}`
          : `${dayNum(from)} ${MONTHS_SHORT[monthIdx(from)]} – ${dayNum(to)} ${MONTHS_SHORT[monthIdx(to)]}`;

const dayTitle = (day) => `${WEEKDAYS[toUtc(day).getUTCDay()]}, ${dayNum(day)} ${MONTHS_SHORT[monthIdx(day)]}`;

/** 1 серия, 2 серии, 5 серий */
function plural(n, one, few, many) {
    const t = n % 10;
    const h = n % 100;
    const word = t === 1 && h !== 11 ? one : t >= 2 && t <= 4 && (h < 12 || h > 14) ? few : many;
    return `${n} ${word}`;
}

/**
 * The period `offset` weeks or months from the current one.
 * @param {'w' | 'm'} kind
 * @returns {{ kind, offset, from: string, to: string, today: string }}
 */
function period(kind, offset, zoneId, now = new Date()) {
    const today = todayIn(zoneId, now);
    if (kind === 'm') {
        const from = addMonths(today, offset);
        return { kind, offset, from, to: monthEnd(from), today };
    }
    const from = addDays(weekStart(today), offset * 7);
    return { kind, offset, from, to: addDays(from, 6), today };
}

/** The panel's one-list calendar: from the first of last month to the end of the month after next. */
function listPeriod(zoneId, now = new Date()) {
    const today = todayIn(zoneId, now);
    return { from: addMonths(today, -1), to: monthEnd(addMonths(today, 2)), today };
}

// --- What comes out in a period ---

const SEASONS_PER_SERIES = 4;
const PARALLEL = 4;

/** Runs `fn` over `items`, a few at a time: TMDB through the proxy is slow when crowded. */
async function inBatches(items, fn) {
    const out = [];
    for (let i = 0; i < items.length; i += PARALLEL) {
        out.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(fn))));
    }
    return out;
}

/** The seasons of a series that may have episodes between `from` and `to`. */
function seasonsToAsk(series, details, from, to) {
    const seasons = new Set();
    const byYear = parseSeasons(series.release_seasons);
    for (let y = year(from); y <= year(to); y += 1) for (const s of byYear.get(y) || []) seasons.add(s);
    if (series.last_season) seasons.add(series.last_season);
    if (series.next_episode_season) seasons.add(series.next_episode_season);
    // Announced seasons starting by the period's end (the release years know only the past)
    for (const s of (details && details.seasons) || []) {
        if (s.season_number > 0 && s.air_date && s.air_date <= to && s.season_number >= (series.last_season || 0)) {
            seasons.add(s.season_number);
        }
    }
    return [...seasons]
        .filter((s) => s > 0)
        .sort((a, b) => b - a)
        .slice(0, SEASONS_PER_SERIES);
}

const NOTES = { premiere: 'премьера сезона', finale: 'финал сезона', '': '' };

/**
 * One series' episodes in the period: [{ date, tmdbId, title, season, episode, note, mark, name, overview,
 * poster, kinopoiskId }]; `note` is the bot's Russian word for `mark` ('premiere' | 'finale' | '').
 */
async function seriesEpisodes(series, from, to) {
    const numericId = String(series.tmdb_id).replace('tv_', '');
    const details = await getDetailsCached(numericId, 'tv').catch(() => null);
    const counts = new Map(((details && details.seasons) || []).map((s) => [s.season_number, s.episode_count]));
    const items = [];
    for (const season of seasonsToAsk(series, details, from, to)) {
        const data = await getSeasonDetailsCached(numericId, season);
        for (const ep of (data && data.episodes) || []) {
            if (!ep.air_date || ep.air_date < from || ep.air_date > to) continue;
            const total = counts.get(season);
            const mark = ep.episode_number === 1 ? 'premiere' : total && ep.episode_number === total ? 'finale' : '';
            items.push({
                date: ep.air_date,
                kind: 'tv',
                tmdbId: series.tmdb_id,
                title: series.title,
                season,
                episode: ep.episode_number,
                note: NOTES[mark],
                mark,
                name: ep.name || '',
                overview: ep.overview || '',
                poster: series.poster_url || null,
                kinopoiskId: series.kinopoisk_id || null
            });
        }
    }
    return items;
}

/**
 * Everything of a chat's in the period, by date, and how many series TMDB didn't answer for.
 * @returns {Promise<{ items: object[], failed: number }>}
 */
async function periodItems(chatId, from, to) {
    const [subs, films] = await Promise.all([
        Subscription.findAll({ where: { chatId }, include: [{ model: Series }] }),
        Watchlist.findAll({ where: { chatId } })
    ]);
    const series = subs.map((s) => s.Series).filter(Boolean);
    let failed = 0;
    const perSeries = await inBatches(series, (s) =>
        seriesEpisodes(s, from, to).catch(() => {
            failed += 1;
            return [];
        })
    );
    const items = perSeries.flat();
    const seenFilms = new Set();
    for (const f of films) {
        const date = f.premiere_digital && String(f.premiere_digital).slice(0, 10);
        if (!date || date < from || date > to || seenFilms.has(f.tmdb_id)) continue;
        seenFilms.add(f.tmdb_id);
        items.push({ date, kind: 'movie', tmdbId: f.tmdb_id, title: f.title, poster: f.poster_url || null });
    }
    items.sort(
        (a, b) =>
            a.date.localeCompare(b.date) || a.title.localeCompare(b.title, 'ru') || (a.episode || 0) - (b.episode || 0)
    );
    return { items, failed };
}

// --- The message ---

// Telegram's limit is 4096 characters; leave room for the cut-off note and the footer
const MAX_TEXT = 3600;

function itemLine(item, past) {
    if (item.kind === 'movie') return `🎬 ${escapeHtml(item.title)} — ${past ? 'вышел' : 'выход'}`;
    return `📺 ${escapeHtml(item.title)} — S${item.season}E${item.episode}${item.note ? `, ${item.note}` : ''}`;
}

/** Adds lines while they fit; counts the ones that don't. */
function fitter() {
    const lines = [];
    let length = 0;
    let left = 0;
    return {
        lines,
        push(...more) {
            const size = more.reduce((n, l) => n + l.length + 1, 0);
            if (length + size > MAX_TEXT) {
                left += more.filter((l) => /^(📺|🎬)/.test(l)).length;
                return;
            }
            lines.push(...more);
            length += size;
        },
        get left() {
            return left;
        }
    };
}

const countText = (items) => {
    const episodes = items.filter((i) => i.kind === 'tv').length;
    const films = items.length - episodes;
    return [
        episodes && plural(episodes, 'серия', 'серии', 'серий'),
        films && plural(films, 'фильм', 'фильма', 'фильмов')
    ]
        .filter(Boolean)
        .join(', ');
};

/** The week: a heading per day with something out, past days ticked. */
function weekText(p, items) {
    const out = fitter();
    out.push(`📅 <b>Неделя ${rangeText(p.from, p.to)}</b>`);
    if (!items.length) out.push('', 'На этой неделе у подписок ничего не выходит.');
    let day = null;
    for (const item of items) {
        const past = item.date < p.today;
        if (item.date !== day) {
            day = item.date;
            out.push('', `<b>${dayTitle(day)}</b>${past ? ' ✓' : item.date === p.today ? ' · сегодня' : ''}`);
        }
        out.push(itemLine(item, past));
    }
    return { out };
}

/** The month: a heading per week; in the current month the days already gone are one line. */
function monthText(p, items) {
    const out = fitter();
    out.push(`📅 <b>${MONTHS_TITLE[monthIdx(p.from)]} ${year(p.from)}</b>`);
    if (!items.length) out.push('', 'В этом месяце у подписок ничего не выходит.');
    let rest = items;
    // The current month: its weeks start no earlier than today, the days before are the summary
    let firstDay = p.from;
    if (p.from <= p.today && p.today <= p.to) {
        firstDay = p.today;
        const gone = items.filter((i) => i.date < p.today);
        rest = items.filter((i) => i.date >= p.today);
        if (gone.length) {
            const until = addDays(p.today, -1);
            out.push('', `<i>${shortRange(p.from, until)}: вышло ${countText(gone)} ✓</i>`);
        }
    }
    let week = null;
    for (const item of rest) {
        const start = weekStart(item.date) < firstDay ? firstDay : weekStart(item.date);
        if (start !== week) {
            week = start;
            const end = addDays(weekStart(item.date), 6) > p.to ? p.to : addDays(weekStart(item.date), 6);
            out.push('', `<b>${shortRange(start, end)}</b>${end < p.today ? ' ✓' : ''}`);
        }
        out.push(itemLine(item, item.date < p.today));
    }
    return { out };
}

/**
 * The text of a week or month view.
 * @param {{ kind: 'w' | 'm', from: string, to: string, today: string }} p
 * @param {{ items: object[], failed: number }} data
 */
function calendarText(p, { items, failed }) {
    const { out } = p.kind === 'm' ? monthText(p, items) : weekText(p, items);
    const lines = out.lines;
    if (out.left) lines.push('', `<i>…и ещё ${out.left}</i>`);
    if (failed)
        lines.push(
            '',
            `<i>TMDB не ответил по ${plural(failed, 'сериалу', 'сериалам', 'сериалам')} — их здесь нет.</i>`
        );
    return lines.join('\n');
}

module.exports = {
    todayIn,
    addDays,
    weekStart,
    monthStart,
    addMonths,
    period,
    listPeriod,
    periodItems,
    calendarText,
    seasonsToAsk,
    plural,
    rangeText,
    MONTHS_TITLE
};
