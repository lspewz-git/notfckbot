/**
 * The bot's 📅 week and month views: what came out and what comes out among a chat's
 * subscriptions and films, in a week (Monday to Sunday) or a calendar month of the chat's time
 * zone, any number of periods back or ahead. Episode dates come from TMDB's season lists
 * (cached); which seasons to ask for, from the years each series had episodes in.
 */
const { Subscription, Series, Watchlist } = require('./db');
const { getDetailsCached, getSeasonDetailsCached, hasSeason, refreshSeasons } = require('./api/tmdb');
const { parseSeasons } = require('./cron/release-seasons');
const { parseAired } = require('./cron/aired-episodes');
const { zoneOf } = require('./quiet');
const { escapeHtml, isFinishedStatus } = require('./constants');
const { plural } = require('./words');
const { rowFilmDates } = require('./film-release');
const { episodeArrivalDay } = require('./account/notify-day');
const tvmaze = require('./api/tvmaze');
const { timeOf, releaseDay, outAt, dayOnly, MAX_SHIFT_DAYS } = require('./episode-times');

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

// No end: whatever TMDB already knows the date of (a season a year or two ahead at most)
const NO_END = '9999-12-31';

/** The panel's one-list calendar: from yesterday (what just came out) on, with no end. */
function listPeriod(zoneId, now = new Date()) {
    const today = todayIn(zoneId, now);
    return { from: addDays(today, -1), to: NO_END, today };
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
    // Calendars still include every aired episode, even when its year owns <70% of the season.
    const byYear = series.aired_episodes == null ? parseSeasons(series.release_seasons) : new Map();
    if (series.aired_episodes != null) {
        for (const [month, seasons] of parseAired(series.aired_episodes)) {
            const y = year(month);
            byYear.set(y, [...new Set([...(byYear.get(y) || []), ...seasons.keys()])]);
        }
    }
    // Ended or canceled, nothing announced and the last season out before that year: nothing to ask
    const lastYear = Math.max(0, ...byYear.keys());
    if (isFinishedStatus(series.status) && !series.next_episode_season && lastYear && lastYear < year(from)) return [];
    for (const [y, list] of byYear) if (y >= year(from) && y <= year(to)) for (const s of list) seasons.add(s);
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

// TMDB's stand-in for an episode without a title in that language: "Эпизод 8", "Episode 8"
const PLACEHOLDER_NAME = /^(эпизод|серия|episode)\s*\d+$/i;
const realName = (name) => (name && !PLACEHOLDER_NAME.test(name.trim()) ? name : '');

/**
 * Episode titles by number: Russian, else English for the episodes TMDB has no Russian title for,
 * else none. English is asked only when needed; without an answer those stay untitled.
 */
async function episodeNames(numericId, season, episodes) {
    const names = new Map(episodes.map((ep) => [ep.episode_number, realName(ep.name)]));
    if (![...names.values()].some((name) => !name)) return names;
    const english = await getSeasonDetailsCached(numericId, season, 'en-US').catch(() => null);
    for (const ep of (english && english.episodes) || []) {
        if (!names.get(ep.episode_number)) names.set(ep.episode_number, realName(ep.name));
    }
    return names;
}

/**
 * The seasons the panel's calendar shows (a day of slack for the time zones), in memory before
 * anyone opens it. Run by the update check and after a start, with the details at hand: the
 * missing Russian seasons in one request, the English titles for "Эпизод N" in one more.
 */
async function warmSeasons(series, details, now = new Date()) {
    const numericId = String(series.tmdb_id).replace('tv_', '');
    const from = addDays(todayIn('UTC', now), -2);
    const seasons = seasonsToAsk(series, details, from, NO_END);
    await refreshSeasons(
        numericId,
        seasons.filter((s) => !hasSeason(numericId, s))
    );
    const untitled = [];
    for (const season of seasons) {
        const data = await getSeasonDetailsCached(numericId, season).catch(() => null);
        const coming = ((data && data.episodes) || []).filter((ep) => ep.air_date && ep.air_date >= from);
        if (coming.some((ep) => !realName(ep.name))) untitled.push(season);
    }
    // English titles change rarely: asked again once the kept ones expire, not on every check
    await refreshSeasons(
        numericId,
        untitled.filter((s) => !hasSeason(numericId, s, 'en-US')),
        'en-US'
    );
}

// An episode arrives at most this many days after its TMDB date (24 h update checks: two)
const ARRIVAL_SLACK_DAYS = 3;

/** The seasons to bring along with a series' details: the last aired and the next. */
const seasonsAlong = (series) => [...new Set([series.last_season, series.next_episode_season].filter(Boolean))];

/**
 * One series' episodes in the period: [{ date, tmdbId, title, season, episode, note, mark, name, overview,
 * poster, kinopoiskId }]; `note` is the bot's Russian word for `mark` ('premiere' | 'finale' | '').
 * With `local`, `date` is the chat's day the episode comes out: TVmaze's moment in the chat's zone
 * where TVmaze knows the episode (src/episode-times.js), else the day the bot announces it by
 * TMDB (episodeArrivalDay(): the day after TMDB's US date). `tmdbDate` keeps TMDB's day and
 * `outAt` TVmaze's moment it counts as out (the bell's day, src/account/notify-day.js).
 * @param {{ chat: { timezone?: string | null }, deadline: ReturnType<typeof tvmaze.viewDeadline> } | null} [local]
 *   deadline: shared by the view's series; after it only cached TVmaze times are used
 */
async function seriesEpisodes(series, from, to, local = null) {
    const numericId = String(series.tmdb_id).replace('tv_', '');
    const details = await getDetailsCached(numericId, 'tv').catch(() => null);
    const counts = new Map(((details && details.seasons) || []).map((s) => [s.season_number, s.episode_count]));
    const times =
        local && details
            ? await tvmaze.airTimesQuick(series.tmdb_id, tvmaze.externalsOf(details), local.deadline)
            : null;
    const zoneId = local && local.chat ? local.chat.timezone : null;
    const dayOf = (season, ep) => {
        if (!local) return { date: ep.air_date, outAt: null, dayOnly: false };
        const time = timeOf(times, season, ep.episode_number, ep.air_date);
        // dayOnly: the day is known, the hour isn't, so the message waits for the day to end
        return time
            ? { date: releaseDay(time, zoneId), outAt: outAt(time), dayOnly: dayOnly(time) }
            : { date: episodeArrivalDay(ep.air_date, local.chat), outAt: null, dayOnly: false };
    };
    // TVmaze's day may be a day before TMDB's, the arrival up to a few after: TMDB's days around the period
    const askFrom = local ? addDays(from, -ARRIVAL_SLACK_DAYS) : from;
    const askTo = local && to !== NO_END ? addDays(to, MAX_SHIFT_DAYS) : to;
    const items = [];
    for (const season of seasonsToAsk(series, details, askFrom, askTo)) {
        const data = await getSeasonDetailsCached(numericId, season);
        const inPeriod = ((data && data.episodes) || [])
            .filter((ep) => ep.air_date && ep.air_date >= askFrom && ep.air_date <= askTo)
            .map((ep) => ({ ep, ...dayOf(season, ep) }))
            .filter(({ date }) => date && date >= from && date <= to);
        if (!inPeriod.length) continue;
        const names = await episodeNames(
            numericId,
            season,
            inPeriod.map(({ ep }) => ep)
        );
        for (const { ep, date, outAt: out, dayOnly: untimed } of inPeriod) {
            const total = counts.get(season);
            const mark = ep.episode_number === 1 ? 'premiere' : total && ep.episode_number === total ? 'finale' : '';
            items.push({
                date,
                tmdbDate: ep.air_date,
                outAt: out,
                dayOnly: untimed,
                kind: 'tv',
                tmdbId: series.tmdb_id,
                title: series.title,
                season,
                episode: ep.episode_number,
                note: NOTES[mark],
                mark,
                // The season's final episode, also when it is its only one (the calendar's bell)
                last: Boolean(total && ep.episode_number === total),
                name: names.get(ep.episode_number) || '',
                overview: ep.overview || '',
                genres: series.genres,
                networks: series.networks,
                poster: series.poster_url || null,
                kinopoiskId: series.kinopoisk_id || null
            });
        }
    }
    return items;
}

/**
 * Everything of a chat's in the period, by date, and how many series TMDB didn't answer for.
 * `local`: episodes on the chat's days they come out (seriesEpisodes); without it, TMDB's days.
 * @param {{ digitalAlerts?: boolean, local?: { chat: { timezone?: string | null } } | null, waitMs?: number }} [options]
 *   waitMs: how long the whole view waits for TVmaze (3 s for one someone opened)
 * @returns {Promise<{ items: object[], failed: number }>}
 */
async function periodItems(chatId, from, to, { digitalAlerts = false, local = null, waitMs = 3000 } = {}) {
    const [subs, films] = await Promise.all([
        Subscription.findAll({ where: { chatId }, include: [{ model: Series }] }),
        Watchlist.findAll({ where: { chatId } })
    ]);
    const series = subs.map((s) => s.Series).filter(Boolean);
    let failed = 0;
    // One wait for TVmaze for the whole view, not one per series: it may not answer at all
    // A longer wait (a digest, sent once): it also queues behind other requests rather than give up
    const deadline = local ? tvmaze.viewDeadline(waitMs, { patient: waitMs > 3000 }) : null;
    const perSeries = await inBatches(series, (s) =>
        seriesEpisodes(s, from, to, local && { chat: local.chat, deadline }).catch(() => {
            failed += 1;
            return [];
        })
    ).finally(() => deadline && deadline.cancel());
    const modes = new Map(subs.filter((s) => s.Series).map((s) => [s.Series.tmdb_id, s.notify_type]));
    const items = perSeries.flat().map((item) => ({ ...item, mode: modes.get(item.tmdbId) }));
    // One Release event, independent of the chat's optional digital notification setting.
    const seenFilms = new Set();
    for (const f of films) {
        const dates = rowFilmDates(f, digitalAlerts);
        const release = dates.release;
        const rows = [release && { ...release, event: 'release', estimate: false }];
        for (const row of rows) {
            const date = row && row.date && String(row.date).slice(0, 10);
            const key = row && `${f.tmdb_id}:${row.event}`;
            if (!date || date < from || date > to || seenFilms.has(key)) continue;
            seenFilms.add(key);
            items.push({
                date,
                kind: 'movie',
                event: row.event,
                estimate: row.estimate,
                country: row.country,
                countries: row.countries,
                ...dates,
                tmdbId: f.tmdb_id,
                listId: f.id,
                title: f.title,
                poster: f.poster_url || null,
                genres: f.genres
            });
        }
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
    if (item.kind === 'movie') {
        const title = escapeHtml(item.title);
        return `🎬 ${title} — ${past ? 'вышел' : 'выход'}`;
    }
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
                left += more.filter((l) => /^(📺|🎬|💻|🎞)/.test(l)).length;
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
    warmSeasons,
    seasonsAlong,
    plural,
    rangeText,
    MONTHS_TITLE
};
