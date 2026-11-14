/** The watchlist half of the update check: tell each chat when its film is out. */
const { Chat, Watchlist } = require('../db');
const { getDetails, getDetailsCached, titleFacts, tmdbPoster } = require('../api/tmdb');
const { findKinopoiskId, russianDates } = require('../api/kinopoisk');
const { formatWatchLinks } = require('../constants');
const { buildFilmMessage, buildDigitalMessage, heldLine } = require('./messages');
const { isReleased, isOnline, storedDates, initialReleaseState, RELEASE_RULE_VERSION } = require('../film-release');
const { todayIn } = require('../calendar');
const { tally } = require('./status');
const { notify } = require('./outbox');
const { log } = require('../log');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Kinopoisk's Russian dates onto the film's rows, at most once a day (the quota). A failed
 * lookup leaves what is stored and is tried on the next check.
 */
async function keepRussianDates(entries, tmdbId, imdbId, now) {
    const due = entries.some((e) => !e.ru_checked_at || now - new Date(e.ru_checked_at) >= DAY_MS);
    if (!due) return;
    const kinopoiskId = await findKinopoiskId(tmdbId, imdbId).catch(() => null);
    const ru = await russianDates(kinopoiskId);
    if (ru.failed) return;
    const fields = {
        ru_premiere: ru.premiere,
        ru_digital: ru.digital,
        ru_services: ru.services.length ? ru.services.join(', ') : null,
        ru_checked_at: now
    };
    for (const entry of entries) await entry.update(fields);
}

