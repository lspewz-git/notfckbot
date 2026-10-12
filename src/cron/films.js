/** The watchlist half of the update check: tell each chat when its film is out. */
const { Chat, Watchlist } = require('../db');
const { getDetails } = require('../api/tmdb');
const { findKinopoiskId } = require('../api/kinopoisk');
const { formatWatchLinks } = require('../constants');
const { buildFilmMessage } = require('./messages');
const { tally } = require('./status');

/** Out once TMDB says Released, or once its release date has passed. */
const isMovieReleased = (data, now = new Date()) => {
    if (data.status === 'Released') return true;
    if (!data.release_date) return false;
    const releaseDate = new Date(data.release_date);
    return !isNaN(releaseDate) && releaseDate <= now;
};

const checkWatchlistReleases = async (bot) => {
    // Load all unnotified watchlist entries with their chat
    const entries = await Watchlist.findAll({
        where: { notified: false },
        include: [{ model: Chat }]
    });

    if (entries.length === 0) return;
    console.log(`[Cron] Checking ${entries.length} watchlist movie(s)...`);

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
            for (const entry of filmEntries) {
                const changes = {};
                if (entry.premiere_digital !== freshDate) changes.premiere_digital = freshDate;
                if (freshYear && entry.year !== freshYear) changes.year = freshYear;
                if (freshTitle && entry.title !== freshTitle) changes.title = freshTitle;
                if (Object.keys(changes).length) await entry.update(changes);
            }

            if (!isMovieReleased(data, now)) {
                console.log(`[Cron] Movie "${firstEntry.title}" (${tmdb_id}): not released yet.`);
                continue;
            }

            // 🎉 Film is released! Notify all users waiting for it
            console.log(`[Cron] Movie "${firstEntry.title}" (${tmdb_id}) is now available!`);
            // A release happens once per film, so the ID is looked up here rather than ahead of time
            const kinopoiskId = await findKinopoiskId(`movie_${filmId}`, data.imdb_id);
            const links = formatWatchLinks({ title: firstEntry.title, kinopoiskId, mediaType: 'movie' });

            for (const entry of filmEntries) {
                try {
                    const msg = buildFilmMessage({ entry, data, links, now });

                    if (entry.poster_url) {
                        await bot.telegram.sendPhoto(entry.Chat.id, entry.poster_url, {
                            caption: msg,
                            parse_mode: 'HTML'
                        });
                    } else {
                        await bot.telegram.sendMessage(entry.Chat.id, msg, {
                            parse_mode: 'HTML',
                            disable_web_page_preview: false
                        });
                    }
                    tally('sent');
                } catch (err) {
                    tally('failed');
                    console.error(`[Cron] Failed to notify watchlist chat ${entry.Chat.id}:`, err.message);
                }

                // Mark as notified so we don't send again
                await entry.update({ notified: true });
            }
        } catch (err) {
            tally('errors');
            console.error(`[Cron] Error checking watchlist movie ${tmdb_id}:`, err.message);
        }
    }
};

module.exports = { checkWatchlistReleases, isMovieReleased };
