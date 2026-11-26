/** Real public API entrypoints, stubbed HTTP: source priority, outages and silent migration. */
const { test, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { setImmediate } = require('node:timers');
let tmdbAnswer;
let mazeAnswer;
let requests = [];
const realCreate = axios.create.bind(axios);
mock.method(axios, 'create', (options) =>
    realCreate({
        ...options,
        adapter: async (config) => {
            requests.push([config.baseURL, config.url]);
            const data = config.baseURL.includes('tvmaze') ? await mazeAnswer(config) : await tmdbAnswer(config);
            return { data, status: 200, statusText: 'OK', headers: {}, config };
        }
    })
);
const tmdb = require('../../src/api/tmdb');
const tvmaze = require('../../src/api/tvmaze');
const provider = require('../../src/api/series-data');
const db = require('../../src/db');
mock.method(db.Chat, 'findByPk', async () => null);
for (const model of [db.SendFailure, db.SentNotification]) {
    mock.method(model, 'create', async () => {});
    mock.method(model, 'destroy', async () => 0);
}
const { checkSeriesUpdates } = require('../../src/cron/series');
const { fakeSeries: makeSeries, fakeBot, mockSeriesWrites } = require('./fakes');
const savedRows = new Map();
const fakeSeries = (...args) => {
    const row = makeSeries(...args);
    savedRows.set(row.tmdb_id, row);
    return row;
};
const now = Date.parse('2026-11-25T15:00:00Z');
const notFound = () => Object.assign(new Error('404'), { response: { status: 404 } });
const ep = (number, overrides = {}) => ({
    id: number,
    season: 1,
    number,
    name: `English ${number}`,
    airdate: '2026-11-24',
    airstamp: '2026-11-24T12:00:00Z',
    airtime: '',
    runtime: 45,
    ...overrides
});
const show = (id, overrides = {}) => ({
    id,
    name: 'Original name',
    status: 'Running',
    premiered: '2026-11-24',
    url: `https://www.tvmaze.com/shows/${id}/test`,
    genres: ['Drama'],
    rating: { average: 8 },
    webChannel: { name: 'Prime Video', country: null },
    externals: { imdb: `tt${id}` },
    _embedded: { episodes: [ep(1), ep(2)], seasons: [{ number: 1, premiereDate: '2026-11-24', episodeOrder: 2 }] },
    ...overrides
});
const raw = (id, overrides = {}) => ({
    id,
    name: 'Русское название',
    status: 'Ended',
    external_ids: { imdb_id: `tt${id}` },
    seasons: [{ season_number: 1, episode_count: 1 }],
    last_episode_to_air: { season_number: 1, episode_number: 1, name: 'Пилот', air_date: '2026-11-24' },
    next_episode_to_air: null,
    ...overrides
});
beforeEach(() => {
    savedRows.clear();
    mockSeriesWrites(mock, savedRows);
    tvmaze.resetLimits();
    requests = [];
    mock.method(Date, 'now', () => now);
});
function routes(id, data = show(id), original = raw(id)) {
    tmdbAnswer = async (config) =>
        config.url.includes('/season/')
            ? { episodes: [{ season_number: 1, episode_number: 1, name: 'Пилот', air_date: '2026-11-24' }] }
            : original;
    mazeAnswer = async (config) => (config.url === '/lookup/shows' ? { id } : data);
}

test('TVmaze status and all episodes win over TMDB Ended and an incomplete season; Russian title stays', async () => {
    const id = 91001;
    routes(id);
    const data = await tmdb.getDetails(id, 'tv');
    assert.equal(data.status, 'Returning Series');
    assert.equal(data.name, 'Русское название');
    assert.equal(data.last_episode_to_air.episode_number, 2);
    assert.equal(data.number_of_episodes, 2);
    assert.equal(data.data_source, 'tvmaze');
    assert.equal(data.tvmaze_season_complete, true);
    assert.equal(data.networks[0].name, 'Prime Video');
    assert.equal(data.genres[0].name, 'Драма');
    assert.equal(tmdb.peekDetails(id, 'tv').status, data.status);
    const season = await tmdb.getSeasonDetailsCached(String(id), 1);
    assert.deepEqual(
        season.episodes.map((e) => e.name),
        ['Пилот', 'English 2']
    );
    assert.equal(season.episodes.length, 2, 'TVmaze-only episode exists in calendar/stat season API');
});

test('a TVmaze future episode keeps Ended active; an incomplete announced count proves no finale', async () => {
    const id = 91002;
    const data = show(id, {
        status: 'Ended',
        _embedded: {
            episodes: [ep(1), ep(2, { airdate: '2026-12-01', airstamp: '2026-12-01T12:00:00Z' })],
            seasons: [{ number: 1, episodeOrder: null }]
        }
    });
    routes(id, data);
    const result = await tmdb.getDetails(id, 'tv');
    assert.equal(result.status, 'Returning Series');
    assert.equal(result.last_episode_to_air.episode_number, 1);
    assert.equal(result.next_episode_to_air.episode_number, 2);
    assert.equal(result.tvmaze_season_complete, false);
});

test('a running season with no expected episode count is not declared complete', () => {
    const id = 91003;
    const data = show(id);
    data._embedded.seasons[0].episodeOrder = null;
    assert.equal(provider.merge(raw(id), data, now).tvmaze_season_complete, false);
});

test('streaming placeholder times wait until the day ended everywhere, even when TMDB says aired', () => {
    const id = 91004;
    const data = show(id, {
        _embedded: {
            episodes: [ep(1, { airdate: '2026-11-25', airstamp: '2026-11-25T12:00:00Z' })],
            seasons: [{ number: 1, episodeOrder: 1 }]
        }
    });
    const result = provider.merge(raw(id), data, now);
    assert.equal(result.last_episode_to_air, null);
    assert.equal(result.next_episode_to_air.episode_number, 1);
});

test('different numbering/dates never grafts a Russian name from an unrelated TMDB episode', async () => {
    const id = 91005;
    routes(id, show(id));
    await tmdb.getDetails(id, 'tv');
    tmdbAnswer = async () => ({
        episodes: [{ episode_number: 1, name: 'Неправильная серия', air_date: '2020-01-01' }]
    });
    const result = await tmdb.getSeasonDetails(id, 1);
    assert.equal(result.episodes[0].name, 'English 1');
});

test('exact lookup absent: TMDB remains the fallback, never fuzzy matching by title', async () => {
    const id = 91006;
    routes(id);
    mazeAnswer = async () => {
        throw notFound();
    };
    const result = await tmdb.getDetails(id, 'tv');
    assert.equal(result.data_source, 'tmdb');
    assert.equal(result.status, 'Ended');
    assert.equal(result.tvmaze_missing, false);
    assert.equal(
        requests.some(([, url]) => url.includes('search')),
        false
    );
});

test('a fresh snapshot survives a TVmaze outage without accepting contradictory TMDB status', async () => {
    const id = 91007;
    routes(id);
    await tmdb.getDetails(id, 'tv');
    mazeAnswer = async () => {
        throw new Error('offline');
    };
    const result = await tmdb.getDetails(id, 'tv');
    assert.equal(result.status, 'Returning Series');
    assert.equal(result.data_source, 'tvmaze');
});

test('saved exact ID and Russian title let series refresh after restart while TMDB is down', async () => {
    const id = 91008;
    routes(id);
    tmdbAnswer = async () => {
        throw new Error('TMDB down');
    };
    const result = await tmdb.getDetails(id, 'tv', {
        fallbackSeries: { tmdb_id: `tv_${id}`, tvmaze_id: id, episode_source: 'tvmaze', title: 'Сохранённое имя' }
    });
    assert.equal(result.name, 'Сохранённое имя');
    assert.equal(result.status, 'Returning Series');
    assert.equal(
        requests.some(([, url]) => url === '/lookup/shows'),
        false
    );
});

test('source migration baselines the new numbering and repairs false archive status without sends', async () => {
    const id = 91009;
    routes(id);
    const row = fakeSeries(
        {
            tmdb_id: `tv_${id}`,
            status: 'Ended',
            last_season: 3,
            last_episode: 99,
            kinopoisk_id: 1,
            aired_episodes: '',
            release_seasons: '',
            episode_source: null
        },
        [[10, 'episode']]
    );
    const bot = fakeBot();
    await checkSeriesUpdates(bot, [row]);
    assert.equal(row.status, 'Returning Series');
    assert.equal(row.episode_source, 'tvmaze');
    assert.equal(row.tvmaze_id, id);
    assert.deepEqual([row.last_season, row.last_episode], [1, 2]);
    assert.equal(bot.sent.length, 0, 'no false renewal, old episodes or finale');
    await checkSeriesUpdates(bot, [row]);
    assert.equal(bot.sent.length, 0, 'next unchanged check is quiet too');
});

test('movies never query TVmaze or change their facts', async () => {
    const id = 91010;
    routes(id, show(id), { id, title: 'Фильм', status: 'Released' });
    const result = await tmdb.getDetails(id, 'movie');
    assert.equal(result.status, 'Released');
    assert.equal(result.data_source, undefined);
    assert.equal(
        requests.some(([base]) => base.includes('tvmaze')),
        false
    );
});

test('expired negative show lookup retries and discovers a show added around its premiere', async () => {
    const id = 91011;
    routes(id);
    mazeAnswer = async () => {
        throw notFound();
    };
    assert.equal(await tvmaze.showFor(`tv_${id}`, { imdb: `tt${id}` }), null);
    mock.method(Date, 'now', () => now + 2 * 86400000);
    routes(id);
    assert.equal((await tvmaze.showFor(`tv_${id}`, { imdb: `tt${id}` })).id, id);
});

test('old snapshots do not silently switch statistics to TMDB numbering', async () => {
    const id = 91012;
    routes(id);
    await tmdb.getDetails(id, 'tv');
    mock.method(Date, 'now', () => now + 31 * 3600000);
    await assert.rejects(tmdb.getSeasonDetails(id, 1), /TVmaze season unavailable/);
});

test('restart with both sources down preserves every saved row field and sends nothing', async () => {
    const id = 91013;
    routes(id);
    tmdbAnswer = mazeAnswer = async () => {
        throw new Error('offline');
    };
    const row = fakeSeries(
        {
            tmdb_id: `tv_${id}`,
            tvmaze_id: id,
            episode_source: 'tvmaze',
            next_episode_date: '2026-12-10',
            genres: 'Драма',
            runtime: 50,
            aired_episodes: '',
            release_seasons: ''
        },
        [[10, 'episode']]
    );
    const before = { ...row };
    const bot = fakeBot();
    await checkSeriesUpdates(bot, [row]);
    assert.deepEqual(row.updates, []);
    assert.equal(row.next_episode_date, before.next_episode_date);
    assert.equal(row.genres, before.genres);
    assert.equal(row.runtime, before.runtime);
    assert.equal(bot.sent.length, 0);
});

test('migration never re-announces a safely matched episode TMDB had already announced too early', async () => {
    const id = 91014;
    const original = raw(id, {
        last_episode_to_air: { season_number: 1, episode_number: 1, air_date: '2026-11-25', name: 'Уже объявлено' }
    });
    routes(
        id,
        show(id, {
            _embedded: {
                seasons: [{ number: 1, episodeOrder: 1 }],
                episodes: [ep(1, { airdate: '2026-11-25', airstamp: '2026-11-25T12:00:00Z' })]
            }
        }),
        original
    );
    const row = fakeSeries(
        {
            tmdb_id: `tv_${id}`,
            last_season: 1,
            last_episode: 1,
            completed_season: 1,
            kinopoisk_id: 1,
            aired_episodes: '',
            release_seasons: ''
        },
        [[10, 'episode']]
    );
    const bot = fakeBot();
    await checkSeriesUpdates(bot, [row]);
    assert.equal(row.last_episode, 1);
    mock.method(Date, 'now', () => now + 2 * 86400000);
    await checkSeriesUpdates(bot, [row]);
    assert.equal(bot.sent.length, 0);
});

test('migration writes numbering and source together before optional lookups can fail', async () => {
    const id = 91015;
    routes(id);
    const row = fakeSeries({
        tmdb_id: `tv_${id}`,
        last_season: 9,
        last_episode: 99,
        kinopoisk_id: 1,
        aired_episodes: '',
        release_seasons: ''
    });
    await checkSeriesUpdates(fakeBot(), [row]);
    const first = row.updates[0];
    assert.equal(first.episode_source, 'tvmaze');
    assert.equal(first.last_season, 1);
    assert.equal(first.last_episode, 2);
});

test('TVmaze retains undated and old episodes for season counts and history; unconfirmed finale stays unknown', () => {
    const id = 91016;
    const data = show(id, {
        _embedded: {
            seasons: [{ number: 1, episodeOrder: null }],
            episodes: [ep(1, { airdate: '2001-01-01' }), ep(2, { airdate: '', airstamp: null })]
        }
    });
    const season = provider.seasonOf(data, 1);
    assert.equal(season.episodes.length, 2);
    assert.equal(season.episodes[1].air_date, null);
    assert.equal(season.finale_known, false);
});

test('a later TVmaze-only notification cursor uses a Russian season title when TMDB has it', async () => {
    const id = 91017;
    const data = show(id);
    routes(id, data);
    const original = tmdbAnswer;
    tmdbAnswer = async (config) =>
        config.url.includes('/season/')
            ? {
                  episodes: [{ season_number: 1, episode_number: 2, air_date: '2026-11-24', name: 'Русская вторая' }]
              }
            : original(config);
    const details = await tmdb.getDetails(id, 'tv');
    assert.equal(details.last_episode_to_air.name, 'Русская вторая');
    const row = fakeSeries(
        {
            tmdb_id: `tv_${id}`,
            episode_source: 'tvmaze',
            tvmaze_id: id,
            kinopoisk_id: 1,
            last_episode: 2,
            completed_season: 1,
            aired_episodes: '',
            release_seasons: ''
        },
        [[10, 'episode']]
    );
    data._embedded.episodes.push(ep(3, { name: 'Only on TVmaze' }));
    const bot = fakeBot();
    await checkSeriesUpdates(bot, [row]);
    assert.equal(row.last_episode, 3);
    assert.equal(bot.sent.length, 1);
    assert.match(bot.sent[0].text, /Only on TVmaze/);
});

test('a TVmaze-owned next cursor uses its exact time across chat zones and daily neighbouring episodes', (t) => {
    const { nextDayIn, nextTimeOf } = require('../../src/episode-times');
    t.mock.method(tvmaze, 'cachedAirTimes', () => ({
        '1:5': { date: '2026-11-25', stamp: Date.parse('2026-11-25T21:30:00Z'), runtime: 30, timed: true },
        '1:6': { date: '2026-11-26', stamp: Date.parse('2026-11-26T21:30:00Z'), runtime: 30, timed: true }
    }));
    const row = {
        tmdb_id: 'tv_91018',
        episode_source: 'tvmaze',
        next_episode_season: 1,
        next_episode_number: 5,
        next_episode_date: '2026-11-26'
    };
    assert.equal(nextDayIn(row, 'Europe/Kaliningrad'), '2026-11-25');
    assert.equal(nextDayIn(row, 'Europe/Moscow'), '2026-11-26');
    assert.equal(nextTimeOf(row).stamp, Date.parse('2026-11-25T21:30:00Z'));
});

test('review: migration matches the saved episode even when TMDB has already moved beyond it', async () => {
    const id = 91020;
    const data = show(id, {
        _embedded: {
            seasons: [{ number: 1, episodeOrder: 2 }],
            episodes: [
                ep(1, { airdate: '2026-11-25', airstamp: '2026-11-25T12:00:00Z' }),
                ep(2, { airdate: '2026-11-26', airstamp: '2026-11-26T12:00:00Z' })
            ]
        }
    });
    const original = raw(id, { last_episode_to_air: { season_number: 1, episode_number: 2, air_date: '2026-11-26' } });
    routes(id, data, original);
    const load = tmdbAnswer;
    tmdbAnswer = async (config) =>
        config.url.includes('/season/')
            ? {
                  episodes: [
                      { season_number: 1, episode_number: 1, air_date: '2026-11-25', name: 'Уже объявлена' },
                      { season_number: 1, episode_number: 2, air_date: '2026-11-26', name: 'Вторая' }
                  ]
              }
            : load(config);
    const row = fakeSeries(
        {
            tmdb_id: `tv_${id}`,
            last_season: 1,
            last_episode: 1,
            completed_season: 0,
            kinopoisk_id: 1,
            aired_episodes: '',
            release_seasons: ''
        },
        [[10, 'episode']]
    );
    const bot = fakeBot();
    await checkSeriesUpdates(bot, [row]);
    assert.equal(row.last_episode, 1);
    mock.method(Date, 'now', () => now + 22 * 3600000);
    await checkSeriesUpdates(bot, [row]);
    assert.equal(bot.sent.length, 0);
});

test('review: startup backfills never turn an unavailable seed into empty historical statistics', async () => {
    const id = 91021;
    routes(id);
    tmdbAnswer = mazeAnswer = async () => {
        throw new Error('offline');
    };
    const row = fakeSeries({
        tmdb_id: `tv_${id}`,
        tvmaze_id: id,
        episode_source: 'tvmaze',
        aired_episodes: null,
        release_seasons: '2024:1;2025:2'
    });
    provider.seed(row);
    await require('../../src/cron/series-backfill').backfillSeries([row], '[Review]', async (item, details) => {
        await require('../../src/cron/aired-episodes').ensureAiredEpisodes(item, details);
        await require('../../src/cron/release-seasons').ensureReleaseSeasons(item, details);
    });
    assert.equal(row.aired_episodes, null);
    assert.equal(row.release_seasons, '2024:1;2025:2');
    assert.deepEqual(row.updates, []);
});

test('review: a healthy TVmaze snapshot preserves saved fallback facts while TMDB is offline after restart', async () => {
    const id = 91022;
    routes(
        id,
        show(id, {
            genres: [],
            rating: null,
            webChannel: null,
            _embedded: {
                seasons: [{ number: 1, episodeOrder: 1 }],
                episodes: [ep(1, { runtime: null })]
            }
        })
    );
    tmdbAnswer = async () => {
        throw new Error('TMDB offline');
    };
    const details = await tmdb.getDetails(id, 'tv', {
        fallbackSeries: {
            tmdb_id: `tv_${id}`,
            tvmaze_id: id,
            episode_source: 'tvmaze',
            title: 'Сохранённое имя',
            countries: 'US,GB',
            runtime: 50,
            rating: 8.1,
            genres: 'Драма',
            networks: 'Saved channel'
        }
    });
    const facts = tmdb.titleFacts(details, 'tv');
    assert.equal(facts.countries, 'US,GB');
    assert.equal(facts.runtime, 50);
    assert.equal(facts.rating, 8.1);
    assert.equal(facts.genres, 'Драма');
    assert.equal(facts.networks, 'Saved channel');
});

test('review: an exact saved TVmaze ID starts the primary request before optional TMDB metadata answers', async () => {
    const id = 91023;
    const row = { tmdb_id: `tv_${id}`, tvmaze_id: id, episode_source: 'tvmaze', title: 'Сохранённое имя' };
    routes(id);
    let release;
    let asked = false;
    const load = new Promise((resolve) => {
        release = resolve;
    });
    mazeAnswer = async () => {
        asked = true;
        return show(id);
    };
    const result = provider.resolve(String(id), () => load, { fresh: true, fallback: row });
    try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(asked, true);
    } finally {
        release(raw(id));
        await result;
    }
});

