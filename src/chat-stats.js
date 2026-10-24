/**
 * One chat's statistics over a period (a year, a month, everything), for the panel and the year's
 * recap cards: what it follows, what came out of it in the period (episodes by month, films),
 * what it is into (genres, channels, countries), the notifications it got and how it uses the bot.
 *
 * computeStats() is the arithmetic on plain rows, so tests need no database; loadChatStats()
 * reads the rows. Days are the chat's own (its time zone), as "YYYY-MM-DD" strings.
 */
const { Op, fn, col } = require('sequelize');
const { Chat, Series, Subscription, Watchlist, ChatEvent } = require('./db');
const events = require('./chat-events');
const { todayIn } = require('./calendar');
const { DEFAULT_ZONE } = require('./quiet');
const { isFinishedStatus } = require('./constants');
const { parseAired } = require('./cron/aired-episodes');

const TOP = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const inPeriod = (day, { from, to }) => Boolean(day) && day >= from && day <= to;
const monthInPeriod = (month, { from, to }) => month >= from.slice(0, 7) && month <= to.slice(0, 7);
const split = (value, by) =>
    String(value || '')
        .split(by)
        .map((s) => s.trim())
        .filter(Boolean);

/** { name: n } → [{ name, n }], most first, then by name; the first `limit`. */
function ranked(counts, limit = TOP) {
    return Object.entries(counts)
        .map(([name, n]) => ({ name, n }))
        .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
        .slice(0, limit);
}

function add(counts, key, n = 1) {
    if (key) counts[key] = (counts[key] || 0) + n;
}

/**
 * Who in the chat did what, from the events that name a member (the bot's buttons; the panel's
 * changes and the notifications name nobody): who added the most series and films, who used the
 * bot the most. A member is one Telegram id, under the latest name seen, so a new @username
 * doesn't split them in two.
 */
function membersOf(chatEvents) {
    const people = new Map();
    for (const e of chatEvents) {
        if (!e.userId) continue;
        const id = String(e.userId);
        const person = people.get(id) || { name: id, series: 0, films: 0, used: 0 };
        if (e.userName) person.name = e.userName;
        if (e.kind === 'subscribed') person.series += 1;
        else if (e.kind === 'film_added') person.films += 1;
        else if (e.kind === 'used') person.used += 1;
        people.set(id, person);
    }
    const all = [...people.values()];
    const byName = (a, b) => a.name.localeCompare(b.name);
    const added = all
        .map(({ name, series, films }) => ({ name, series, films, n: series + films }))
        .filter((p) => p.n)
        .sort((a, b) => b.n - a.n || byName(a, b))
        .slice(0, TOP);
    return {
        added,
        // The first of `added` added clearly the most: the panel's ★ and the caption's line
        leader: Boolean(leader({ added })),
        used: all
            .filter((p) => p.used)
            .map(({ name, used }) => ({ name, n: used }))
            .sort((a, b) => b.n - a.n || byName(a, b))
            .slice(0, TOP)
    };
}

/** The member who added clearly the most: at least 3 and more than anyone else; else null. */
function leader(members) {
    const [first, second] = (members && members.added) || [];
    return first && first.n >= 3 && (!second || second.n < first.n) ? first : null;
}

/** A film's date in Russia or anywhere, whichever is first: when it came out for the chat. */
function filmDay(film) {
    return [film.premiere_digital, film.ru_premiere, film.ru_digital]
        .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d || ''))
        .map((d) => d.slice(0, 10))
        .sort()[0];
}

/**
 * The statistics. `series`: the chat's subscriptions, each a Series row with `mode` and
 * `subscribedAt`; `films`: its watchlist rows; `events`: its ChatEvent rows (any period, the
 * rest are skipped); `followers`: tmdb_id → how many chats follow it, for the rare finds;
 * `firstEvent`: when the chat's earliest event was recorded, when `events` holds only the period's.
 * @param {{ chat: { id: any, timezone?: string }, series: object[], films: object[], events: object[],
 *   followers?: Map<string, number> }} data
 * @param {{ from: string, to: string }} period inclusive days
 */
