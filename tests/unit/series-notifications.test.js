/**
 * Who gets which series notification, and what the check records afterwards.
 * Run: npm run test:unit
 */
const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const { notifyNewEpisodes, notifyStatusChange, isSeasonComplete, buildSeriesMessages } = require('../../src/cron');
const { fakeBot, fakeSeries, ep, tmdbSeries, kindOf } = require('./fakes');

// A chat's settings (quiet hours) come from the database: none here, so none set
mock.method(require('../../src/db').Chat, 'findByPk', async () => null);
// A send that fails for good is kept for the dashboard (src/send-failures.js): not here
mock.method(require('../../src/db').SendFailure, 'create', async () => {});
mock.method(require('../../src/db').SendFailure, 'destroy', async () => 0);

const kinds = (bot) => bot.sent.map((m) => `${m.chatId}:${kindOf(m.text)}`);

describe('isSeasonComplete', () => {
    test('the last episode reached the count and nothing more is announced', () => {
        assert.equal(isSeasonComplete(tmdbSeries({ last: ep(2, 8), seasons: { 2: 8 } }), 2, 8), true);
    });

    test('not while TMDB announces another episode of the same season', () => {
        const data = tmdbSeries({ last: ep(2, 8), next: ep(2, 9), seasons: { 2: 8 } });
        assert.equal(isSeasonComplete(data, 2, 8), false);
    });

    test('an announced episode of the next season does not hold it back', () => {
        const data = tmdbSeries({ last: ep(2, 8), next: ep(3, 1), seasons: { 2: 8 } });
        assert.equal(isSeasonComplete(data, 2, 8), true);
    });

    test('not mid-season, and not when TMDB has no episode count', () => {
        assert.equal(isSeasonComplete(tmdbSeries({ last: ep(2, 5), seasons: { 2: 8 } }), 2, 5), false);
        assert.equal(isSeasonComplete(tmdbSeries({ last: ep(2, 5), seasons: {} }), 2, 5), false);
    });
});

describe('notifyNewEpisodes: "every episode" mode', () => {
    test('a new episode is announced and recorded', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 2, last_episode: 3, completed_season: 1 }, [[10, 'episode']]);
        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(2, 4, 'Pilot'), seasons: { 2: 8 } }));

        assert.deepEqual(kinds(bot), ['10:episode']);
        assert.match(bot.sent[0].text, /Сезон 2, Серия 4: Pilot/);
        assert.equal(show.last_episode, 4);
        assert.equal(show.last_episode_name, 'Pilot');
    });

    test('nothing new: no message and no write', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 2, last_episode: 4, completed_season: 1 }, [[10, 'episode']]);
        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(2, 4), seasons: { 2: 8 } }));

        assert.equal(bot.sent.length, 0);
        assert.equal(show.updates.length, 0);
    });

    test('a new season counts as new, even at episode 1', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 1, last_episode: 8, completed_season: 1 }, [[10, 'episode']]);
        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(2, 1), seasons: { 1: 8, 2: 8 } }));

        assert.deepEqual(kinds(bot), ['10:episode']);
        assert.equal(show.last_season, 2);
    });

    test('no aired episode yet: nothing happens', async () => {
        const bot = fakeBot();
        const show = fakeSeries({}, [[10, 'episode']]);
        await notifyNewEpisodes(bot, show, tmdbSeries({ last: null, next: ep(1, 1) }));
        assert.equal(bot.sent.length, 0);
        assert.equal(show.updates.length, 0);
    });
});

describe('notifyNewEpisodes: "whole season" mode', () => {
    test('quiet mid-season, but the progress is still recorded', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 2, last_episode: 3, completed_season: 1 }, [[10, 'season']]);
        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(2, 4), next: ep(2, 5), seasons: { 2: 8 } }));

        assert.equal(bot.sent.length, 0);
        assert.equal(show.last_episode, 4);
    });

    test('the finale with nothing more announced: "season complete", once', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 2, last_episode: 7, completed_season: 1 }, [[10, 'season']]);
        const finale = tmdbSeries({ last: ep(2, 8), seasons: { 2: 8 } });

        await notifyNewEpisodes(bot, show, finale);
        assert.deepEqual(kinds(bot), ['10:complete']);
        assert.match(bot.sent[0].text, /Сезон 2 полностью доступен \(8 сер\.\)/);
        assert.equal(show.completed_season, 2);

        // The next check sees the same data: nothing again
        await notifyNewEpisodes(bot, show, finale);
        assert.equal(bot.sent.length, 1);
    });

    test('finale aired but TMDB still lists another episode: wait, then announce on a later check', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 2, last_episode: 7, completed_season: 1 }, [[10, 'season']]);

        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(2, 8), next: ep(2, 9), seasons: { 2: 8 } }));
        assert.equal(bot.sent.length, 0);
        assert.equal(show.last_episode, 8);

        // TMDB drops the announcement; no new episode, but the season is now complete
        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(2, 8), seasons: { 2: 8 } }));
        assert.deepEqual(kinds(bot), ['10:complete']);
        assert.equal(show.completed_season, 2);
    });
});

