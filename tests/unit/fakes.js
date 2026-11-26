/**
 * Stand-ins for the bot, a Series row and a TMDB answer, so the notification logic
 * runs without Telegram, the database or the network.
 */

/** Records what would have been sent. `failFor`: chat ids whose sends throw. */
function fakeBot({ failFor = [] } = {}) {
    const sent = [];
    const send = async (chatId, text, photo) => {
        if (failFor.includes(chatId)) {
            // Shaped like Telegraf's TelegramError
            const description = 'Forbidden: bot was blocked by the user';
            throw Object.assign(new Error(description), { description, response: { error_code: 403, description } });
        }
        sent.push({ chatId, text, photo });
    };
    return {
        sent,
        telegram: {
            sendMessage: (chatId, text) => send(chatId, text, null),
            sendPhoto: (chatId, photo, opts) => send(chatId, opts.caption, photo)
        }
    };
}

/**
 * A Series row with its subscribers. `subscribers`: [[chatId, notify_type], ...].
 * `update()` applies the changes and keeps them, like Sequelize would.
 */
function fakeSeries(fields = {}, subscribers = []) {
    return {
        tmdb_id: 'tv_1',
        title: 'Test Show',
        poster_url: null,
        kinopoisk_id: null,
        status: 'Returning Series',
        last_season: 1,
        last_episode: 1,
        completed_season: 0,
        ...fields,
        Chats: subscribers.map(([id, mode]) => ({ id, Subscription: { notify_type: mode } })),
        updates: [],
        async update(changes) {
            Object.assign(this, changes);
            this.updates.push(changes);
        }
    };
}

/** An episode as TMDB describes it. */
const ep = (season, episode, name = `Episode ${episode}`) => ({
    season_number: season,
    episode_number: episode,
    name
});

/**
 * A TMDB series answer. `seasons`: { seasonNumber: episodeCount }.
 * `next`: the announced next episode, or null.
 */
const tmdbSeries = ({ last, next = null, seasons = {} }) => ({
    last_episode_to_air: last,
    next_episode_to_air: next,
    seasons: Object.entries(seasons).map(([n, count]) => ({ season_number: Number(n), episode_count: count }))
});

/** Which kind of series message a text is: episode, premiere, complete or a status note. */
function kindOf(text) {
    if (text.includes('Новая серия')) return 'episode';
    if (text.includes('Премьера сезона')) return 'premiere';
    if (text.includes('Вышли известные серии сезона')) return 'complete';
    if (text.includes('отмечен как завершённый')) return 'ended';
    if (text.includes('отмечен как отменённый')) return 'canceled';
    if (text.includes('Сериал снова в активных подписках')) return 'renewed';
    return 'other';
}

/** In-memory conditional UPDATE: the current saved row can differ from a worker's snapshot. */
function mockSeriesWrites(mock, rows) {
    const matching = (where) => {
        const row = rows instanceof Map ? rows.get(where.tmdb_id) : rows.find((r) => r.tmdb_id === where.tmdb_id);
        return row && Object.entries(where).every(([key, value]) => (row[key] ?? null) === value) ? row : null;
    };
    mock.method(require('../../src/db').Series, 'count', async ({ where }) => (matching(where) ? 1 : 0));
    return mock.method(require('../../src/db').Series, 'update', async (changes, { where }) => {
        const row = matching(where);
        if (!row) return [0];
        await row.update(changes);
        return [1];
    });
}

module.exports = { fakeBot, fakeSeries, ep, tmdbSeries, kindOf, mockSeriesWrites };
