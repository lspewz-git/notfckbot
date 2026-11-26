/** TVmaze is authoritative for TV data; TMDB supplies Russian text and missing facts. */
const tvmaze = require('./tvmaze');
const { lruCache } = require('../lru');
const { UPDATE_INTERVAL_HOURS } = require('../constants');

const retained = lruCache({
    max: 500,
    maxSize: 16 * 1024 * 1024,
    sizeCalculation: (value) => Math.max(1, JSON.stringify(value).length * 2),
    ttl: (2 * UPDATE_INTERVAL_HOURS + 24) * 3600000
});
// Small identity markers outlive the bounded full snapshots. Expiring a snapshot must not
// silently reinterpret its episode cursor using another catalog's numbering.
const sources = lruCache({ max: 2000 });
const plain = (html) =>
    String(html || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .trim();
const localized = (text) => /[а-яё]/i.test(text || '') && !/^(эпизод|серия)\s*\d+$/i.test(text.trim());
const order = (e) => e.season_number * 100000 + e.episode_number;
const GENRES = {
    Action: 'Боевик',
    Adventure: 'Приключения',
    Anime: 'Аниме',
    Comedy: 'Комедия',
    Crime: 'Криминал',
    Drama: 'Драма',
    Espionage: 'Шпионский',
    Family: 'Семейный',
    Fantasy: 'Фэнтези',
    History: 'История',
    Horror: 'Ужасы',
    Medical: 'Медицина',
    Music: 'Музыка',
    Mystery: 'Детектив',
    Romance: 'Мелодрама',
    'Science-Fiction': 'Фантастика',
    Sports: 'Спорт',
    Supernatural: 'Сверхъестественное',
    Thriller: 'Триллер',
    War: 'Военный',
    Western: 'Вестерн'
};

const finaleKnown = (show, meta, eps) =>
    meta?.episodeOrder > 0
        ? eps.length >= meta.episodeOrder
        : Boolean(
              show.status === 'Ended' || show._embedded.seasons.some((s) => s.number > meta?.number && s.premiereDate)
          );
const episodeCount = (meta, episodes) => Math.max(Number(meta?.episodeOrder) || 0, episodes.length);

/** Optional localization must not hold the primary schedule behind a failing reserve. */
async function optional(promise, ms, fallback = null, deadline = null) {
    let timer;
    try {
        const waits = [
            Promise.resolve(promise).catch(() => fallback),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(fallback), ms);
            })
        ];
        if (deadline) waits.push(deadline.promise.then(() => fallback));
        return await Promise.race(waits);
    } finally {
        clearTimeout(timer);
    }
}

/** Seed a restart with the saved exact ID and localized title, without querying TMDB first. */
function seed(row) {
    if (!row?.tmdb_id || !row.tvmaze_id) return;
    const id = String(row.tmdb_id).replace('tv_', '');
    sources.set(id, 'tvmaze');
    if (retained.has(id)) return;
    retained.set(id, {
        id: Number(id),
        name: row.title,
        tvmaze_id: row.tvmaze_id,
        status: row.status,
        data_source: row.episode_source,
        poster_url: row.poster_url,
        origin_country: String(row.countries || '')
            .split(',')
            .filter(Boolean),
        episode_run_time: row.runtime > 0 ? [row.runtime] : [],
        vote_average: row.rating || 0,
        rating_source: row.rating_source || (row.episode_source === 'tvmaze' ? 'unknown' : 'tmdb'),
        genres: row.genres ? [{ name: row.genres }] : [],
        networks: row.networks ? [{ name: row.networks }] : [],
        seasons: [],
        tvmaze_primary: true,
        seed_only: true
    });
}

/** The catalog can change its classification; this never asserts a renewal/cancellation. */
function statusOf(show, fallback) {
    if (show.status === 'Ended') return 'Ended';
    if (show.status === 'Running' || show.status === 'To Be Determined') return 'Returning Series';
    if (show.status === 'In Development') return 'In Production';
    return fallback || null;
}

/** Localized text matches by original air date as well as number, never by number alone. */
function episode(ep, russian = null) {
    const matches = russian && russian.air_date && russian.air_date === ep.airdate;
    return {
        id: `tvmaze_${ep.id}`,
        season_number: ep.season,
        episode_number: ep.number,
        name: matches && localized(russian.name) ? russian.name : ep.name || `Серия ${ep.number}`,
        overview: matches && localized(russian.overview) ? russian.overview : plain(ep.summary),
        air_date: ep.airdate || null,
        runtime: ep.runtime ?? russian?.runtime ?? null,
        vote_average: ep.rating?.average ?? russian?.vote_average ?? 0,
        episode_type: ep.type === 'season_finale' || ep.type === 'series_finale' ? 'finale' : 'standard'
    };
}

