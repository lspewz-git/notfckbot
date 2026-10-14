/**
 * A series added to the tracked list (from the bot or the panel) starts at its latest aired
 * episode: the first update check after that must announce nothing that was already out.
 * Run: npm run test:unit
 */
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { notifyNewEpisodes } = require('../../src/cron');
const { newSeriesFields } = require('../../src/api/tmdb');
const { fakeBot, ep, tmdbSeries, kindOf } = require('./fakes');

mock.method(console, 'log', () => {});
// A chat's settings (quiet hours) come from the database: none here, so none set
mock.method(require('../../src/db').Chat, 'findByPk', async () => null);

/** A Series row made from `fields`, with subscribers in every mode, as the update check sees it. */
function trackedRow(fields) {
    const row = {
        tmdb_id: 'tv_66732',
        kinopoisk_id: null,
        completed_season: null,
        ...fields,
        Chats: [
            [1, 'episode'],
            [2, 'season'],
            [3, 'first_and_full']
        ].map(([id, mode]) => ({ id, Subscription: { notify_type: mode } })),
        async update(changes) {
            Object.assign(row, changes);
        }
    };
    return row;
}

// Stranger Things when it was added: season 5 complete, nothing more announced
const OUT_ALREADY = {
    ...tmdbSeries({ last: ep(5, 8, 'Finale'), seasons: { 5: 8 } }),
    name: 'Очень странные дела',
    status: 'Ended',
    poster_path: null
};

test('a series added after its season is out: the first check sends nothing', async () => {
    const bot = fakeBot();
    const row = trackedRow(newSeriesFields(OUT_ALREADY));
    assert.deepEqual([row.last_season, row.last_episode], [5, 8]);
    await notifyNewEpisodes(bot, row, OUT_ALREADY);
    assert.deepEqual(bot.sent, []);
});

test('what the panel used to store (season 5, episode 0) announced the finale and the season', async () => {
    // The bug this guards against, kept as a record of why the starting point matters
    const bot = fakeBot();
    await notifyNewEpisodes(bot, trackedRow({ last_season: 5, last_episode: 0 }), OUT_ALREADY);
    assert.ok(bot.sent.length > 0);
    assert.ok(bot.sent.some((m) => kindOf(m.text) === 'complete'));
});

test('an episode that airs after the series was added is announced', async () => {
    const bot = fakeBot();
    const added = { ...tmdbSeries({ last: ep(2, 3), next: ep(2, 4), seasons: { 2: 8 } }), name: 'X' };
    const row = trackedRow(newSeriesFields(added));
    await notifyNewEpisodes(bot, row, tmdbSeries({ last: ep(2, 4), next: ep(2, 5), seasons: { 2: 8 } }));
    assert.deepEqual(
        bot.sent.map((m) => `${m.chatId}:${kindOf(m.text)}`),
        ['1:episode']
    );
});

test('nothing aired yet: the series starts at season 0, so its first episode is announced', async () => {
    const upcoming = { ...tmdbSeries({ last: null, next: ep(1, 1), seasons: { 1: 8 } }), name: 'New' };
    const fields = newSeriesFields(upcoming);
    assert.deepEqual([fields.last_season, fields.last_episode], [0, 0]);

    const bot = fakeBot();
    await notifyNewEpisodes(bot, trackedRow(fields), tmdbSeries({ last: ep(1, 1), next: ep(1, 2), seasons: { 1: 8 } }));
    assert.deepEqual(bot.sent.map((m) => `${m.chatId}:${kindOf(m.text)}`).sort(), ['1:episode', '3:premiere']);
});
