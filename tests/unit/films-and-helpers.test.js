/**
 * Film release decisions and the helpers behind every notification: dates, the next
 * episode, watch links. Run: npm run test:unit
 */
// Dates are formatted the way the server does it, in UTC, whatever machine runs the tests
process.env.TZ = 'UTC';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildFilmMessage, buildPremiereMessage } = require('../../src/cron/messages');
const { nextEpisodeFields, firstRelease } = require('../../src/api/tmdb');
const { getWatchLinks, formatWatchLinks, formatDigitalDate, isFinishedStatus } = require('../../src/constants');

const NOW = new Date('2026-10-12T12:00:00Z');

describe('buildFilmMessage', () => {
    const entry = { title: 'Дюна & Co', year: 2026 };

    test('"Фильм вышел", title escaped, year and the links; no cinema date', () => {
        const msg = buildFilmMessage({
            entry,
            data: { release_date: '2026-08-01', digital_release_date: '2026-10-01' },
            links: '<LINKS>',
            now: NOW
        });
        assert.match(msg, /^🎬 <b>Фильм вышел!<\/b>/);
        assert.match(msg, /Дюна &amp; Co<\/b> \(2026\)/);
        assert.doesNotMatch(msg, /Дата релиза|Премьера в России/);
        assert.ok(msg.endsWith('\n\n<LINKS>'));
    });

    test('no digital release known (45 days after the cinema): says the date is a guess', () => {
        const msg = buildFilmMessage({ entry, data: { release_date: '2026-08-01' }, links: '', now: NOW });
        assert.match(msg, /Даты цифрового релиза нет — обычно к этому сроку фильм уже онлайн/);
    });

    test('a digital release still ahead is marked as expected; a past one is not', () => {
        const ahead = buildFilmMessage({
            entry,
            data: { release_date: '2026-10-01', digital_release_date: '2026-11-20' },
            links: '',
            now: NOW
        });
        assert.match(ahead, /Цифровой релиз: <b>20 ноября 2026 г\.<\/b> \(ожидается\)/);

        const past = buildFilmMessage({
            entry,
            data: { release_date: '2026-09-01', digital_release_date: '2026-10-05' },
            links: '',
            now: NOW
        });
        assert.match(past, /Цифровой релиз: <b>5 октября 2026 г\.<\/b>\n/);
        assert.doesNotMatch(past, /ожидается/);
    });

    test('no date at all: no date lines, no year', () => {
        const msg = buildFilmMessage({ entry: { title: 'X' }, data: { status: 'Released' }, links: '', now: NOW });
        assert.doesNotMatch(msg, /Цифровой релиз|Даты цифрового/);
        assert.doesNotMatch(msg, /\(\d{4}\)/);
    });

    test('the director, escaped', () => {
        const msg = buildFilmMessage({ entry, data: { director_name: 'A <B>' }, links: '', now: NOW });
        assert.match(msg, /Режиссер: <b>A &lt;B&gt;<\/b>/);
    });
});

describe('buildPremiereMessage', () => {
    test('the cinema release with its country, a promise to write again, the info link', () => {
        const msg = buildPremiereMessage({
            entry: { title: 'Как ограбить банк', year: 2026 },
            data: { director_name: 'Дэвид Литч' },
            premiere: { date: '2026-11-11', country: 'US' },
            links: '<INFO>'
        });
        assert.match(msg, /^🎞 <b>Премьера в кино!<\/b>/);
        assert.match(msg, /Дата релиза: <b>11 ноября 2026 г\.<\/b> \(США\)/);
        assert.match(msg, /Онлайн фильма пока нет — напишу, когда выйдет\./);
        assert.ok(msg.endsWith('\n\n<INFO>'));
    });
});