test('review: known show runtime prevents premature episode arrival when the episode runtime is missing', () => {
    const id = 91024;
    const data = show(id, {
        averageRuntime: 120,
        _embedded: {
            seasons: [{ number: 1, episodeOrder: 1 }],
            episodes: [
                ep(1, { runtime: null, airdate: '2026-11-25', airstamp: '2026-11-25T13:30:00Z', airtime: '13:30' })
            ]
        }
    });
    const result = provider.merge(raw(id), data, now);
    assert.equal(result.last_episode_to_air, null);
    assert.equal(result.next_episode_to_air.episode_number, 1);
});

test('review: Released history uses the expected full TVmaze season size, not only the announced list', async () => {
    const id = 91025;
    const details = provider.merge(
        raw(id),
        show(id, {
            _embedded: {
                seasons: [{ number: 1, episodeOrder: 10, premiereDate: '2026-11-24' }],
                episodes: [ep(1), ep(2), ep(3), ep(4, { airdate: '2027-01-01', airstamp: '2027-01-01T12:00:00Z' })]
            }
        }),
        now
    );
    const row = fakeSeries({ tmdb_id: `tv_${id}`, aired_episodes: '2026-11:1=3/135', release_seasons: null });
    await require('../../src/cron/release-seasons').ensureReleaseSeasons(row, details, new Date(now));
    assert.equal(row.release_seasons, '');
    assert.equal(details.seasons[0].episode_count, 10);
});

