/**
 * The years in which each tracked series had an episode out, and which seasons those episodes
 * belonged to, for the release history. Filled once per series from every season's episode list;
 * after that the update check adds the latest aired episode it sees, which costs no extra request.
 *
 * Stored on the series as "2023:1;2024:2;2025:2,3": year, then the seasons aired in it.
 */
const { Series } = require('../db');
const { getDetailsCached, getSeasonDetails } = require('../api/tmdb');

/** "2024:2;2025:2,3" → Map { 2024 → [2], 2025 → [2, 3] } */
function parseSeasons(value) {
    const byYear = new Map();
    for (const part of (value || '').split(';')) {
        const [year, seasons = ''] = part.split(':');
        if (!Number(year)) continue;
        byYear.set(Number(year), seasons.split(',').map(Number).filter(Boolean));
    }
    return byYear;
}

/** The reverse of parseSeasons: years and seasons sorted, no repeats. */
function formatSeasons(byYear) {
    return [...byYear.keys()]
        .sort((a, b) => a - b)
        .map((year) => `${year}:${[...new Set(byYear.get(year))].sort((a, b) => a - b).join(',')}`)
        .join(';');
}

/** The year of an air date that has passed, else null (not aired yet, or no date). */
function airedYear(date, now = new Date()) {
    if (!date) return null;
    const d = new Date(date);
    return !isNaN(d.getTime()) && d <= now ? d.getUTCFullYear() : null;
}

function addSeason(byYear, year, season) {
    if (!byYear.has(year)) byYear.set(year, []);
    if (!byYear.get(year).includes(season)) byYear.get(year).push(season);
}

/** Every year with an aired episode, with its seasons: one TMDB request per season (no specials). */
async function scanReleaseSeasons(numericId, details, now) {
    const byYear = new Map();
    for (const season of details.seasons || []) {
        if (!season.season_number || !season.episode_count) continue;
        const data = await getSeasonDetails(numericId, season.season_number);
        for (const episode of (data && data.episodes) || []) {
            const year = airedYear(episode.air_date, now);
            if (year) addSeason(byYear, year, season.season_number);
        }
    }
    return byYear;
}

/**
 * Brings a series' release seasons up to date. The first time, a full scan; afterwards only
 * `details.last_episode_to_air`. A failed scan leaves the column null, so it is retried.
 * @param {{ tmdb_id: string, release_seasons: string | null, update: Function }} series
 * @param {object} details TMDB series details
 */
async function ensureReleaseSeasons(series, details, now = new Date()) {
    if (series.release_seasons === null || series.release_seasons === undefined) {
        const numericId = String(series.tmdb_id).replace('tv_', '');
        const byYear = await scanReleaseSeasons(numericId, details, now);
        await series.update({ release_seasons: formatSeasons(byYear) });
        return;
    }
    const last = details.last_episode_to_air;
    const year = airedYear(last && last.air_date, now);
    if (!year || !last.season_number) return;
    const byYear = parseSeasons(series.release_seasons);
    if ((byYear.get(year) || []).includes(last.season_number)) return;
    addSeason(byYear, year, last.season_number);
    await series.update({ release_seasons: formatSeasons(byYear) });
}

/** After a start, in the background: the full scan for every series that hasn't had one. */
async function backfillReleaseSeasons() {
    const pending = await Series.findAll({ where: { release_seasons: null } });
    let failed = 0;
    for (const series of pending) {
        try {
            const details = await getDetailsCached(String(series.tmdb_id).replace('tv_', ''), 'tv');
            await ensureReleaseSeasons(series, details);
        } catch (err) {
            failed += 1;
            console.error(`[History] Release seasons for ${series.tmdb_id} failed:`, err.message);
        }
    }
    if (pending.length) {
        console.log(`[History] Release seasons filled for ${pending.length - failed} of ${pending.length} series`);
    }
}

module.exports = { ensureReleaseSeasons, backfillReleaseSeasons, parseSeasons, formatSeasons, airedYear };
