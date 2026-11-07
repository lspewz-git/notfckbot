const test = require('node:test');
const assert = require('node:assert');
const { notifyDay } = require('../../src/account/notify-day');

const moscow = { timezone: 'Europe/Moscow', quiet_start: null, quiet_end: null };

test('the bell follows the mode: every episode, premiere and finale, or the finale only', () => {
    const ep = (mode, mark = '') => notifyDay({ kind: 'tv', date: '2026-11-12', mode, mark }, moscow);
    assert.equal(ep('episode'), '2026-11-13', 'an episode reaches the bot the day after its TMDB date');
    assert.equal(ep('first_and_full'), null);
    assert.equal(ep('first_and_full', 'premiere'), '2026-11-13');
    assert.equal(ep('first_and_full', 'finale'), '2026-11-13');
    assert.equal(ep('season'), null);
    assert.equal(ep('season', 'premiere'), null);
    assert.equal(ep('season', 'finale'), '2026-11-13');
    assert.equal(ep(null), null, 'no subscription mode, no message');
});

test('a film has no bell: the bot writes when it is online, not on its release date', () => {
    assert.equal(notifyDay({ kind: 'movie', date: '2026-12-01' }, moscow), null);
    assert.equal(notifyDay({ kind: 'movie', date: 'soon' }, moscow), null);
});

test('quiet hours that started before midnight move the message to the next day', () => {
    // 06 UTC is 16:00 in Kamchatka: quiet from 15 to 9 holds it until the next morning
    const kamchatka = { timezone: 'Asia/Kamchatka', quiet_start: 15, quiet_end: 9 };
    assert.equal(notifyDay({ kind: 'tv', date: '2026-11-12', mode: 'episode' }, kamchatka), '2026-11-14');
    // 09:00 in Moscow inside 0–10: held until 10:00 the same day
    const morning = { timezone: 'Europe/Moscow', quiet_start: 0, quiet_end: 10 };
    assert.equal(notifyDay({ kind: 'tv', date: '2026-11-12', mode: 'episode' }, morning), '2026-11-13');
    // Outside the hours nothing moves
    const night = { timezone: 'Europe/Moscow', quiet_start: 23, quiet_end: 8 };
    assert.equal(notifyDay({ kind: 'tv', date: '2026-11-12', mode: 'episode' }, night), '2026-11-13');
});

test('episodes out the same day give one message, about the last; a one-episode season is its finale', () => {
    const { notifyDays } = require('../../src/account/notify-day');
    const ep = (episode, extra = {}) => ({
        kind: 'tv',
        tmdbId: 'tv_1',
        date: '2026-11-12',
        season: 1,
        episode,
        ...extra
    });
    // A whole season dropped at once: only its finale's row gets the bell, whatever the mode
    for (const mode of ['episode', 'first_and_full', 'season'])
        assert.deepEqual(
            notifyDays(
                [ep(1, { mode, mark: 'premiere' }), ep(2, { mode }), ep(3, { mode, mark: 'finale', last: true })],
                moscow
            ),
            [null, null, '2026-11-13'],
            mode
        );
    // Episodes 1 and 2 together: no premiere message, the bot only sees episode 2
    assert.deepEqual(
        notifyDays([ep(1, { mode: 'first_and_full', mark: 'premiere' }), ep(2, { mode: 'first_and_full' })], moscow),
        [null, null]
    );
    // A season of one episode: marked a premiere, still the season's end
    assert.deepEqual(notifyDays([ep(1, { mode: 'season', mark: 'premiere', last: true })], moscow), ['2026-11-13']);
});

test('the episode send time follows the update interval', () => {
    const { notifyDay, episodeSendHour } = require('../../src/account/notify-day');
    assert.equal(episodeSendHour(3), 6);
    assert.equal(episodeSendHour(4), 8);
    assert.equal(episodeSendHour(5), 10);
    assert.equal(episodeSendHour(12), 12);
    // 06 UTC is 22:00 the day before in Los Angeles' -8, 08 UTC is midnight of the next day: our zones are
    // all east of UTC, so in Moscow both stay on the day after the TMDB date
    assert.equal(notifyDay({ kind: 'tv', date: '2026-11-12', mode: 'episode' }, moscow, 24), '2026-11-14');
});