test('review: optional season localization has a deadline while the complete TVmaze season stays usable', async (t) => {
    const id = 91026;
    routes(id);
    await tmdb.getDetails(id, 'tv');
    let release;
    tmdbAnswer = () =>
        new Promise((resolve) => {
            release = resolve;
        });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let result;
    const request = tmdb.getSeasonDetails(id, 1).then((value) => {
        result = value;
    });
    try {
        await new Promise((resolve) => setImmediate(resolve));
        t.mock.timers.tick(3000);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(result?.episodes.length, 2);
    } finally {
        release?.({ episodes: [] });
        await request;
    }
});

test('review: an ambiguous not-yet-aired migration waits for identity and keeps the original cursor', async () => {
    const id = 91027;
    const data = show(id, {
        _embedded: {
            seasons: [{ number: 1, episodeOrder: 2 }],
            episodes: [
                ep(1, { airdate: '2026-11-25', airstamp: '2026-11-25T12:00:00Z' }),
                ep(2, { airdate: '2026-11-26', airstamp: '2026-11-26T12:00:00Z' })
            ]
        }
    });
    routes(id, data, raw(id, { last_episode_to_air: { season_number: 1, episode_number: 2, air_date: '2026-11-26' } }));
    const load = tmdbAnswer;
    tmdbAnswer = async (config) => {
        if (config.url.includes('/season/')) throw new Error('identity unavailable');
        return load(config);
    };
    const row = fakeSeries(
        {
            tmdb_id: `tv_${id}`,
            last_season: 1,
            last_episode: 1,
            kinopoisk_id: 1,
            aired_episodes: '',
            release_seasons: ''
        },
        [[10, 'episode']]
    );
    const bot = fakeBot();
    await checkSeriesUpdates(bot, [row]);
    assert.equal(row.episode_source, undefined);
    assert.equal(row.last_episode, 1);
    assert.deepEqual(row.updates, []);
    assert.equal(bot.sent.length, 0);
});

