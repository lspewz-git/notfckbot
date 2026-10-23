/**
 * How many episodes of each tracked series aired in each month, and how long they ran, for the
 * chats' statistics (src/chat-stats.js). Filled once per series from every season's episode list;
 * after that the update check looks again at a season that has a new episode (one request).
 *
 * Stored on the series as "2026-03:2=4/180,3=1/45;2026-04:3=3/135": the month, then for each
 * season its episodes and their minutes.
 */
const { Series } = require('../db');
const { getDetailsCached, getSeasonDetails, titleFacts } = require('../api/tmdb');
const { log } = require('../log');

/** "2026-03:2=4/180" → Map { "2026-03" → Map { 2 → { count: 4, minutes: 180 } } } */
function parseAired(value) {
    const byMonth = new Map();
    for (const part of (value || '').split(';')) {
        const [month, seasons = ''] = part.split(':');
        if (!/^\d{4}-\d{2}$/.test(month)) continue;
        const bySeason = new Map();
        for (const item of seasons.split(',')) {
            const match = /^(\d+)=(\d+)\/(\d+)$/.exec(item);
            if (match) bySeason.set(Number(match[1]), { count: Number(match[2]), minutes: Number(match[3]) });
        }
        if (bySeason.size) byMonth.set(month, bySeason);
    }
    return byMonth;
}

/** The reverse of parseAired: months and seasons sorted. */
function formatAired(byMonth) {
    return [...byMonth.keys()]
        .sort()
        .filter((month) => byMonth.get(month).size)
        .map((month) => {
            const bySeason = byMonth.get(month);
            const seasons = [...bySeason.keys()].sort((a, b) => a - b);
            return `${month}:${seasons.map((n) => `${n}=${bySeason.get(n).count}/${bySeason.get(n).minutes}`).join(',')}`;
        })
        .join(';');
}

/**
 * A season's aired episodes by month: { "2026-03" → { count, minutes } }. An episode without a
 * runtime counts the series' usual length (`runtime`), or nothing when that is unknown too.
 */
function seasonMonths(season, runtime, now = new Date()) {
    const byMonth = new Map();
    for (const episode of (season && season.episodes) || []) {
        const date = episode.air_date && new Date(episode.air_date);
        if (!date || isNaN(date.getTime()) || date > now) continue;
        const month = episode.air_date.slice(0, 7);
        const total = byMonth.get(month) || { count: 0, minutes: 0 };
        total.count += 1;
        total.minutes += Number(episode.runtime) || runtime || 0;
        byMonth.set(month, total);
    }
    return byMonth;
}

/** Puts one season's months in place of what was stored for it. */
function replaceSeason(byMonth, seasonNumber, months) {
    for (const bySeason of byMonth.values()) bySeason.delete(seasonNumber);
    for (const [month, total] of months) {
        if (!byMonth.has(month)) byMonth.set(month, new Map());
        byMonth.get(month).set(seasonNumber, total);
    }
}

/** The season to read again: the one whose latest aired episode isn't the one stored yet. */
function seasonsToRescan(series, details) {
    const last = details && details.last_episode_to_air;
    if (!last || !last.season_number) return [];
    const moved = last.season_number !== series.last_season || last.episode_number !== series.last_episode;
    return moved ? [last.season_number] : [];
}

/**
 * Brings a series' aired episodes up to date. The first time, every season (no specials);
 * afterwards only `seasons`, those with a new episode. A failed scan leaves the column as it was.
 * @param {{ tmdb_id: string, aired_episodes: string | null, runtime?: number | null, update: Function }} series
 * @param {object} details TMDB series details
 * @param {number[]} [seasons]
 */
async function ensureAiredEpisodes(series, details, seasons = [], now = new Date()) {
    const first = series.aired_episodes === null || series.aired_episodes === undefined;
    const todo = first
        ? (details.seasons || []).filter((s) => s.season_number && s.episode_count).map((s) => s.season_number)
        : [...new Set(seasons)].filter(Boolean);
    if (!todo.length && !first) return;
    const numericId = String(series.tmdb_id).replace('tv_', '');
    const runtime = series.runtime || titleFacts(details, 'tv').runtime;
    const byMonth = first ? new Map() : parseAired(series.aired_episodes);
    for (const number of todo) {
        const season = await getSeasonDetails(numericId, number);
        replaceSeason(byMonth, number, seasonMonths(season, runtime, now));
    }
    const value = formatAired(byMonth);
    if (value !== series.aired_episodes) await series.update({ aired_episodes: value });
}

/**
 * After a start, in the background, for every series that hasn't had one: the full scan, and
 * what the series is (genres, channel) when that isn't stored yet. About one request per season.
 */
async function backfillAiredEpisodes() {
    const pending = await Series.findAll({ where: { aired_episodes: null } });
    let failed = 0;
    for (const series of pending) {
        try {
            const details = await getDetailsCached(String(series.tmdb_id).replace('tv_', ''), 'tv');
            if (!series.genres) await series.update(titleFacts(details, 'tv'));
            await ensureAiredEpisodes(series, details);
        } catch (err) {
            failed += 1;
            log.error(`[Stats] Aired episodes for ${series.tmdb_id} failed: ${err.message}`);
        }
    }
    if (pending.length) {
        log.info(`[Stats] Aired episodes filled for ${pending.length - failed} of ${pending.length} series`);
    }
}

module.exports = { ensureAiredEpisodes, seasonsToRescan, backfillAiredEpisodes, parseAired, formatAired, seasonMonths };
