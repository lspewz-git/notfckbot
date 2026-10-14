/** Dashboard figures: counters, most popular series, the update check, upcoming releases. */
const { Op } = require('sequelize');
const { Chat, Series, Subscription, Watchlist, DailyStat } = require('../../db');
const { todayIn, addDays, weekStart, addMonths } = require('../../calendar');
const { DEFAULT_ZONE } = require('../../quiet');
const { unwritten } = require('../../stats-log');
const { getCronStatus } = require('../../cron');
const { getVersion } = require('../version');
const { FINISHED_STATUS_LABELS, isFinishedStatus } = require('../../constants');

const router = require('express').Router();

// TMDB statuses after which a show gets no new episodes. Subscriptions to such
// shows are "archived" — derived from Series.status alone, nothing is stored.
const FINISHED_SERIES_STATUSES = Object.keys(FINISHED_STATUS_LABELS);

const DAY_MS = 24 * 60 * 60 * 1000;

/** The day counts from `from` to `to` (inclusive, "YYYY-MM-DD"), the table's plus those not yet written. */
async function dayCounts(from, to) {
    const rows = await DailyStat.findAll({ where: { day: { [Op.between]: [from, to] } } });
    const byDay = new Map(
        rows.map((r) => [r.day, { sent: r.sent, failed: r.failed, checks: r.checks, check_errors: r.check_errors }])
    );
    for (const [day, counts] of unwritten()) {
        if (day < from || day > to) continue;
        const known = byDay.get(day) || { sent: 0, failed: 0, checks: 0, check_errors: 0 };
        for (const [field, n] of Object.entries(counts)) known[field] += n;
        byDay.set(day, known);
    }
    return byDay;
}

const sum = (byDay, from, to, field) =>
    [...byDay].filter(([day]) => day >= from && day <= to).reduce((n, [, c]) => n + c[field], 0);

/** The changes the stat cards show next to their numbers: the last 30 days, the last 7 against the 7 before. */
async function recentChanges(now = new Date()) {
    const since30 = new Date(now.getTime() - 30 * DAY_MS);
    const today = todayIn(DEFAULT_ZONE, now);
    const days = await dayCounts(addDays(today, -13), today);
    const [chatsNew, subsNew, filmsAddedRows, filmsReleased] = await Promise.all([
        Chat.count({ where: { createdAt: { [Op.gte]: since30 } } }),
        // New ones among the active: the card counts subscriptions to series still on air
        Subscription.count({
            include: [{ model: Series, attributes: [], required: false }],
            where: {
                createdAt: { [Op.gte]: since30 },
                [Op.or]: [{ '$Series.status$': null }, { '$Series.status$': { [Op.notIn]: FINISHED_SERIES_STATUSES } }]
            }
        }),
        Watchlist.findAll({
            attributes: ['notified', 'premiere_digital', 'createdAt'],
            where: { createdAt: { [Op.gte]: since30 } }
        }),
        // Released: by the release date, not the row's, which the update check touches
        Watchlist.findAll({
            attributes: ['premiere_digital', 'createdAt'],
            where: { notified: true, premiere_digital: { [Op.between]: [addDays(today, -29), today] } }
        })
    ]);
    // Both sides only for films that waited: one added already out was never awaiting
    const waited = (f) => (f.premiere_digital || '') >= todayIn(DEFAULT_ZONE, new Date(f.createdAt));
    return {
        chatsNew30: chatsNew,
        subsNew30: subsNew,
        // Added while still awaiting: a film added already out goes straight to Released and never
        // waited (its release date is before the day it was added)
        filmsAdded30: filmsAddedRows.filter((f) => !f.notified || waited(f)).length,
        filmsReleased30: filmsReleased.filter(waited).length,
        sent7: sum(days, addDays(today, -6), today, 'sent'),
        sentPrev7: sum(days, addDays(today, -13), addDays(today, -7), 'sent'),
        failed7: sum(days, addDays(today, -6), today, 'failed'),
        failedPrev7: sum(days, addDays(today, -13), addDays(today, -7), 'failed')
    };
}

/**
 * The dashboard's charts: new subscriptions by week (12) and by month (12), notifications by day (30).
 * Weeks run Monday to Sunday, days by Moscow time, as the bot counts them.
 */