describe('notifyNewEpisodes: "1st episode + season" mode', () => {
    test('premiere on episode 1, quiet in between, "complete" at the end', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 1, last_episode: 6, completed_season: 1 }, [[10, 'first_and_full']]);

        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(2, 1), next: ep(2, 2), seasons: { 2: 3 } }));
        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(2, 2), next: ep(2, 3), seasons: { 2: 3 } }));
        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(2, 3), seasons: { 2: 3 } }));

        assert.deepEqual(kinds(bot), ['10:premiere', '10:complete']);
    });

    test('a one-episode season gets one message, not premiere and complete', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 1, last_episode: 6, completed_season: 1 }, [[10, 'first_and_full']]);
        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(2, 1), seasons: { 2: 1 } }));
        // And no "complete" later for the same season
        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(2, 1), seasons: { 2: 1 } }));

        assert.deepEqual(kinds(bot), ['10:premiere']);
        assert.equal(show.completed_season, 2);
    });
});

describe('notifyNewEpisodes: several subscribers', () => {
    test('each chat gets the message of its own mode', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 2, last_episode: 7, completed_season: 1 }, [
            [1, 'episode'],
            [2, 'season'],
            [3, 'first_and_full']
        ]);
        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(2, 8), seasons: { 2: 8 } }));
        assert.deepEqual(kinds(bot), ['1:episode', '2:complete', '3:complete']);
    });

    test('a chat that blocked the bot does not stop the others', async () => {
        const bot = fakeBot({ failFor: [1] });
        const show = fakeSeries({ last_season: 2, last_episode: 3, completed_season: 1 }, [
            [1, 'episode'],
            [2, 'episode']
        ]);
        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(2, 4), seasons: { 2: 8 } }));

        assert.deepEqual(kinds(bot), ['2:episode']);
        assert.equal(show.last_episode, 4);
    });

    test('with a poster the message is a photo caption', async () => {
        const bot = fakeBot();
        const show = fakeSeries(
            { last_season: 2, last_episode: 3, completed_season: 1, poster_url: 'https://image.tmdb.org/p.jpg' },
            [[10, 'episode']]
        );
        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(2, 4), seasons: { 2: 8 } }));
        assert.equal(bot.sent[0].photo, 'https://image.tmdb.org/p.jpg');
    });
});

describe('notifyNewEpisodes: first check of a show without completed_season', () => {
    test('an old, already complete season is taken as announced, not announced now', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 3, last_episode: 10, completed_season: null }, [[10, 'season']]);
        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(3, 10), seasons: { 3: 10 } }));

        assert.equal(bot.sent.length, 0);
        assert.equal(show.completed_season, 3);
    });

    test('a finale arriving on that very check is still announced', async () => {
        const bot = fakeBot();
        const show = fakeSeries({ last_season: 3, last_episode: 9, completed_season: null }, [[10, 'season']]);
        await notifyNewEpisodes(bot, show, tmdbSeries({ last: ep(3, 10), seasons: { 3: 10 } }));

        assert.deepEqual(kinds(bot), ['10:complete']);
        assert.equal(show.completed_season, 3);
    });
});

describe('notifyStatusChange', () => {
    const run = async (from, to) => {
        const bot = fakeBot();
        await notifyStatusChange(
            bot,
            fakeSeries({}, [
                [1, 'episode'],
                [2, 'season']
            ]),
            from,
            to
        );
        return kinds(bot);
    };

    test('a show that ended or was canceled: every subscriber is told', async () => {
        assert.deepEqual(await run('Returning Series', 'Ended'), ['1:ended', '2:ended']);
        assert.deepEqual(await run('Returning Series', 'Canceled'), ['1:canceled', '2:canceled']);
    });

    test('a finished show renewed: every subscriber is told', async () => {
        assert.deepEqual(await run('Ended', 'Returning Series'), ['1:renewed', '2:renewed']);
    });

    test('quiet when nothing changes for the user', async () => {
        assert.deepEqual(await run('Ended', 'Canceled'), []);
        assert.deepEqual(await run('In Production', 'Returning Series'), []);
        // The first status fill is bookkeeping, not news
        assert.deepEqual(await run(null, 'Ended'), []);
    });
});

describe('buildSeriesMessages', () => {
    test('titles and episode names are escaped for Telegram HTML', () => {
        const m = buildSeriesMessages({
            title: 'Tom & Jerry <3',
            season: 1,
            episode: 2,
            episodeName: 'A<b>',
            links: ''
        });
        assert.match(m.episode, /Tom &amp; Jerry &lt;3/);
        assert.match(m.episode, /A&lt;b&gt;/);
        assert.doesNotMatch(m.episode, /<3/);
    });

    test('an episode without a name gets a placeholder', () => {
        const m = buildSeriesMessages({ title: 'X', season: 1, episode: 2, episodeName: '', links: '' });
        assert.match(m.episode, /Серия 2: Без названия/);
    });
});
