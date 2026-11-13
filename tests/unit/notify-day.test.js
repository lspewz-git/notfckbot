const test = require('node:test');
const assert = require('node:assert');
const { notifyDay } = require('../../src/account/notify-day');

const moscow = { timezone: 'Europe/Moscow', quiet_start: null, quiet_end: null };

test('film bells use the first cron slot after chat-local midnight, even on the previous UTC day', () => {
    const irkutsk = { timezone: 'Asia/Irkutsk', quiet_start: 8, quiet_end: 4 };
    assert.equal(notifyDay({ kind: 'movie', event: 'release', date: '2026-11-09' }, irkutsk), '2026-11-09');
});

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

test("a film's Release row has its main notification, independently of digital information", () => {
    assert.equal(notifyDay({ kind: 'movie', event: 'online', date: '2026-12-01' }, moscow), null);
    assert.equal(notifyDay({ kind: 'movie', event: 'cinema', date: '2026-11-11' }, moscow), null);
    assert.equal(
        notifyDay({ kind: 'movie', event: 'release', date: '2026-11-11' }, moscow),
        '2026-11-11',
        'the selected cinema release is the main message day'
    );
    assert.equal(notifyDay({ kind: 'movie', date: 'soon' }, moscow), null);
});

test('quiet hours that started before midnight move the message to the next day', () => {
    // 09 UTC is 21:00 in Kamchatka: quiet from 15 to 9 holds it until the next morning
    const kamchatka = { timezone: 'Asia/Kamchatka', quiet_start: 15, quiet_end: 9 };
    assert.equal(notifyDay({ kind: 'tv', date: '2026-11-12', mode: 'episode' }, kamchatka), '2026-11-14');
    // 12:00 in Moscow inside 0–13: held until 13:00 the same day
    const morning = { timezone: 'Europe/Moscow', quiet_start: 0, quiet_end: 13 };
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
    // Episodes 1 and 2 together: the premiere goes out with episode 2, the one the bot sees
    assert.deepEqual(
        notifyDays([ep(1, { mode: 'first_and_full', mark: 'premiere' }), ep(2, { mode: 'first_and_full' })], moscow),
        [null, '2026-11-13']
    );
    // A later pair of the same season stays quiet
    assert.deepEqual(
        notifyDays(
            [
                ep(3, { mode: 'first_and_full', date: '2026-11-19' }),
                ep(4, { mode: 'first_and_full', date: '2026-11-19' })
            ],
            moscow
        ),
        [null, null]
    );
    // A season of one episode: marked a premiere, still the season's end
    assert.deepEqual(notifyDays([ep(1, { mode: 'season', mark: 'premiere', last: true })], moscow), ['2026-11-13']);
    // Shown on the arrival day: the bell still goes by TMDB's, as the update check does
    assert.deepEqual(
        notifyDays(
            [
                ep(1, { mode: 'episode', date: '2026-11-13', tmdbDate: '2026-11-12' }),
                ep(2, { mode: 'episode', date: '2026-11-13', tmdbDate: '2026-11-12' })
            ],
            moscow
        ),
        [null, '2026-11-13']
    );
});

test("an episode's arrival day is its message's day in the chat, whatever the mode", () => {
    const { episodeArrivalDay } = require('../../src/account/notify-day');
    const moscow = { timezone: 'Europe/Moscow' };
    assert.equal(episodeArrivalDay('2026-11-12', moscow, 3), '2026-11-13');
    assert.equal(episodeArrivalDay('2026-12-31', moscow, 3), '2027-01-01');
    assert.equal(episodeArrivalDay('2026-11-12', null, 3), '2026-11-13', 'no chat: the default zone');
    // 24-hour checks: the first slot after TMDB moves the episode is the next midnight
    assert.equal(episodeArrivalDay('2026-11-12', moscow, 24), '2026-11-14');
    // Every zone of ours gets it the day after TMDB's date
    for (const timezone of ['Europe/Kaliningrad', 'Asia/Yekaterinburg', 'Asia/Vladivostok', 'Asia/Kamchatka'])
        assert.equal(episodeArrivalDay('2026-11-12', { timezone }, 3), '2026-11-13', timezone);
    // Quiet hours hold the message, not the episode: its day stays (the bell's moves)
    const late = { timezone: 'Asia/Kamchatka', quiet_start: 18, quiet_end: 8 };
    assert.equal(episodeArrivalDay('2026-11-12', late, 3), '2026-11-13');
    const { notifyDay } = require('../../src/account/notify-day');
    assert.equal(notifyDay({ kind: 'tv', date: '2026-11-12', mode: 'episode' }, late, 3), '2026-11-14');
});

