/** Exercise the actual test-send route without Telegram, external APIs or database writes. */
const { test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { listenForTest } = require('./http-server');
const tmdb = require('../../src/api/tmdb');
const kinopoisk = require('../../src/api/kinopoisk');
const axios = require('axios');
const realKinopoiskQuick = kinopoisk.kinopoiskQuick;
const { Chat, Watchlist } = require('../../src/db');
const { buildFilmMessage } = require('../../src/cron/messages');
const { formatWatchLinks } = require('../../src/constants');

let data;
let ru;
let pending;
let useRealLookup;
let sent;
let sentExtra;
let base;
let close;
const NOW = Date.parse('2026-11-09T20:30:00Z');
const TODAY = '2026-11-10'; // Asia/Irkutsk is already on the next calendar day.
mock.method(kinopoisk, 'findKinopoiskIdQuick', async () => 123);
mock.method(kinopoisk, 'kinopoiskQuick', async (...args) =>
    useRealLookup ? realKinopoiskQuick(...args) : { kinopoiskId: 123, ru, pending }
);

before(async () => {
    const app = express();
    app.use(express.json());
    app.set('bot', {
        botInfo: { username: 'notfckbot', has_main_web_app: true },
        telegram: {
            sendPhoto: async (_id, _photo, extra) => {
                sentExtra = extra;
                sent = extra.caption;
            },
            sendMessage: async (_id, text, extra) => {
                sentExtra = extra;
                sent = text;
            }
        }
    });
    app.use(require('../../src/admin/routes/actions'));
    ({ base, close } = await listenForTest(app));
});
after(() => close());

for (const [digital, source] of [
    ['2026-11-10', 'fresh'],
    ['2026-11-11', 'fresh'],
    [null, 'fresh'],
    ['2026-11-10', 'pending'],
    ['2026-11-10', 'failed'],
    [null, 'empty'],
    [null, 'pending-untracked'],
    ['2026-11-10', 'failed-id'],
    [null, 'empty-id']
]) {
    test(`film test uses recipient day and Russian dates, digital=${digital}, source=${source}`, async (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: NOW });
        useRealLookup = source.endsWith('-id');
        if (useRealLookup) {
            t.mock.method(axios, 'get', async (url) => {
                if (source === 'failed-id') throw new Error('Synthetic lookup outage');
                return { data: url.includes('wikidata') ? { results: { bindings: [] } } : { items: [] } };
            });
        }
        t.mock.method(Chat, 'findByPk', async () => ({ timezone: 'Asia/Irkutsk' }));
        data = {
            title: 'Russian film',
            release_date: '2025-11-12',
            cinema_ru_date: '2026-11-12',
            origin_country: ['RU'],
            status: 'Released',
            poster_path: '/poster.jpg'
        };
        const stored = { premiere: '2026-11-05', digital: '2026-11-10', services: ['START'] };
        pending = source.startsWith('pending');
        ru =
            source === 'fresh'
                ? { premiere: '2026-11-05', digital, services: digital ? ['START'] : [] }
                : { ...kinopoisk.NO_DATES, ...(source === 'failed' ? { failed: true } : {}) };
        t.mock.method(Watchlist, 'findOne', async () =>
            source === 'pending-untracked'
                ? null
                : { ru_premiere: stored.premiere, ru_digital: stored.digital, ru_services: 'START' }
        );
        const expectedRu = ['pending', 'failed', 'failed-id'].includes(source) ? stored : ru;
        t.mock.method(tmdb, 'getDetails', async () => data);
        const response = await fetch(`${base}/api/test-notification`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chatId: 1,
                mode: 'film',
                filmId: useRealLookup ? `movie_900${source === 'failed-id' ? 1 : 2}` : 'movie_7'
            })
        });
        assert.equal(response.status, 200);
        const target = useRealLookup ? `movie_900${source === 'failed-id' ? 1 : 2}` : 'movie_7';
        assert.deepEqual(sentExtra.reply_markup.inline_keyboard, [
            [{ text: 'Открыть WebApp', url: `https://t.me/notfckbot?startapp=c1_${target}` }]
        ]);
        const links = formatWatchLinks({
            title: data.title,
            kinopoiskId: useRealLookup ? null : 123,
            mediaType: 'movie',
            watch: digital === TODAY
        });
        const real = buildFilmMessage({
            entry: { title: data.title, year: 2026 },
            data,
            ru: expectedRu,
            now: new Date(NOW),
            today: TODAY,
            links
        });
        assert.equal(sent, '🧪 <b>[Тестовое уведомление]</b>\n\n' + real);
    });
}