test('review: a unique saved episode date maps an already-announced cursor across different season numbers', async () => {
    const id = 91028;
    const data = show(id, {
        _embedded: {
            seasons: [{ number: 1, episodeOrder: 2 }],
            episodes: [
                ep(1, { airdate: '2026-11-25', airstamp: '2026-11-25T12:00:00Z' }),
                ep(2, { airdate: '2026-11-26', airstamp: '2026-11-26T12:00:00Z' })
            ]
        }
    });
    routes(id, data, raw(id, { last_episode_to_air: { season_number: 3, episode_number: 2, air_date: '2026-11-26' } }));
    const load = tmdbAnswer;
    tmdbAnswer = async (config) =>
        config.url.includes('/season/3')
            ? {
                  episodes: [{ episode_number: 1, air_date: '2026-11-25', name: 'Уже объявлена' }]
              }
            : load(config);
    const row = fakeSeries(
        {
            tmdb_id: `tv_${id}`,
            last_season: 3,
            last_episode: 1,
            completed_season: 3,
            kinopoisk_id: 1,
            aired_episodes: '',
            release_seasons: ''
        },
        [[10, 'episode']]
    );
    const bot = fakeBot();
    await checkSeriesUpdates(bot, [row]);
    assert.deepEqual([row.last_season, row.last_episode], [1, 1]);
    assert.equal(
        row.completed_season,
        0,
        'a completed TMDB season need not complete the differently split TVmaze season'
    );
    mock.method(Date, 'now', () => now + 22 * 3600000);
    await checkSeriesUpdates(bot, [row]);
    assert.equal(bot.sent.length, 0);
});