test("an episode out by TVmaze goes with the first check after that, if before TMDB's", () => {
    const { notifyDay, notifyDays, firstCheckFrom } = require('../../src/account/notify-day');
    const moscow = { timezone: 'Europe/Moscow' };
    assert.equal(firstCheckFrom(Date.parse('2026-11-13T01:50:00Z'), 3), Date.parse('2026-11-13T03:00:00Z'));
    assert.equal(firstCheckFrom(Date.parse('2026-11-13T03:00:00Z'), 3), Date.parse('2026-11-13T03:00:00Z'));
    assert.equal(firstCheckFrom(Date.parse('2026-11-13T21:30:00Z'), 5), Date.parse('2026-11-14T00:00:00Z'));
    const tv = { kind: 'tv', mode: 'episode', date: '2026-11-12' };
    // Out at 01:50 UTC on the 13th: the 03:00 check, 06:00 in Moscow, the 13th
    assert.equal(notifyDay({ ...tv, outAt: Date.parse('2026-11-13T01:50:00Z') }, moscow, 3), '2026-11-13');
    // Out late on the 13th by TVmaze: TMDB moves it first (09:00 UTC), still the 13th
    assert.equal(notifyDay({ ...tv, outAt: Date.parse('2026-11-13T22:00:00Z') }, moscow, 3), '2026-11-13');
    // Out by TVmaze the evening before TMDB's US day ends: the check that evening, the 12th
    assert.equal(notifyDay({ ...tv, outAt: Date.parse('2026-11-12T17:00:00Z') }, moscow, 3), '2026-11-12');
    // Two out by different checks: each gets its message (not one for the TMDB day)
    const ep = (episode, outAt) => ({
        kind: 'tv',
        tmdbId: 'tv_1',
        season: 1,
        episode,
        mode: 'episode',
        date: '2026-11-13',
        tmdbDate: '2026-11-12',
        outAt
    });
    assert.deepEqual(
        notifyDays([ep(1, Date.parse('2026-11-12T17:00:00Z')), ep(2, Date.parse('2026-11-12T23:00:00Z'))], moscow, 3),
        ['2026-11-12', '2026-11-13']
    );
    // Found by the same check: one message, about the later
    assert.deepEqual(
        notifyDays([ep(1, Date.parse('2026-11-13T01:10:00Z')), ep(2, Date.parse('2026-11-13T02:00:00Z'))], moscow, 3),
        [null, '2026-11-13']
    );
});

test('the episode send time follows the update interval', () => {
    const { notifyDay, episodeSendHour } = require('../../src/account/notify-day');
    // The first check after 08 UTC: 13.11 "12 12 12" (TMDB 12.11) was not out at 06:00 and went at 09:00
    assert.equal(episodeSendHour(3), 9);
    assert.equal(episodeSendHour(4), 12);
    assert.equal(episodeSendHour(5), 10);
    assert.equal(episodeSendHour(12), 12);
    assert.equal(episodeSendHour(24), 24);
    // Daily checks run at 00 UTC: the next midnight, two days after the TMDB date
    assert.equal(notifyDay({ kind: 'tv', date: '2026-11-12', mode: 'episode' }, moscow, 24), '2026-11-14');
});