router.get('/api/stats/charts', async (req, res) => {
    try {
        const today = todayIn(DEFAULT_ZONE);
        const firstWeek = addDays(weekStart(today), -11 * 7);
        const firstMonth = addMonths(today, -11);
        const since = firstMonth < firstWeek ? firstMonth : firstWeek;
        const subs = await Subscription.findAll({
            attributes: ['createdAt'],
            where: { createdAt: { [Op.gte]: new Date(`${since}T00:00:00Z`) } }
        });
        const subDays = subs.map((s) => todayIn(DEFAULT_ZONE, new Date(s.createdAt)));

        const weeks = Array.from({ length: 12 }, (_, i) => ({ start: addDays(firstWeek, i * 7), count: 0 }));
        const months = Array.from({ length: 12 }, (_, i) => ({
            month: addMonths(today, i - 11).slice(0, 7),
            count: 0
        }));
        for (const day of subDays) {
            const week = weeks.find((w) => w.start === weekStart(day));
            if (week) week.count += 1;
            const month = months.find((m) => m.month === day.slice(0, 7));
            if (month) month.count += 1;
        }

        const firstDay = addDays(today, -29);
        const counts = await dayCounts(firstDay, today);
        const days = Array.from({ length: 30 }, (_, i) => {
            const day = addDays(firstDay, i);
            const c = counts.get(day) || { sent: 0, failed: 0 };
            return { day, sent: c.sent, failed: c.failed };
        });
        // Since when there are day counts at all: the chart says so instead of showing zeros as fact
        const first = await DailyStat.min('day');
        res.json({ weeks, months, days, countingSince: first || today });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/api/stats', async (req, res) => {
    try {
        const [chatsCount, seriesCount, subsCount, archivedSubsCount, filmsCount, releasedFilmsCount] =
            await Promise.all([
                Chat.count(),
                Series.count(),
                Subscription.count(),
                Subscription.count({
                    include: [{ model: Series, attributes: [], required: true }],
                    where: { '$Series.status$': { [Op.in]: FINISHED_SERIES_STATUSES } }
                }),
                Watchlist.count(),
                // Released films stay in the table as a record of what was announced
                Watchlist.count({ where: { notified: true } })
            ]);
        // A null (not yet checked) status counts as active, hence the subtraction
        const activeSubsCount = subsCount - archivedSubsCount;
        const activeFilmsCount = filmsCount - releasedFilmsCount;
        res.json({
            ...(await recentChanges()),
            chatsCount,
            seriesCount,
            subsCount,
            activeSubsCount,
            archivedSubsCount,
            filmsCount,
            activeFilmsCount,
            releasedFilmsCount
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/api/stats/popular', async (req, res) => {
    try {
        const popular = await Subscription.findAll({
            attributes: [
                'seriesId',
                [Subscription.sequelize.fn('COUNT', Subscription.sequelize.col('chatId')), 'subCount']
            ],
            group: ['seriesId'],
            order: [[Subscription.sequelize.literal('subCount'), 'DESC']],
            limit: 5,
            include: [{ model: Series }]
        });
        res.json(popular);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// The commit checked out on the server, so the dashboard shows what is deployed
router.get('/api/version', (req, res) => res.json(getVersion()));

// The update check: running now, how the last one went, when the next one fires
router.get('/api/cron', (req, res) => res.json(getCronStatus()));

// The panel shows five; a few spare cover the ones it drops as already past
const UPCOMING_LIMIT = 10;
const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * The nearest episodes and film releases, soonest first, however far off. Starts a day
 * back: the server runs in UTC, and the panel drops what is already past in its own
 * time zone. Only titles someone still waits for: series with an active subscription,
 * films not yet announced.
 */
router.get('/api/upcoming', async (req, res) => {
    try {
        const from = isoDay(new Date(Date.now() - 24 * 60 * 60 * 1000));

        const [series, films] = await Promise.all([
            Series.findAll({
                where: { next_episode_date: { [Op.gte]: from } },
                include: [{ model: Chat, attributes: ['id'], through: { attributes: [] }, required: true }]
            }),
            Watchlist.findAll({
                where: { notified: false, premiere_digital: { [Op.gte]: from } },
                attributes: ['tmdb_id', 'title', 'premiere_digital', 'chatId']
            })
        ]);

        const items = series
            .filter((s) => !isFinishedStatus(s.status))
            .map((s) => ({
                kind: 'tv',
                id: s.tmdb_id,
                title: s.title,
                date: s.next_episode_date,
                episode:
                    s.next_episode_season !== null && s.next_episode_number !== null
                        ? `S${s.next_episode_season}E${s.next_episode_number}`
                        : null,
                chats: s.Chats.length
            }));

        // One line per film, however many chats wait for it
        const byFilm = new Map();
        for (const w of films) {
            const id = w.tmdb_id;
            const entry = byFilm.get(id) || {
                kind: 'movie',
                id,
                title: w.title,
                date: w.premiere_digital,
                chats: new Set()
            };
            entry.chats.add(String(w.chatId));
            byFilm.set(id, entry);
        }
        for (const f of byFilm.values()) items.push({ ...f, chats: f.chats.size });

        items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.title.localeCompare(b.title)));
        res.json(items.slice(0, UPCOMING_LIMIT));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