describe('firstRelease', () => {
    const dates = {
        results: [
            { iso_3166_1: 'US', release_dates: [{ type: 1, release_date: '2026-09-01T00:00:00.000Z' }] },
            { iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '2026-11-11T00:00:00.000Z' }] },
            { iso_3166_1: 'RU', release_dates: [{ type: 3, release_date: '2026-11-19T00:00:00.000Z' }] },
            { iso_3166_1: 'DE', release_dates: [{ type: 4, release_date: '2026-12-20T00:00:00.000Z' }] }
        ]
    };

    test('the earliest of one type: a festival screening is not a cinema release', () => {
        assert.deepEqual(firstRelease(dates, 3), { date: '2026-11-11', country: 'US' });
        assert.deepEqual(firstRelease(dates, 3, 'RU'), { date: '2026-11-19', country: 'RU' });
        assert.deepEqual(firstRelease(dates, 4), { date: '2026-12-20', country: 'DE' });
        assert.deepEqual(firstRelease(null, 3), { date: null, country: null });
    });
});

describe('nextEpisodeFields', () => {
    test('the announced episode', () => {
        assert.deepEqual(
            nextEpisodeFields({ next_episode_to_air: { air_date: '2026-10-15', season_number: 2, episode_number: 8 } }),
            {
                next_episode_date: '2026-10-15',
                next_episode_season: 2,
                next_episode_number: 8
            }
        );
    });

    test('season 0 (specials) is a real season; a missing date stays null', () => {
        assert.deepEqual(
            nextEpisodeFields({ next_episode_to_air: { air_date: null, season_number: 0, episode_number: 3 } }),
            {
                next_episode_date: null,
                next_episode_season: 0,
                next_episode_number: 3
            }
        );
    });

    test('nothing announced', () => {
        assert.deepEqual(nextEpisodeFields({ next_episode_to_air: null }), {
            next_episode_date: null,
            next_episode_season: null,
            next_episode_number: null
        });
    });
});

describe('watch links', () => {
    test('with a Kinopoisk ID: SSPoisk and Kinopoisk, straight to the title; no HDRezka', () => {
        const links = getWatchLinks({ title: 'Dune', kinopoiskId: 123, mediaType: 'movie' });
        assert.deepEqual(
            links.map((l) => l.url),
            ['https://www.sspoisk.ru/film/123/', 'https://www.kinopoisk.ru/film/123/']
        );
    });

    test('a series links to /series/ on Kinopoisk and SSPoisk', () => {
        const links = getWatchLinks({ title: 'X', kinopoiskId: 7, mediaType: 'tv' });
        assert.equal(links[0].url, 'https://www.sspoisk.ru/series/7/');
    });

    test('without an ID: no SSPoisk, Kinopoisk falls back to a search', () => {
        const links = getWatchLinks({ title: 'Тёмная материя', kinopoiskId: null, mediaType: 'tv' });
        assert.equal(links.length, 1);
        assert.ok(links[0].url.startsWith('https://www.kinopoisk.ru/index.php?kp_query=%D0'));
    });

    test('the HTML block escapes & in hrefs for Telegram', () => {
        const html = formatWatchLinks({ title: 'A&B', kinopoiskId: null, mediaType: 'movie' });
        assert.match(html, /href="https:\/\/www\.kinopoisk\.ru\/index\.php\?kp_query=A%26B"/);
        assert.doesNotMatch(html, /rezka/);
    });
});

describe('small helpers', () => {
    test('formatDigitalDate', () => {
        assert.equal(formatDigitalDate('2026-11-18'), '18 ноября 2026 г.');
        assert.equal(formatDigitalDate(null), 'дата не объявлена');
        assert.equal(formatDigitalDate('not a date'), 'дата не объявлена');
    });

    test('isFinishedStatus', () => {
        assert.equal(isFinishedStatus('Ended'), true);
        assert.equal(isFinishedStatus('Canceled'), true);
        assert.equal(isFinishedStatus('Returning Series'), false);
        assert.equal(isFinishedStatus(null), false);
    });
});