test('review: missing TVmaze runtimes use the known reserve length consistently in cached send times', async () => {
    const id = 91029;
    const data = show(id, {
        _embedded: {
            seasons: [{ number: 1, episodeOrder: 1 }],
            episodes: [
                ep(1, { runtime: null, airdate: '2026-11-25', airstamp: '2026-11-25T13:30:00Z', airtime: '13:30' })
            ]
        }
    });
    routes(id, data, raw(id, { episode_run_time: [120] }));
    const details = await tmdb.getDetails(id, 'tv');
    assert.equal(details.last_episode_to_air, null);
    assert.equal(tvmaze.cachedAirTimes(`tv_${id}`)['1:1'].runtime, 120);
});

test('review: conflicting episode dates hold migration until the potentially repeated episode aired', async () => {
    const id = 91030;
    const data = show(id, {
        _embedded: {
            seasons: [{ number: 1, episodeOrder: 2 }],
            episodes: [
                ep(1, { airdate: '2026-11-26', airstamp: '2026-11-26T12:00:00Z' }),
                ep(2, { airdate: '2026-11-28', airstamp: '2026-11-28T12:00:00Z' })
            ]
        }
    });
    routes(id, data, raw(id, { last_episode_to_air: { season_number: 1, episode_number: 1, air_date: '2026-11-25' } }));
    const row = fakeSeries(
        {
            tmdb_id: `tv_${id}`,
            last_season: 1,
            last_episode: 1,
            completed_season: 0,
            kinopoisk_id: 1,
            aired_episodes: '',
            release_seasons: ''
        },
        [[10, 'episode']]
    );
    const bot = fakeBot();
    await checkSeriesUpdates(bot, [row]);
    assert.equal(row.episode_source, undefined);
    assert.equal(row.last_episode, 1);
    mock.method(Date, 'now', () => now + 48 * 3600000);
    await checkSeriesUpdates(bot, [row]);
    assert.equal(row.episode_source, 'tvmaze', 'an unrelated later episode must not hold the transition forever');
    assert.equal(row.last_episode, 1);
    assert.equal(bot.sent.length, 0);
});

test('ponytail: a later season cannot consume completion before the known episode order is met', async () => {
    const id = 91201;
    const data = show(id, {
        _embedded: {
            seasons: [
                { number: 1, episodeOrder: 10, premiereDate: '2026-11-20' },
                { number: 2, episodeOrder: 6, premiereDate: '2027-01-01' }
            ],
            episodes: [1, 2, 3, 4]
                .map((n) => ep(n, { airdate: '2026-11-20', airstamp: '2026-11-20T12:00:00Z' }))
                .concat(ep(1, { season: 2, airdate: '2027-01-01', airstamp: '2027-01-01T12:00:00Z' }))
        }
    });
    const row = fakeSeries({ tmdb_id: `tv_${id}`, episode_source: 'tvmaze', last_episode: 3, completed_season: 0 }, [
        [10, 'season']
    ]);
    const bot = fakeBot();
    const first = provider.merge(raw(id), data, now);
    await require('../../src/cron/series').notifyNewEpisodes(bot, row, first);
    assert.equal(bot.sent.length, 0);
    assert.equal(row.completed_season, 0);
    assert.equal(first.seasons[0].finale_known, false);
    data._embedded.episodes.push(
        ...[5, 6, 7, 8, 9, 10].map((n) =>
            ep(n, {
                airdate: '2026-11-21',
                airstamp: '2026-11-21T12:00:00Z'
            })
        )
    );
    await require('../../src/cron/series').notifyNewEpisodes(bot, row, provider.merge(raw(id), data, now));
    assert.equal(bot.sent.length, 1);
    assert.equal(row.completed_season, 1);
});

test('ponytail: startup history waits until stored episode counts and incoming seasons share a source', async (t) => {
    const id = 91202;
    routes(
        id,
        show(id, {
            _embedded: { seasons: [{ number: 1, episodeOrder: 8, premiereDate: '2026-01-01' }], episodes: [ep(1)] }
        })
    );
    const row = fakeSeries({
        tmdb_id: `tv_${id}`,
        episode_source: 'tmdb',
        last_season: 2,
        aired_episodes: '2026-01:2=8/360',
        release_seasons: '2026:2'
    });
    t.mock.method(db.Series, 'findAll', async () => [row]);
    await require('../../src/cron/release-seasons').backfillReleaseSeasons();
    assert.equal(row.release_seasons, '2026:2');
    assert.deepEqual(row.updates, []);
});

test('ponytail: a removed saved ID recovers through the exact external lookup and keeps the replacement', async () => {
    const id = 91203;
    const replacement = 91204;
    routes(id);
    mazeAnswer = async (config) => {
        if (config.url === `/shows/${id}`) throw notFound();
        if (config.url === '/lookup/shows') return { id: replacement };
        assert.equal(config.url, `/shows/${replacement}`);
        return show(replacement, { externals: { imdb: `tt${id}` } });
    };
    const row = { tmdb_id: `tv_${id}`, tvmaze_id: id, episode_source: 'tvmaze', title: 'Saved' };
    const first = await tmdb.getDetails(id, 'tv', { fallbackSeries: row });
    assert.equal(first.tvmaze_missing, false);
    assert.equal(first.tvmaze_id, replacement);
    const second = await tmdb.getDetails(id, 'tv', { fallbackSeries: row });
    assert.equal(second.tvmaze_id, replacement);
    assert.equal(requests.filter(([base, url]) => base.includes('tvmaze') && url === `/shows/${id}`).length, 1);
    assert.equal(requests.filter(([base, url]) => base.includes('tvmaze') && url === '/lookup/shows').length, 1);
});