const checkWatchlistReleases = async (bot, { datesOnly = false } = {}) => {
    // Released rows still need fresh dates and may be waiting for an independent digital alert.
    const entries = await Watchlist.findAll({
        include: [{ model: Chat }]
    });

    if (entries.length === 0) return;
    log.info(`[Cron] Checking ${entries.length} watchlist movie(s)...`);

    const now = new Date();

    // Group by tmdb_id to batch API calls (multiple users may watch same movie)
    const byFilm = {};
    for (const entry of entries) {
        if (!byFilm[entry.tmdb_id]) byFilm[entry.tmdb_id] = [];
        byFilm[entry.tmdb_id].push(entry);
    }

    for (const [tmdb_id, filmEntries] of Object.entries(byFilm)) {
        tally('films');
        try {
            const [mediaType, filmId] = tmdb_id.split('_');
            const data = await getDetails(filmId, mediaType);
            if (!data) continue;

            const firstEntry = filmEntries[0];

            // The date was stored once, when the film was added — often before TMDB had
            // one. Keep it (and the year) current so the panel and the bot can show it.
            const freshDate = storedDates(data).premiere_digital;
            const freshYear = freshDate ? parseInt(freshDate.slice(0, 4), 10) : null;
            // Titles change too, e.g. "Мстители: Судный день" -> "Мстители: Доктор Дум"
            const freshTitle = data.title || null;
            // Reuse the details response; missing artwork must not erase a stored poster.
            const freshPoster = tmdbPoster(data.poster_path);
            const facts = titleFacts(data, 'movie');
            for (const entry of filmEntries) {
                const changes = {};
                if (freshYear && entry.year !== freshYear) changes.year = freshYear;
                if (freshTitle && entry.title !== freshTitle) changes.title = freshTitle;
                if (freshPoster && entry.poster_url !== freshPoster) changes.poster_url = freshPoster;
                for (const [k, v] of Object.entries(facts))
                    if (String(entry[k] ?? '') !== String(v ?? '')) changes[k] = v;
                if (Object.keys(changes).length) await entry.update(changes);
            }

            await keepRussianDates(filmEntries, `movie_${filmId}`, data.imdb_id, now);

            // The Russian dates as kept just above: a Kinopoisk failing now doesn't drop them
            const ru = {
                premiere: firstEntry.ru_premiere || null,
                digital: firstEntry.ru_digital || null,
                services: firstEntry.ru_services ? firstEntry.ru_services.split(', ') : []
            };
            // The cinema and online dates for the calendar and the cards, current on every check
            const stored = storedDates(data, ru);
            for (const entry of filmEntries) {
                const changes = Object.fromEntries(
                    Object.entries(stored).filter(
                        ([k, v]) =>
                            (entry[k] ?? null) !== v &&
                            !(k === 'online_estimate' && Boolean(entry[k]) === v) &&
                            !(
                                entry.notified &&
                                !stored.premiere_digital &&
                                ['premiere_digital', 'cinema_date', 'cinema_country', 'release_countries'].includes(k)
                            )
                    )
                );
                if (stored.premiere_digital) changes.year = Number(stored.premiere_digital.slice(0, 4));
                if (Object.keys(changes).length) await entry.update(changes);
            }
            // Looked up only when a message is due, once per film
            let kinopoiskId;
            const linksFor = async (watch) => {
                if (kinopoiskId === undefined) kinopoiskId = await findKinopoiskId(`movie_${filmId}`, data.imdb_id);
                return formatWatchLinks({ title: firstEntry.title, kinopoiskId, mediaType: 'movie', watch });
            };

            // Each chat uses its own day. The first successful refresh of a legacy row is silent.
            // A message that doesn't go out is queued by notify(), so it counts as sent either way
            const migrated = new Set();
            const byChat = new Map();
            for (const entry of filmEntries) {
                if (!entry.Chat) continue;
                if ((entry.release_rule_version || 0) < RELEASE_RULE_VERSION) {
                    await entry.update(initialReleaseState(data, ru, todayIn(entry.Chat.timezone, now), entry));
                    migrated.add(entry);
                }
                const key = String(entry.Chat.id);
                if (!byChat.has(key)) byChat.set(key, []);
                byChat.get(key).push(entry);
            }
            for (const group of byChat.values()) {
                const active = group.filter((entry) => !migrated.has(entry));
                if (datesOnly || !active.length) continue;
                const entry = active[0];
                const updateGroup = async (fields) => {
                    for (const row of group) await row.update(fields);
                };
                const today = todayIn(entry.Chat.timezone, now);
                const online = isOnline(data, ru, today);
                if (active.some((row) => !row.notified) && isReleased(data, ru, today)) {
                    log.info(`[Cron] Movie "${entry.title}" (${tmdb_id}) released for chat ${entry.Chat.id}`);
                    const msg = buildFilmMessage({ entry, data, links: await linksFor(online), now, today, ru });
                    await notify(bot, entry.Chat.id, msg, {
                        photo: entry.poster_url,
                        about: entry.title,
                        event: { detail: 'film', tmdb_id: entry.tmdb_id, title: entry.title },
                        ...heldLine({ kind: 'film', title: entry.title })
                    });
                    // A same-day digital event is included in this message, without a second alert.
                    await updateGroup({ notified: true, ...(online ? { digital_notified: true } : {}) });
                }
                if (!online || active.every((row) => row.digital_notified)) continue;
                const since = entry.Chat.digital_since || today;
                if (!entry.Chat.notify_digital || stored.online_date < since) {
                    await updateGroup({ digital_notified: true });
                    continue;
                }
                const msg = buildDigitalMessage({ entry, data, ru, links: await linksFor(true) });
                await notify(bot, entry.Chat.id, msg, {
                    photo: entry.poster_url,
                    about: entry.title,
                    event: { detail: 'film_digital', tmdb_id: entry.tmdb_id, title: entry.title },
                    ...heldLine({ kind: 'digital', title: entry.title })
                });
                await updateGroup({ digital_notified: true });
            }
        } catch (err) {
            tally('errors');
            log.error(`[Cron] Error checking watchlist movie ${tmdb_id}: ${err.message}`);
        }
    }
};

/**
 * After a start, in the background: what each film is (genres, rating, length) for the chats'
 * statistics, where it isn't stored yet. The regular check also refreshes already released films.
 */
async function backfillFilmFacts() {
    const entries = await Watchlist.findAll({ where: { genres: null } });
    const byFilm = new Map();
    for (const entry of entries) byFilm.set(entry.tmdb_id, [...(byFilm.get(entry.tmdb_id) || []), entry]);
    let failed = 0;
    for (const [tmdbId, rows] of byFilm) {
        try {
            const details = await getDetailsCached(tmdbId.split('_')[1], 'movie');
            const facts = titleFacts(details, 'movie');
            for (const row of rows) await row.update(facts);
        } catch (err) {
            failed += 1;
            log.error(`[Stats] Film facts for ${tmdbId} failed: ${err.message}`);
        }
    }
    if (byFilm.size) log.info(`[Stats] Film facts filled for ${byFilm.size - failed} of ${byFilm.size} films`);
}

module.exports = { checkWatchlistReleases, backfillFilmFacts };