/** Build a season exclusively from TVmaze's list, including episodes unknown to TMDB. */
function seasonOf(show, number, russian = null) {
    const meta = show._embedded.seasons.find((s) => s.number === Number(number));
    const eps = show._embedded.episodes.filter(
        (e) => e.season === Number(number) && Number.isInteger(e.number) && e.number > 0
    );
    const translated = new Map((russian?.episodes || []).map((e) => [e.episode_number, e]));
    const times = tvmaze.timesOf(show);
    return {
        ...russian,
        season_number: Number(number),
        name: meta?.name || russian?.name || `Сезон ${number}`,
        air_date: meta?.premiereDate || eps.find((e) => e.airdate)?.airdate || null,
        episode_count: episodeCount(meta, eps),
        finale_known: finaleKnown(show, meta, eps),
        episodes: eps
            .map((e) => {
                const time = times[`${e.season}:${e.number}`];
                return {
                    ...episode(e, translated.get(e.number)),
                    runtime: e.runtime || time?.runtime || translated.get(e.number)?.runtime || null,
                    out_at: time ? require('../episode-times').outAt(time) : null
                };
            })
            .sort((a, b) => order(a) - order(b))
    };
}

function merge(raw, show, now = Date.now()) {
    // Loaded lazily: episode-times also reads TMDB seasons for the legacy fallback.
    const { outAt } = require('../episode-times');
    tvmaze.setRuntimeFallback(show.id, (raw.episode_run_time || [])[0] || raw.last_episode_to_air?.runtime);
    const times = tvmaze.timesOf(show);
    const translations = [raw.last_episode_to_air, raw.next_episode_to_air].filter(Boolean);
    const seasons = show._embedded.seasons.map((s) => ({
        season_number: s.number,
        name: s.name || `Сезон ${s.number}`,
        air_date: s.premiereDate || null,
        episode_count: episodeCount(
            s,
            show._embedded.episodes.filter((e) => e.season === s.number && Number.isInteger(e.number) && e.number > 0)
        ),
        finale_known: finaleKnown(
            show,
            s,
            show._embedded.episodes.filter((e) => e.season === s.number && Number.isInteger(e.number) && e.number > 0)
        )
    }));
    const episodes = show._embedded.episodes
        .filter((e) => e.season > 0 && Number.isInteger(e.number) && e.number > 0)
        .map((e) => ({
            ...episode(
                e,
                translations.find((t) => t.season_number === e.season && t.episode_number === e.number)
            ),
            runtime: e.runtime || times[`${e.season}:${e.number}`]?.runtime || null
        }))
        .sort((a, b) => order(a) - order(b));
    const aired = episodes.filter(
        (e) =>
            times[`${e.season_number}:${e.episode_number}`] &&
            outAt(times[`${e.season_number}:${e.episode_number}`]) <= now
    );
    const last = aired.at(-1) || null;
    const next =
        episodes.find(
            (e) =>
                (!last || order(e) > order(last)) &&
                (!times[`${e.season_number}:${e.episode_number}`] ||
                    outAt(times[`${e.season_number}:${e.episode_number}`]) > now)
        ) || null;
    const lastSeason = last && show._embedded.seasons.find((s) => s.number === last.season_number);
    const lastEpisodes = last ? episodes.filter((e) => e.season_number === last.season_number) : [];
    const complete = Boolean(
        last && lastEpisodes.every((e) => aired.includes(e)) && finaleKnown(show, lastSeason, lastEpisodes)
    );
    // An announced future episode takes precedence over a stale Ended flag.
    const status = next && show.status === 'Ended' ? 'Returning Series' : statusOf(show, raw.status);
    const network = show.webChannel || show.network;
    const cast = show._embedded.cast;
    const creators = (show._embedded.crew || [])
        .filter((c) => c.type === 'Creator')
        .map((c) => c.person?.name)
        .filter(Boolean);
    return {
        ...raw,
        id: raw.id,
        name: raw.name || show.name,
        original_name: show.name,
        overview: localized(raw.overview) ? raw.overview : plain(show.summary) || raw.overview,
        status,
        in_production: status !== 'Ended',
        first_air_date: show.premiered || raw.first_air_date,
        last_air_date: show.ended || last?.air_date || null,
        number_of_seasons: seasons.filter((s) => s.season_number > 0).length,
        number_of_episodes: seasons.filter((s) => s.season_number > 0).reduce((sum, s) => sum + s.episode_count, 0),
        seasons,
        genres: show.genres?.length ? show.genres.map((name) => ({ name: GENRES[name] || name })) : raw.genres,
        poster_path: show.image?.original || show.image?.medium || raw.poster_path,
        poster_url: show.image?.original || show.image?.medium || raw.poster_url,
        networks: network?.name ? [{ id: network.id, name: network.name }] : raw.networks,
        origin_country: raw.origin_country || [],
        episode_run_time:
            show.averageRuntime || show.runtime ? [show.averageRuntime || show.runtime] : raw.episode_run_time,
        vote_average: show.rating?.average ?? raw.vote_average,
        rating_source: show.rating?.average != null ? 'tvmaze' : raw.rating_source || 'tmdb',
        homepage: show.officialSite || raw.homepage,
        director_name: creators.join(', ') || raw.director_name,
        credits:
            Array.isArray(cast) && cast.length
                ? { ...raw.credits, cast: cast.map((c) => ({ name: c.person?.name, character: c.character?.name })) }
                : raw.credits,
        imdb_id: show.externals?.imdb || raw.imdb_id,
        external_ids: {
            ...raw.external_ids,
            imdb_id: show.externals?.imdb || raw.imdb_id,
            tvdb_id: show.externals?.thetvdb || raw.external_ids?.tvdb_id
        },
        last_episode_to_air: last,
        next_episode_to_air: next,
        data_source: 'tvmaze',
        source_url: show.url,
        tvmaze_id: show.id,
        tvmaze_primary: true,
        seed_only: false,
        tvmaze_season_complete: complete,
        tvmaze_missing: Boolean(show.unavailable),
        tvmaze_times: times,
        // A retained value already uses TVmaze numbering in last_episode_to_air.
        tmdb_last_episode: raw.tvmaze_primary ? raw.tmdb_last_episode || null : raw.last_episode_to_air
    };
}

