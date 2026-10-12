/** Dashboard figures: counters, most popular series, the update check, upcoming releases. */
const { Op } = require('sequelize');
const { Chat, Series, Subscription, Watchlist } = require('../../db');
const { getCronStatus } = require('../../cron');
const { getVersion } = require('../version');
const { FINISHED_STATUS_LABELS, isFinishedStatus } = require('../../constants');

const router = require('express').Router();

// TMDB statuses after which a show gets no new episodes. Subscriptions to such
// shows are "archived" — derived from Series.status alone, nothing is stored.
const FINISHED_SERIES_STATUSES = Object.keys(FINISHED_STATUS_LABELS);

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
