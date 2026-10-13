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
    if (text.includes('Весь сезон вышел')) return 'complete';
    if (text.includes('Сериал завершён')) return 'ended';
    if (text.includes('Сериал отменён')) return 'canceled';
    if (text.includes('Сериал продлили')) return 'renewed';
    return 'other';
}

module.exports = { fakeBot, fakeSeries, ep, tmdbSeries, kindOf };
