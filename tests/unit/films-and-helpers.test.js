/**
 * Film release decisions and the helpers behind every notification: dates, the next
 * episode, watch links. Run: npm run test:unit
 */
// Dates are formatted the way the server does it, in UTC, whatever machine runs the tests
process.env.TZ = 'UTC';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isMovieReleased, buildFilmMessage } = require('../../src/cron');
const { nextEpisodeFields } = require('../../src/api/tmdb');
const { getWatchLinks, formatWatchLinks, formatDigitalDate, isFinishedStatus } = require('../../src/constants');

const NOW = new Date('2026-10-12T12:00:00Z');

describe('isMovieReleased', () => {
    test('TMDB says Released', () => {
        assert.equal(isMovieReleased({ status: 'Released', release_date: '2027-01-01' }, NOW), true);
    });

    test('the release date has passed (today counts)', () => {
        assert.equal(isMovieReleased({ status: 'Post Production', release_date: '2026-10-01' }, NOW), true);
        assert.equal(isMovieReleased({ status: 'Post Production', release_date: '2026-10-12' }, NOW), true);
    });

    test('not yet: a future date, no date, or a date TMDB garbled', () => {
        assert.equal(isMovieReleased({ status: 'Post Production', release_date: '2027-06-30' }, NOW), false);
        assert.equal(isMovieReleased({ status: 'In Production', release_date: '' }, NOW), false);
        assert.equal(isMovieReleased({ status: 'Planned', release_date: 'soon' }, NOW), false);
    });
});

describe('buildFilmMessage', () => {
    const entry = { title: 'Дюна & Co', year: 2026 };

    test('title escaped, year, release date and the links', () => {
        const msg = buildFilmMessage({ entry, data: { release_date: '2026-10-01' }, links: '<LINKS>', now: NOW });
        assert.match(msg, /Дюна &amp; Co<\/b> \(2026\)/);
        assert.match(msg, /Дата релиза: <b>1 октября 2026 г\.<\/b>/);
        assert.ok(msg.endsWith('\n\n<LINKS>'));
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

    test('no digital date: no line for it; no release date: "уже вышел"', () => {
        const msg = buildFilmMessage({ entry: { title: 'X' }, data: { status: 'Released' }, links: '', now: NOW });
        assert.doesNotMatch(msg, /Цифровой релиз/);
        assert.match(msg, /Дата релиза: <b>уже вышел<\/b>/);
        assert.doesNotMatch(msg, /\(\d{4}\)/);
    });

    test('the director, escaped', () => {
        const msg = buildFilmMessage({ entry, data: { director_name: 'A <B>' }, links: '', now: NOW });
        assert.match(msg, /Режиссер: <b>A &lt;B&gt;<\/b>/);
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