test('ponytail: a calendar shares one TVmaze deadline across every batch and optional lookup', async (t) => {
    const rows = Array.from({ length: 5 }, (_, n) => ({
        tmdb_id: `tv_${91210 + n}`,
        tvmaze_id: 91210 + n,
        episode_source: 'tvmaze',
        title: 'Saved',
        last_season: 1,
        release_seasons: '2026:1'
    }));
    rows.forEach((row) => provider.seed(row));
    t.mock.method(db.Subscription, 'findAll', async () => rows.map((Series) => ({ Series, notify_type: 'episode' })));
    t.mock.method(db.Watchlist, 'findAll', async () => []);
    tmdbAnswer = async (config) =>
        config.url.includes('/season/') ? { episodes: [] } : raw(Number(config.url.split('/').at(-1)));
    let release;
    const held = new Promise((resolve) => {
        release = resolve;
    });
    mazeAnswer = async (config) => {
        await held;
        return show(Number(config.url.split('/').at(-1)));
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let result;
    const request = require('../../src/calendar')
        .periodItems(1, '2026-11-20', '2026-12-01', {
            local: { chat: { timezone: 'Europe/Moscow' } },
            waitMs: 10
        })
        .then((value) => {
            result = value;
        });
    try {
        await new Promise((resolve) => setImmediate(resolve));
        t.mock.timers.tick(10);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(result?.failed, 5);
        assert.equal(requests.filter(([base]) => base.includes('tvmaze')).length, 1, 'no request for the later batch');
    } finally {
        release();
        await request;
    }
});

test('ponytail: an Ended flag cannot override an explicit incomplete order; unknown orders keep their fallback', () => {
    const id = 91220;
    const data = show(id, {
        status: 'Ended',
        _embedded: { seasons: [{ number: 1, episodeOrder: 10 }], episodes: [ep(1), ep(2), ep(3), ep(4)] }
    });
    const incomplete = provider.merge(raw(id), data, now);
    assert.equal(incomplete.tvmaze_season_complete, false);
    assert.equal(incomplete.seasons[0].finale_known, false);
    data._embedded.seasons[0].episodeOrder = null;
    assert.equal(provider.merge(raw(id), data, now).tvmaze_season_complete, true);
});

test('ponytail: startup rebuild resumes after the source marker matches the stored episode counts', async (t) => {
    const id = 91221;
    routes(
        id,
        show(id, {
            _embedded: {
                seasons: [{ number: 1, episodeOrder: 8, premiereDate: '2026-01-01' }],
                episodes: [ep(1), ep(2)]
            }
        })
    );
    const row = fakeSeries({
        tmdb_id: `tv_${id}`,
        episode_source: 'tvmaze',
        aired_episodes: '2026-01:1=8/360',
        release_seasons: null
    });
    t.mock.method(db.Series, 'findAll', async () => [row]);
    await require('../../src/cron/release-seasons').backfillReleaseSeasons();
    assert.equal(row.release_seasons, '2026:1');
});

test('ponytail: a broken replacement keeps the validated old snapshot until a later recovery succeeds', async () => {
    const id = 91222;
    const replacement = 91223;
    routes(id);
    await tmdb.getDetails(id, 'tv');
    let healthy = false;
    mazeAnswer = async (config) => {
        if (config.url === `/shows/${id}`) throw notFound();
        if (config.url === '/lookup/shows') return { id: replacement };
        assert.equal(config.url, `/shows/${replacement}`);
        return healthy ? show(replacement, { externals: { imdb: `tt${id}` } }) : { id: replacement };
    };
    const failed = await tmdb.getDetails(id, 'tv');
    assert.equal(failed.tvmaze_missing, true);
    assert.equal(failed.tvmaze_id, id);
    assert.equal(tvmaze.cachedShow(`tv_${id}`).id, id);
    healthy = true;
    const recovered = await tmdb.getDetails(id, 'tv');
    assert.equal(recovered.tvmaze_missing, false);
    assert.equal(recovered.tvmaze_id, replacement);
});

test('ponytail: a passed view deadline still serves cached facts and names without starting requests', async () => {
    const id = 91224;
    routes(id);
    await tmdb.getDetails(id, 'tv');
    const count = requests.length;
    const deadline = { promise: Promise.resolve(), passed: () => true };
    const details = await tmdb.getDetailsCached(id, 'tv', { deadline });
    const season = await tmdb.getSeasonDetailsCached(String(id), 1, 'ru-RU', { deadline });
    assert.equal(details.status, 'Returning Series');
    assert.equal(season.episodes[0].name, 'Пилот');
    assert.equal(requests.length, count);
});

test('ponytail: stale cached views do not bypass the queue cap with background refreshes', async () => {
    const ids = Array.from({ length: 8 }, (_, n) => 91240 + n);
    for (const id of ids) {
        routes(id);
        await tmdb.getDetails(id, 'tv');
    }
    mock.method(Date, 'now', () => now + 7 * 3600000);
    let release;
    const held = new Promise((resolve) => {
        release = resolve;
    });
    const asked = [];
    mazeAnswer = async (config) => {
        asked.push(config.url);
        await held;
        return show(Number(config.url.split('/').at(-1)));
    };
    await Promise.all(ids.map((id) => tvmaze.showFor(`tv_${id}`, { imdb: `tt${id}` }, { knownId: id })));
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asked.length, 4);
});

test('ponytail: recovered IDs with different numbering migrate silently before episode sends and history rebuild', async (t) => {
    const id = 91250;
    const replacement = 91251;
    routes(id);
    await tmdb.getDetails(id, 'tv');
    const row = fakeSeries(
        {
            tmdb_id: `tv_${id}`,
            tvmaze_id: id,
            episode_source: 'tvmaze',
            last_season: 1,
            last_episode: 2,
            completed_season: 1,
            kinopoisk_id: 1,
            aired_episodes: '2026-11:1=2/90',
            release_seasons: '2026:1'
        },
        [[10, 'episode']]
    );
    mazeAnswer = async (config) => {
        if (config.url === `/shows/${id}`) throw notFound();
        if (config.url === '/lookup/shows') return { id: replacement };
        return show(replacement, {
            externals: { imdb: `tt${id}` },
            _embedded: {
                seasons: [{ number: 2, episodeOrder: 2, premiereDate: '2026-11-24' }],
                episodes: [ep(1, { season: 2 }), ep(2, { season: 2 })]
            }
        });
    };
    await tmdb.getDetails(id, 'tv');
    t.mock.method(db.Series, 'findAll', async () => [row]);
    await require('../../src/cron/release-seasons').backfillReleaseSeasons();
    assert.equal(row.release_seasons, '2026:1', 'the new ID must not reinterpret the old monthly season numbers');
    const bot = fakeBot();
    await checkSeriesUpdates(bot, [row]);
    assert.equal(row.tvmaze_id, replacement);
    assert.deepEqual([row.last_season, row.last_episode], [2, 2]);
    assert.equal(bot.sent.length, 0);
    await checkSeriesUpdates(bot, [row]);
    assert.equal(bot.sent.length, 0);
});

