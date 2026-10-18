/**
 * The panel's test notifications: one for every alert the bot sends, each the real message
 * with a test mark in front. Run: npm run test:unit
 */
const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const { notifyStatusChange, buildSeriesMessages, buildFilmMessage } = require('../../src/cron');
const { buildTestMessage, TEST_MODES } = require('../../src/cron/messages');
const { fakeBot, fakeSeries } = require('./fakes');

// A chat's settings (quiet hours) come from the database: none here, so none set
mock.method(require('../../src/db').Chat, 'findByPk', async () => null);

const MARK = '🧪 <b>[Тестовое уведомление]</b>\n\n';
const parts = { title: 'Test Show', season: 2, episode: 8, episodeName: 'Finale', links: '<links>' };

test('every alert the bot sends can be tested', () => {
    assert.deepEqual(TEST_MODES, ['episode', 'first_and_full', 'season', 'ended', 'canceled', 'renewed', 'film']);
});

describe('episode alerts are the real messages, marked', () => {
    const real = buildSeriesMessages(parts);
    for (const [mode, key] of [
        ['episode', 'episode'],
        ['first_and_full', 'premiere'],
        ['season', 'complete']
    ]) {
        test(mode, () => assert.equal(buildTestMessage(mode, parts), MARK + real[key]));
    }
});

describe('status alerts are what a status change actually sends', () => {
    // [test mode, status before, status after]
    for (const [mode, from, to] of [
        ['ended', 'Returning Series', 'Ended'],
        ['canceled', 'Returning Series', 'Canceled'],
        ['renewed', 'Ended', 'Returning Series']
    ]) {
        test(`${mode}: ${from} -> ${to}`, async () => {
            const bot = fakeBot();
            await notifyStatusChange(bot, fakeSeries({ title: 'Test Show' }, [[1, 'episode']]), from, to);
            assert.equal(bot.sent.length, 1);
            assert.equal(buildTestMessage(mode, parts), MARK + bot.sent[0].text);
        });
    }
});

test('the film alert is the real "film is out" message, marked', () => {
    const film = {
        entry: { title: 'Test Film', year: 2026 },
        data: { release_date: '2026-03-01', director_name: 'Someone', digital_release_date: null }
    };
    const real = buildFilmMessage({ entry: film.entry, data: film.data, links: '<links>' });
    assert.equal(buildTestMessage('film', { film, links: '<links>' }), MARK + real);
});

test('status alerts put the title on a line of its own, so it is clear which show is meant', () => {
    const { buildStatusMessage } = require('../../src/cron/messages');
    for (const status of ['Ended', 'Canceled', 'Returning Series']) {
        const text = buildStatusMessage('Одни из нас', status);
        assert.match(text, /\n\n📺 <b>Одни из нас<\/b>\n\n/, status);
    }
    // And the name is escaped, as everywhere in HTML messages
    assert.match(buildStatusMessage('A <b> & C', 'Ended'), /📺 <b>A &lt;b&gt; &amp; C<\/b>/);
});
