/**
 * The release history: for a year, the tracked series that had an episode out and the films that
 * came out, each with its genres and Kinopoisk link. For the whole database (the admin panel) or
 * for one chat's subscriptions and watchlist (the bot).
 */
const { Series, Subscription, Watchlist } = require('./db');
const { getDetailsCached } = require('./api/tmdb');
const { knownKinopoiskId } = require('./api/kinopoisk');
const { getWatchLinks } = require('./constants');
const { parseSeasons, airedYear } = require('./cron/release-seasons');

// Enough to tell a drama from a cartoon; TMDB lists the main genre first
const GENRES_SHOWN = 2;
// The history covers this year and the two before it: what was missed lately, not a show's
// whole run (a series on air since 1999 would otherwise bring 27 years of buttons)
const YEARS_KEPT = 3;

const byTitle = (a, b) => a.title.localeCompare(b.title, 'ru');

// The update check keeps the details cached; when TMDB is down and the cache has expired, the
// list comes without genres rather than after TMDB's 15-second timeout
const GENRES_WAIT_MS = 3000;

/** Genres in Russian, from the (usually cached) TMDB details; none if TMDB doesn't answer. */
async function genresOf(numericId, type) {
    let timer;
    try {
        const details = await Promise.race([
            getDetailsCached(numericId, type),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('TMDB is slow')), GENRES_WAIT_MS);
            })
        ]);
        return (details.genres || []).slice(0, GENRES_SHOWN).map((g) => g.name.toLowerCase());
    } catch {
        return [];
    } finally {
        clearTimeout(timer);
    }
}

/** A list entry: what the panel and the bot show for one title. */
async function entry({ tmdbId, title, kinopoiskId, seasons }) {
    const [type, numericId] = tmdbId.split('_');
    const mediaType = type === 'tv' ? 'tv' : 'movie';
    const id = kinopoiskId || knownKinopoiskId(tmdbId);
    const link = getWatchLinks({ title, kinopoiskId: id, mediaType }).find((l) => l.kind === 'info');
    const genres = await genresOf(numericId, mediaType);
    return { tmdbId, title, ...(seasons ? { seasons } : {}), genres, kinopoiskUrl: link.url };
}

/**
 * @param {{ chatId?: number | string | null, year?: number | null, now?: Date }} [options]
 *   chatId: one chat's titles only; year: which year (default: the latest one with releases).
 *   Only the last YEARS_KEPT years count.
 * @returns {Promise<{ years: number[], year: number | null, series: object[], films: object[] }>}
 *   years newest first; series and films sorted by title; a serial also has `seasons`
 */
async function releaseHistory({ chatId = null, year = null, now = new Date() } = {}) {
    const seriesRows = chatId
        ? (await Subscription.findAll({ where: { chatId }, include: [{ model: Series }] }))
              .map((s) => s.Series)
              .filter(Boolean)
        : await Series.findAll();
    const filmRows = await Watchlist.findAll({ where: chatId ? { chatId } : {} });

    // One film per title, whichever chats have it; a film counts in the year it came out
    const films = new Map();
    for (const f of filmRows) {
        const filmYear = airedYear(f.premiere_digital, now);
        if (filmYear && !films.has(f.tmdb_id))
            films.set(f.tmdb_id, { tmdbId: f.tmdb_id, title: f.title, year: filmYear });
    }
    const series = seriesRows.map((s) => ({
        tmdbId: s.tmdb_id,
        title: s.title,
        kinopoiskId: s.kinopoisk_id,
        byYear: parseSeasons(s.release_seasons)
    }));

    const oldest = now.getUTCFullYear() - (YEARS_KEPT - 1);
    const years = [
        ...new Set([...series.flatMap((s) => [...s.byYear.keys()]), ...[...films.values()].map((f) => f.year)])
    ]
        .filter((y) => y >= oldest)
        .sort((a, b) => b - a);
    const shown = years.includes(Number(year)) ? Number(year) : (years[0] ?? null);

    const [seriesOut, filmsOut] = await Promise.all([
        // A serial with the seasons that had episodes out that year
        Promise.all(
            series
                .filter((s) => shown !== null && s.byYear.has(shown))
                .map((s) => entry({ ...s, seasons: s.byYear.get(shown) }))
        ),
        Promise.all([...films.values()].filter((f) => shown !== null && f.year === shown).map(entry))
    ]);
    return { years, year: shown, series: seriesOut.sort(byTitle), films: filmsOut.sort(byTitle) };
}

module.exports = { releaseHistory };