function computeStats(
    { chat, series, films, events: chatEvents, followers = new Map(), firstEvent },
    period,
    now = new Date()
) {
    const zone = (chat && chat.timezone) || DEFAULT_ZONE;
    const dayOf = (date) => (date ? todayIn(zone, new Date(date)) : null);
    const today = todayIn(zone, now);

    // Episodes out in the period, from each series' months
    const byMonth = {};
    const perSeries = [];
    const seasons = new Set();
    const genres = {};
    const networks = {};
    const countries = {};
    const active = [];
    for (const s of series) {
        let count = 0;
        let minutes = 0;
        let lastMonth = null;
        for (const [month, bySeason] of parseAired(s.aired_episodes)) {
            lastMonth = month;
            if (!monthInPeriod(month, period)) continue;
            for (const [season, total] of bySeason) {
                seasons.add(`${s.tmdb_id}:${season}`);
                count += total.count;
                minutes += total.minutes;
                const m = (byMonth[month] = byMonth[month] || { count: 0, minutes: 0 });
                m.count += total.count;
                m.minutes += total.minutes;
            }
        }
        if (!count) continue;
        perSeries.push({
            tmdb_id: s.tmdb_id,
            title: s.title,
            count,
            minutes,
            lastMonth,
            status: s.status,
            poster_url: s.poster_url || null
        });
        active.push({
            title: s.title,
            kind: 'series',
            rating: s.rating || null,
            tmdb_id: s.tmdb_id,
            poster_url: s.poster_url || null
        });
        // An interest counts once per title, whatever its number of episodes
        for (const g of split(s.genres, ',')) add(genres, g);
        for (const n of split(s.networks, ',')) add(networks, n);
        for (const c of split(s.countries, ',')) add(countries, c);
    }

    const released = [];
    const services = {};
    for (const f of films) {
        const day = filmDay(f);
        if (!inPeriod(day, period) || day > today) continue;
        const added = dayOf(f.createdAt);
        const waited = added && added < day ? Math.round((Date.parse(day) - Date.parse(added)) / DAY_MS) : 0;
        released.push({
            tmdb_id: f.tmdb_id,
            title: f.title,
            day,
            waited,
            rating: f.rating || null,
            poster_url: f.poster_url || null
        });
        active.push({
            title: f.title,
            kind: 'film',
            rating: f.rating || null,
            tmdb_id: f.tmdb_id,
            poster_url: f.poster_url || null
        });
        for (const g of split(f.genres, ',')) add(genres, g);
        for (const c of split(f.countries, ',')) add(countries, c);
        for (const s of split(f.ru_services, ',')) add(services, s);
    }
    released.sort((a, b) => a.day.localeCompare(b.day));

    const months = Object.keys(byMonth).sort();
    const busiest = months.reduce((best, m) => (!best || byMonth[m].count > byMonth[best].count ? m : best), null);

    // Events in the period
    const inside = chatEvents.filter((e) => inPeriod(dayOf(e.createdAt), period));
    const notified = inside.filter((e) => e.kind === 'notified');
    const outcomes = {};
    const kinds = {};
    const notifyDays = {};
    for (const e of notified) {
        add(outcomes, e.outcome || 'sent');
        add(kinds, e.detail || 'other');
        if (e.outcome !== 'failed') add(notifyDays, dayOf(e.createdAt));
    }
    const busiestDay = ranked(notifyDays, 1)[0] || null;
    const used = inside.filter((e) => e.kind === 'used');
    const features = {};
    for (const e of used) add(features, e.detail);

    const finishedInPeriod = perSeries
        .filter((s) => isFinishedStatus(s.status) && s.lastMonth && monthInPeriod(s.lastMonth, period))
        .map((s) => ({ tmdb_id: s.tmdb_id, title: s.title, status: s.status }));

    const best = active
        .filter((t) => t.rating)
        .sort((a, b) => b.rating - a.rating || a.title.localeCompare(b.title))
        .slice(0, TOP);

    const rare = [...series.map((s) => ({ ...s, kind: 'series' })), ...films.map((f) => ({ ...f, kind: 'film' }))]
        .filter((t) => (followers.get(t.tmdb_id) || 0) === 1)
        .map((t) => ({ tmdb_id: t.tmdb_id, title: t.title, kind: t.kind }));

    return {
        period: { from: period.from, to: period.to },
        // What the chat follows now
        following: {
            series: series.length,
            running: series.filter((s) => !isFinishedStatus(s.status)).length,
            films: films.filter((f) => !f.notified).length
        },
        added: {
            series: series.filter((s) => inPeriod(dayOf(s.subscribedAt), period)).length,
            films: films.filter((f) => inPeriod(dayOf(f.createdAt), period)).length,
            unsubscribed: inside.filter((e) => e.kind === 'unsubscribed').length,
            filmsRemoved: inside.filter((e) => e.kind === 'film_removed').length
        },
        episodes: {
            count: perSeries.reduce((n, s) => n + s.count, 0),
            minutes: perSeries.reduce((n, s) => n + s.minutes, 0),
            series: perSeries.length,
            seasons: seasons.size,
            byMonth: months.map((month) => ({ month, ...byMonth[month] })),
            busiestMonth: busiest ? { month: busiest, ...byMonth[busiest] } : null,
            top: [...perSeries]
                .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
                .slice(0, TOP)
                .map(({ tmdb_id, title, count, minutes, poster_url }) => ({
                    tmdb_id,
                    title,
                    count,
                    minutes,
                    poster_url
                }))
        },
        films: {
            released,
            minutes: films
                .filter((f) => released.some((r) => r.tmdb_id === f.tmdb_id))
                .reduce((n, f) => n + (f.runtime || 0), 0),
            longestWait: [...released].sort((a, b) => b.waited - a.waited)[0] || null,
            services: ranked(services)
        },
        favourites: { genres: ranked(genres), networks: ranked(networks), countries: ranked(countries) },
        best,
        finished: finishedInPeriod,
        ahead: {
            series: series.filter((s) => s.next_episode_date && s.next_episode_date > period.to).length,
            films: films.filter((f) => !f.notified && (!filmDay(f) || filmDay(f) > period.to)).length,
            // What comes first after the period, with a date: the next episode or the film's release
            next: [
                ...series
                    .filter((s) => s.next_episode_date && s.next_episode_date > period.to)
                    .map((s) => ({ title: s.title, day: s.next_episode_date, kind: 'series' })),
                ...films
                    .filter((f) => !f.notified && filmDay(f) > period.to)
                    .map((f) => ({ title: f.title, day: filmDay(f), kind: 'film' }))
            ]
                .sort((a, b) => a.day.localeCompare(b.day))
                .slice(0, TOP)
        },
        notifications: {
            total: notified.length,
            outcomes,
            kinds,
            busiestDay: busiestDay && { day: busiestDay.name, n: busiestDay.n }
        },
        usage: { total: used.length, features: ranked(features, 20) },
        members: membersOf(inside),
        rare,
        // Since when the events (notifications, use) are counted: the earliest one recorded
        since:
            firstEvent !== undefined ? dayOf(firstEvent) : chatEvents.map((e) => dayOf(e.createdAt)).sort()[0] || null
    };
}

