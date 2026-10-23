/** The watchlist half of the update check: tell each chat when its film is out. */
const { Chat, Watchlist } = require('../db');
const { getDetails, getDetailsCached, titleFacts } = require('../api/tmdb');
const { findKinopoiskId, russianDates } = require('../api/kinopoisk');
const { formatWatchLinks } = require('../constants');
const { buildFilmMessage, heldLine } = require('./messages');
const { tally } = require('./status');
const { notify } = require('./outbox');
const { log } = require('../log');

/** Out once TMDB says Released, or once its release date has passed. */
const isMovieReleased = (data, now = new Date()) => {
    if (data.status === 'Released') return true;
    if (!data.release_date) return false;
    const releaseDate = new Date(data.release_date);
    return !isNaN(releaseDate) && releaseDate <= now;
};

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

const checkWatchlistReleases = async (bot) => {
    // Load all unnotified watchlist entries with their chat
    const entries = await Watchlist.findAll({
        where: { notified: false },
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
            const freshDate = data.release_date || null;
            const freshYear = freshDate ? parseInt(freshDate.slice(0, 4), 10) : null;
            // Titles change too, e.g. "Мстители: Судный день" -> "Мстители: Доктор Дум"
            const freshTitle = data.title || null;
            const facts = titleFacts(data, 'movie');
            for (const entry of filmEntries) {
                const changes = {};
                if (entry.premiere_digital !== freshDate) changes.premiere_digital = freshDate;
                if (freshYear && entry.year !== freshYear) changes.year = freshYear;
                if (freshTitle && entry.title !== freshTitle) changes.title = freshTitle;
                if ((entry.digital_date || null) !== (data.digital_release_date || null))
                    changes.digital_date = data.digital_release_date || null;
                if ((entry.digital_country || null) !== (data.digital_release_country || null))
                    changes.digital_country = data.digital_release_country || null;
                for (const [k, v] of Object.entries(facts))
                    if (String(entry[k] ?? '') !== String(v ?? '')) changes[k] = v;
                if (Object.keys(changes).length) await entry.update(changes);
            }

            await keepRussianDates(filmEntries, `movie_${filmId}`, data.imdb_id, now);

            if (!isMovieReleased(data, now)) {
                log.info(`[Cron] Movie "${firstEntry.title}" (${tmdb_id}): not released yet.`);
                continue;
            }

            // 🎉 Film is released! Notify all users waiting for it
            log.info(`[Cron] Movie "${firstEntry.title}" (${tmdb_id}) is now available!`);
            // A release happens once per film, so the ID is looked up here rather than ahead of time
            const kinopoiskId = await findKinopoiskId(`movie_${filmId}`, data.imdb_id);
            const links = formatWatchLinks({ title: firstEntry.title, kinopoiskId, mediaType: 'movie' });
            // The Russian dates as kept just above: a Kinopoisk failing now doesn't drop them
            const ru = {
                premiere: firstEntry.ru_premiere || null,
                digital: firstEntry.ru_digital || null,
                services: firstEntry.ru_services ? firstEntry.ru_services.split(', ') : []
            };

            for (const entry of filmEntries) {
                const msg = buildFilmMessage({ entry, data, links, now, ru });
                // A message that doesn't go out is queued by notify(), so the film counts as
                // announced either way
                await notify(bot, entry.Chat.id, msg, {
                    photo: entry.poster_url,
                    about: entry.title,
                    event: { detail: 'film', tmdb_id: entry.tmdb_id, title: entry.title },
                    ...heldLine({ kind: 'film', title: entry.title })
                });
                await entry.update({ notified: true });
            }
        } catch (err) {
            tally('errors');
            log.error(`[Cron] Error checking watchlist movie ${tmdb_id}: ${err.message}`);
        }
    }
};

/**
 * After a start, in the background: what each film is (genres, rating, length) for the chats'
 * statistics, where it isn't stored yet. Films already out are no longer looked at by the check.
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

module.exports = { checkWatchlistReleases, isMovieReleased, backfillFilmFacts };