async function resolve(id, load, { fresh = false, budget = null, fallback = null, deadline = null } = {}) {
    id = String(id);
    if (fallback) seed(fallback);
    const prior = retained.get(id);
    const previous =
        fallback?.episode_source === 'tvmaze' && fallback.tvmaze_id
            ? tvmaze.cachedShow(`tv_${id}`, fallback.tvmaze_id)
            : null;
    let error;
    const metadata = Promise.resolve()
        .then(() => (deadline?.passed() ? prior : load()))
        .catch((err) => {
            error = err;
            return prior;
        });
    const primary = prior?.tvmaze_id
        ? tvmaze.showFor(`tv_${id}`, optional(metadata, 3000, prior, deadline).then(tvmaze.externalsOf), {
              fresh,
              budget,
              deadline,
              knownId: prior.tvmaze_id
          })
        : null;
    const raw = prior?.tvmaze_id
        ? await optional(metadata, fresh ? 3000 : 0, prior, deadline)
        : deadline
          ? await optional(metadata, 3000, prior, deadline)
          : await metadata;
    if (!raw) throw error || new Error('No series metadata');
    const show = primary
        ? await primary
        : await tvmaze.showFor(`tv_${id}`, tvmaze.externalsOf(raw), {
              fresh,
              budget,
              deadline,
              knownId: prior?.tvmaze_id || raw.tvmaze_id || fallback?.tvmaze_id || null
          });
    if (show) {
        const result = merge(raw, show);
        if (fallback?.episode_source === 'tvmaze' && fallback.tvmaze_id && Number(fallback.tvmaze_id) !== show.id) {
            const saved = previous?._embedded?.episodes.find(
                (e) => e.season === fallback.last_season && e.number === fallback.last_episode
            );
            // The replacement catalog can number the same episodes differently. Do not
            // substitute TMDB's numbering when the saved TVmaze identity is unavailable.
            result.source_cursor_episode = saved ? episode(saved) : null;
        }
        retained.set(id, result);
        sources.set(id, 'tvmaze');
        return result;
    }
    // A temporary outage must not turn an existing TVmaze show's status back into a
    // contradictory TMDB status, or switch its episode numbering for one check.
    if (show === undefined && prior?.data_source === 'tvmaze') return { ...prior, tvmaze_missing: true };
    if (show === undefined && sources.get(id) === 'tvmaze')
        return {
            ...raw,
            status: null,
            seasons: [],
            last_episode_to_air: null,
            next_episode_to_air: null,
            data_source: 'tvmaze',
            tvmaze_primary: true,
            tvmaze_missing: true
        };
    if (error && !show) throw error;
    const result = {
        ...raw,
        data_source: 'tmdb',
        source_url: `https://www.themoviedb.org/tv/${id}`,
        tvmaze_missing: show === undefined
    };
    retained.set(id, result);
    sources.set(id, 'tmdb');
    return result;
}

const peek = (id) => retained.get(String(id));
module.exports = { resolve, merge, seasonOf, seed, peek, optional, sourceOf: (id) => sources.get(String(id)) };