/** The chat's statistics from the database, or null for a chat that isn't there. */
async function loadChatStats(chatId, period, now = new Date()) {
    const chat = await Chat.findByPk(chatId);
    if (!chat) return null;
    // The period's events only, with a day's margin either side for the chat's time zone
    const window = {
        [Op.gte]: new Date(Date.parse(period.from) - DAY_MS),
        [Op.lt]: new Date(Date.parse(period.to) + 2 * DAY_MS)
    };
    const [subs, films, stored, firstEvent] = await Promise.all([
        Subscription.findAll({ where: { chatId }, include: [{ model: Series }] }),
        Watchlist.findAll({ where: { chatId } }),
        ChatEvent.findAll({ where: { chatId, createdAt: window }, order: [['id', 'ASC']] }),
        ChatEvent.min('createdAt', { where: { chatId } })
    ]);
    // How many chats follow each of its titles
    const [seriesFollowers, filmFollowers] = await Promise.all([
        Subscription.findAll({
            attributes: ['seriesId', [fn('COUNT', col('chatId')), 'n']],
            where: { seriesId: { [Op.in]: subs.map((s) => s.seriesId) } },
            group: ['seriesId'],
            raw: true
        }),
        Watchlist.findAll({
            attributes: ['tmdb_id', [fn('COUNT', fn('DISTINCT', col('chatId'))), 'n']],
            where: { tmdb_id: { [Op.in]: films.map((f) => f.tmdb_id) } },
            group: ['tmdb_id'],
            raw: true
        })
    ]);
    const followers = new Map();
    for (const row of seriesFollowers) followers.set(row.seriesId, Number(row.n));
    for (const row of filmFollowers) followers.set(row.tmdb_id, Number(row.n));
    const series = subs
        .filter((s) => s.Series)
        .map((s) => ({ ...s.Series.get({ plain: true }), mode: s.notify_type, subscribedAt: s.createdAt }));
    const unwritten = events.unwritten().filter((e) => String(e.chatId) === String(chatId));
    return computeStats(
        {
            chat,
            series,
            films: films.map((f) => f.get({ plain: true })),
            events: [...stored.map((e) => e.get({ plain: true })), ...unwritten],
            followers,
            firstEvent: firstEvent || (unwritten[0] && unwritten[0].createdAt) || null
        },
        period,
        now
    );
}

module.exports = { computeStats, loadChatStats, filmDay, leader };
