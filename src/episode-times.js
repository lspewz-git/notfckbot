/**
 * When a series' episodes come out: TVmaze's moment (src/api/tvmaze.js) for an episode TMDB also
 * lists, TMDB's day otherwise. Names, numbering and everything else stay TMDB's.
 *
 * An episode takes TVmaze's time only when its TVmaze day is within a day of TMDB's: further
 * apart, the two number the episodes differently and TMDB's day stays. It counts as out once its
 * TVmaze moment plus its length (an hour when unknown) has passed.
 *
 * `withTvmaze()` rewrites TMDB's details (last_episode_to_air, next_episode_to_air) by these
 * times, so whatever reads them — the update check's notifications, a new subscription's start,
 * the next-episode columns, the statistics — goes by TVmaze where it knows the episode.
 */
const { getSeasonDetailsCached } = require('./api/tmdb');
const tvmaze = require('./api/tvmaze');
const { zoneOf, DEFAULT_ZONE } = require('./quiet');

const MAX_SHIFT_DAYS = 1;
const DEFAULT_RUNTIME_MIN = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" of a moment in a time zone */
const dayIn = (ms, zoneId) =>
    new Intl.DateTimeFormat('en-CA', {
        timeZone: zoneOf(zoneId).id,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date(ms));

const daysApart = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;

/**
 * TVmaze's time for a TMDB episode, when it is the same episode; else null.
 * @param {Record<string, import('./api/tvmaze').EpisodeTime> | null | undefined} times
 * @param {string | null | undefined} tmdbDate TMDB's air date. Without one there is nothing to
 *   check the numbers against: TMDB lists a new season's later episodes undated, and where TVmaze
 *   numbers differently (anime, split seasons) "2:5" there may have aired a year ago — so no match
 */
function timeOf(times, season, episode, tmdbDate) {
    const time = times && times[`${season}:${episode}`];
    if (!time || !tmdbDate) return null;
    const day = time.date || (time.stamp !== null ? dayIn(time.stamp, 'UTC') : null);
    if (!day || daysApart(day, tmdbDate) > MAX_SHIFT_DAYS) return null;
    return time;
}

/**
 * The chat-local day it comes out ("YYYY-MM-DD"). Without a time of day (streaming: TVmaze's
 * stamp is a 12:00 UTC stand-in, 00:00 the next day in Kamchatka) its own day, not the stamp's.
 */
const releaseDay = (time, zoneId) =>
    time.stamp !== null && (time.timed !== false || !time.date) ? dayIn(time.stamp, zoneId) : time.date;

/** The moment it counts as out (ms): aired in full; a bare day, once that day is over everywhere */
const outAt = (time) =>
    time.stamp !== null
        ? time.stamp + (time.runtime || DEFAULT_RUNTIME_MIN) * 60 * 1000
        : Date.parse(`${time.date}T00:00:00Z`) + DAY_MS + 12 * 60 * 60 * 1000;

const order = (season, episode) => season * 100000 + episode;

/**
 * TMDB's details with last_episode_to_air and next_episode_to_air going by TVmaze's times where
 * TVmaze knows the episodes: an episode out by TVmaze is the last aired even before TMDB moves it
 * (and never earlier than TMDB's own last); the next one carries its TVmaze day in the default
 * zone. The episodes come from TMDB's season lists (names in Russian), the seasons of TMDB's last
 * and next episodes. Unchanged without times. Never throws: a season TMDB doesn't answer for is
 * left out.
 * @param {object} details TMDB's series details
 * @param {Record<string, import('./api/tvmaze').EpisodeTime> | null} times
 * @param {number} [now]
 * @param {string | null} [zoneId] the next episode's day in this zone (default: the bot's)
 */
async function withTvmaze(details, times, now = Date.now(), zoneId = DEFAULT_ZONE) {
    if (!details || !times) return details;
    const last = details.last_episode_to_air || null;
    const next = details.next_episode_to_air || null;
    const seasons = [...new Set([last, next].filter(Boolean).map((e) => e.season_number))].filter((s) => s > 0);
    if (!seasons.length) return details;
    const numericId = String(details.id);
    const episodes = [];
    for (const season of seasons) {
        const data = await getSeasonDetailsCached(numericId, season).catch(() => null);
        for (const ep of (data && data.episodes) || []) episodes.push({ ...ep, season_number: season });
    }
    if (!episodes.length) return details;
    episodes.sort((a, b) => order(a.season_number, a.episode_number) - order(b.season_number, b.episode_number));

    let newLast = last;
    for (const ep of episodes) {
        const time = timeOf(times, ep.season_number, ep.episode_number, ep.air_date);
        const out = time ? outAt(time) <= now : false;
        const later =
            !newLast ||
            order(ep.season_number, ep.episode_number) > order(newLast.season_number, newLast.episode_number);
        if (out && later) newLast = ep;
    }
    const after = newLast ? order(newLast.season_number, newLast.episode_number) : -1;
    let newNext = null;
    for (const ep of episodes) {
        if (order(ep.season_number, ep.episode_number) <= after) continue;
        const time = timeOf(times, ep.season_number, ep.episode_number, ep.air_date);
        const airDate = time ? releaseDay(time, zoneId) : ep.air_date;
        if (!airDate) continue;
        newNext = { ...ep, air_date: airDate };
        break;
    }
    // TMDB's next lies past the seasons read (a season not listed yet): kept as it is
    if (!newNext && next && order(next.season_number, next.episode_number) > after) newNext = next;
    return { ...details, last_episode_to_air: newLast, next_episode_to_air: newNext };
}

/**
 * withTvmaze() for something shown at once (a card, a new subscription): TVmaze's cached times,
 * else what it answers within a few seconds, else TMDB's details as they are.
 * @param {string | null} [zoneId]
 */
async function withTvmazeQuick(details, zoneId = DEFAULT_ZONE) {
    if (!details || details.id == null) return details;
    const deadline = tvmaze.viewDeadline();
    try {
        const times = await tvmaze.airTimesQuick(`tv_${details.id}`, tvmaze.externalsOf(details), deadline);
        return await withTvmaze(details, times, Date.now(), zoneId);
    } finally {
        deadline.cancel();
    }
}

module.exports = { timeOf, releaseDay, outAt, withTvmaze, withTvmazeQuick, dayIn, MAX_SHIFT_DAYS };
