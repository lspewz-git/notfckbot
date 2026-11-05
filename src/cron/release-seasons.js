/**
 * The release year of each season: at least 70% of all its episodes must have aired
 * in that year. An exact 50/50 split belongs to the premiere year. Rebuilt from saved monthly
 * counts at startup and after episode checks.
 *
 * Stored on the series as "2023:1;2024:2;2025:3": year, then the qualifying seasons.
 */
const { Series } = require('../db');
const { getSeasonDetails } = require('../api/tmdb');
const { backfillSeries } = require('./series-backfill');
const { parseAired } = require('./aired-episodes');

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

/** At least 70% of a season owns the year; an exact 50/50 split uses the premiere year. */
function majorityYear(counts, total, premiereYear = null) {
    if (!(total > 0)) return null;
    const denominator = Math.max(
        total,
        [...counts.values()].reduce((sum, count) => sum + count, 0)
    );
    for (const [year, count] of counts) if (count * 10 >= denominator * 7) return year;
    // A fully aired season split evenly between two years belongs to its premiere year.
    if (counts.size === 2 && [...counts.values()].every((count) => count * 2 === denominator)) {
        return premiereYear || Math.min(...counts.keys());
    }
    return null;
}

/** The saved monthly episode counts avoid another TMDB request for each season. */
function majoritySeasons(aired, details, now) {
    const counts = new Map();
    for (const [month, seasons] of parseAired(aired)) {
        if (month > now.toISOString().slice(0, 7)) continue;
        const year = Number(month.slice(0, 4));
        for (const [season, { count }] of seasons) {
            if (!counts.has(season)) counts.set(season, new Map());
            const years = counts.get(season);
            years.set(year, (years.get(year) || 0) + count);
        }
    }
    const byYear = new Map();
    for (const season of details.seasons || []) {
        if (!season.season_number) continue;
        const year = majorityYear(
            counts.get(season.season_number) || new Map(),
            season.episode_count,
            airedYear(season.air_date, now)
        );
        if (year) addSeason(byYear, year, season.season_number);
    }
    return byYear;
}

/** Fallback for a title whose monthly counts have not been filled yet. */
async function scanReleaseSeasons(numericId, details, now) {
    const byYear = new Map();
    for (const season of details.seasons || []) {
        if (!season.season_number || !season.episode_count) continue;
        const data = await getSeasonDetails(numericId, season.season_number);
        const counts = new Map();
        for (const episode of (data && data.episodes) || []) {
            const year = airedYear(episode.air_date, now);
            if (year) counts.set(year, (counts.get(year) || 0) + 1);
        }
        const year = majorityYear(
            counts,
            Math.max(season.episode_count, data?.episodes?.length || 0),
            airedYear(season.air_date, now)
        );
        if (year) addSeason(byYear, year, season.season_number);
    }
    return byYear;
}

/**
 * Rebuilds a series' release seasons from episode counts and the known full season sizes.
 * Without monthly counts, scans the season lists; a failed scan leaves the old index intact.
 * @param {{ tmdb_id: string, release_seasons: string | null, update: Function }} series
 * @param {object} details TMDB series details
 */
async function ensureReleaseSeasons(series, details, now = new Date()) {
    const byYear =
        series.aired_episodes != null
            ? majoritySeasons(series.aired_episodes, details, now)
            : await scanReleaseSeasons(String(series.tmdb_id).replace('tv_', ''), details, now);
    const value = formatSeasons(byYear);
    if (value !== series.release_seasons) await series.update({ release_seasons: value });
}

/** After a start, rebuild all derived years, including values stored under an older rule. */
async function backfillReleaseSeasons() {
    const pending = await Series.findAll();
    await backfillSeries(pending, '[History] Release seasons', ensureReleaseSeasons);
}

module.exports = { ensureReleaseSeasons, backfillReleaseSeasons, parseSeasons, formatSeasons, airedYear };