test('ponytail: a late 404 cannot enqueue ID-recovery requests after the shared deadline', async (t) => {
    const id = 91260;
    routes(id);
    await tmdb.getDetails(id, 'tv');
    requests = [];
    let release;
    const held = new Promise((resolve) => {
        release = resolve;
    });
    mazeAnswer = async (config) => {
        if (config.url === `/shows/${id}`) {
            await held;
            throw notFound();
        }
        if (config.url === '/lookup/shows') return { id: 91261 };
        return show(91261, { externals: { imdb: `tt${id}` } });
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const deadline = tvmaze.viewDeadline(10);
    const work = provider.resolve(String(id), async () => raw(id), { fresh: true, deadline });
    try {
        await new Promise((resolve) => setImmediate(resolve));
        t.mock.timers.tick(10);
        const result = await work;
        assert.equal(result.tvmaze_missing, true);
    } finally {
        release();
        deadline.cancel();
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
        requests.filter(([base]) => base.includes('tvmaze')).map(([, url]) => url),
        [`/shows/${id}`]
    );
});

test('ponytail: replacement IDs can move the season number backwards without freezing future episodes', async () => {
    const id = 91270;
    const replacement = 91271;
    routes(
        id,
        show(id, {
            _embedded: {
                seasons: [{ number: 3, episodeOrder: 2 }],
                episodes: [ep(1, { season: 3 }), ep(2, { season: 3 })]
            }
        })
    );
    await tmdb.getDetails(id, 'tv');
    const row = fakeSeries(
        {
            tmdb_id: `tv_${id}`,
            tvmaze_id: id,
            episode_source: 'tvmaze',
            last_season: 3,
            last_episode: 2,
            completed_season: 3,
            kinopoisk_id: 1,
            aired_episodes: '2026-11:3=2/90',
            release_seasons: '2026:3'
        },
        [[10, 'episode']]
    );
    mazeAnswer = async (config) => {
        if (config.url === `/shows/${id}`) throw notFound();
        if (config.url === '/lookup/shows') return { id: replacement };
        return show(replacement, {
            externals: { imdb: `tt${id}` },
            _embedded: {
                seasons: [{ number: 1, episodeOrder: 3, premiereDate: '2026-11-24' }],
                episodes: [ep(1), ep(2), ep(3, { airdate: '2026-11-26', airstamp: '2026-11-26T12:00:00Z' })]
            }
        });
    };
    const bot = fakeBot();
    await checkSeriesUpdates(bot, [row]);
    assert.deepEqual([row.last_season, row.last_episode], [1, 2]);
    assert.equal(bot.sent.length, 0);
    mock.method(Date, 'now', () => now + 48 * 3600000);
    await checkSeriesUpdates(bot, [row]);
    assert.deepEqual([row.last_season, row.last_episode], [1, 3]);
    assert.equal(bot.sent.length, 1);
});

test('ponytail: a late initial lookup cannot enqueue a snapshot after the shared deadline', async (t) => {
    const id = 91280;
    let release;
    const held = new Promise((resolve) => {
        release = resolve;
    });
    mazeAnswer = async (config) => {
        if (config.url === '/lookup/shows') {
            await held;
            return { id };
        }
        return show(id);
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const deadline = tvmaze.viewDeadline(10);
    const work = tvmaze.showFor(`tv_${id}`, { imdb: `tt${id}` }, { deadline });
    try {
        await new Promise((resolve) => setImmediate(resolve));
        t.mock.timers.tick(10);
        assert.equal(await work, undefined);
    } finally {
        release();
        deadline.cancel();
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
        requests.filter(([base]) => base.includes('tvmaze')).map(([, url]) => url),
        ['/lookup/shows']
    );
});

test('audit: an empty primary schedule preserves migration progress until history returns', async () => {
    const id = 91301;
    const empty = show(id, { _embedded: { episodes: [], seasons: [{ number: 1, episodeOrder: 2 }] } });
    routes(id, empty);
    const row = fakeSeries(
        {
            tmdb_id: `tv_${id}`,
            episode_source: 'tmdb',
            last_episode: 2,
            completed_season: 1,
            kinopoisk_id: 1,
            aired_episodes: '2026-11:1=2/90',
            release_seasons: '2026:1'
        },
        [[10, 'episode']]
    );
    const bot = fakeBot();
    await checkSeriesUpdates(bot, [row]);
    assert.equal(row.episode_source, 'tmdb');
    assert.equal(row.last_episode, 2);
    assert.equal(row.aired_episodes, '2026-11:1=2/90');
    assert.equal(row.release_seasons, '2026:1');
    routes(id);
    await checkSeriesUpdates(bot, [row]);
    assert.equal(row.episode_source, 'tvmaze');
    assert.equal(row.last_episode, 2);
    assert.equal(bot.sent.length, 0);
});

test('audit: an empty schedule cannot erase the history of an existing TVmaze series', async () => {
    const id = 91302;
    routes(id, show(id, { _embedded: { episodes: [], seasons: [] } }));
    const row = fakeSeries({
        tmdb_id: `tv_${id}`,
        tvmaze_id: id,
        episode_source: 'tvmaze',
        last_episode: 2,
        kinopoisk_id: 1,
        aired_episodes: '2026-11:1=2/90',
        release_seasons: '2026:1'
    });
    await checkSeriesUpdates(fakeBot(), [row]);
    assert.equal(row.release_seasons, '2026:1');
    assert.equal(row.updates.length, 0);
});

test('audit: the reserve rating source survives saving and a restart while TMDB is down', async () => {
    const id = 91303;
    const data = show(id, { rating: { average: null } });
    const original = raw(id, { vote_average: 8.5 });
    // merge alone does not retain an in-memory result: only the saved row seeds this restart.
    const fields = tmdb.newSeriesFields(provider.merge(original, data, now));
    routes(id, data);
    tmdbAnswer = async () => {
        throw new Error('TMDB offline');
    };
    const result = await tmdb.getDetails(id, 'tv', { fallbackSeries: { tmdb_id: `tv_${id}`, ...fields } });
    assert.equal(result.vote_average, 8.5);
    assert.equal(result.rating_source, 'tmdb');
    assert.equal(fields.rating_source, 'tmdb');
});

test('audit: legacy primary rows without rating provenance do not invent a source', async () => {
    const id = 91304;
    routes(id, show(id, { rating: { average: null } }));
    tmdbAnswer = async () => {
        throw new Error('TMDB offline');
    };
    const result = await tmdb.getDetails(id, 'tv', {
        fallbackSeries: {
            tmdb_id: `tv_${id}`,
            tvmaze_id: id,
            episode_source: 'tvmaze',
            title: 'Saved',
            rating: 8.5
        }
    });
    assert.equal(result.vote_average, 8.5);
    assert.equal(result.rating_source, 'unknown');
});

test('agent review: a normalized fallback keeps the original TMDB cursor through migration', async () => {
    const id = 91401;
    routes(
        id,
        show(id, {
            _embedded: {
                seasons: [{ number: 1, episodeOrder: 2 }],
                episodes: [ep(1), ep(2, { airdate: '2026-11-25', airstamp: '2026-11-25T12:00:00Z' })]
            }
        }),
        raw(id, {
            last_episode_to_air: {
                season_number: 1,
                episode_number: 1,
                name: 'Already announced',
                air_date: '2026-11-25'
            }
        })
    );
    await tmdb.getDetailsCached(id, 'tv');
    tmdbAnswer = async () => {
        throw new Error('TMDB offline');
    };
    const row = fakeSeries(
        {
            tmdb_id: `tv_${id}`,
            episode_source: 'tmdb',
            last_season: 1,
            last_episode: 1,
            completed_season: 1,
            kinopoisk_id: 1,
            aired_episodes: '',
            release_seasons: ''
        },
        [[10, 'episode']]
    );
    const bot = fakeBot();
    await checkSeriesUpdates(bot, [row]);
    assert.equal(row.last_episode, 2, 'the already announced TMDB episode maps to TVmaze episode 2');
    mock.method(Date, 'now', () => now + 48 * 3600000);
    await checkSeriesUpdates(bot, [row]);
    assert.equal(bot.sent.length, 0);
});

test('agent review: a late startup scan cannot overwrite the migrated episode counts', async (t) => {
    const id = 91402;
    let primaryUp = false,
        release,
        started;
    const held = new Promise((resolve) => {
        release = resolve;
    });
    const began = new Promise((resolve) => {
        started = resolve;
    });
    const original = raw(id, {
        status: 'Returning Series',
        seasons: [{ season_number: 2, episode_count: 2 }],
        last_episode_to_air: { season_number: 2, episode_number: 2, air_date: '2020-01-02' }
    });
    const data = show(id, {
        _embedded: {
            seasons: [{ number: 1, episodeOrder: 2, premiereDate: '2020-01-01' }],
            episodes: [1, 2].map((n) =>
                ep(n, { airdate: `2020-01-0${n}`, airstamp: `2020-01-0${n}T10:00:00Z`, airtime: '10:00' })
            )
        }
    });
    mazeAnswer = async (config) => {
        if (!primaryUp) throw new Error('temporary outage');
        return config.url === '/lookup/shows' ? { id } : data;
    };
    tmdbAnswer = async (config) => {
        if (config.url.endsWith('/season/2')) {
            started();
            await held;
            return {
                episodes: [1, 2].map((n) => ({
                    season_number: 2,
                    episode_number: n,
                    air_date: `2020-01-0${n}`,
                    runtime: 45
                }))
            };
        }
        return config.url.includes('/season/') ? { episodes: [] } : { ...original };
    };
    const row = fakeSeries({
        tmdb_id: `tv_${id}`,
        episode_source: 'tmdb',
        last_season: 2,
        last_episode: 2,
        completed_season: 2,
        kinopoisk_id: 1,
        genres: 'Drama',
        aired_episodes: null,
        release_seasons: '2020:2'
    });
    t.mock.method(db.Series, 'findAll', async () => [row]);
    const background = require('../../src/cron/aired-episodes').backfillAiredEpisodes();
    try {
        await began;
        primaryUp = true;
        await checkSeriesUpdates(fakeBot(), [row]);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(row.aired_episodes, '2020-01:1=2/90');
    } finally {
        release();
        await background;
    }
    assert.equal(row.episode_source, 'tvmaze');
    assert.equal(row.aired_episodes, '2020-01:1=2/90');
    assert.equal(row.release_seasons, '2020:1');
});

test('planned notification time: primary calendar rows retain their source through bell calculation', async (t) => {
    const id = 91501;
    routes(
        id,
        show(id, {
            _embedded: {
                seasons: [{ number: 1, episodeOrder: 2, premiereDate: '2026-11-24' }],
                episodes: [ep(1), ep(2, { airdate: '2026-11-27', airstamp: '2026-11-28T09:30:00Z', airtime: '23:30' })]
            }
        })
    );
    const row = fakeSeries({ tmdb_id: `tv_${id}`, last_season: 1, episode_source: 'tvmaze' });
    t.mock.method(db.Subscription, 'findAll', async () => [{ Series: row, notify_type: 'episode' }]);
    t.mock.method(db.Watchlist, 'findAll', async () => []);
    const { items } = await require('../../src/calendar').periodItems(1, '2026-11-24', '2026-11-30', {
        local: { chat: { timezone: 'Europe/Moscow' } }
    });
    const item = items.find((i) => i.episode === 2);
    assert.equal(item.episodeSource, 'tvmaze');
    const send = require('../../src/account/notify-day').notifyDays([item], { timezone: 'Europe/Moscow' })[0];
    assert.equal(send.sendAt, '2026-11-28T12:00:00.000Z');
    assert.equal(send.sendKind, 'timed');
});
