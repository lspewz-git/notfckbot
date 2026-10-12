/**
 * Film release decisions and the helpers behind every notification: dates, the next
 * episode, watch links, the schedule. Run: npm run test:unit
 */
// Dates are formatted the way the server does it, in UTC, whatever machine runs the tests
process.env.TZ = 'UTC';

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const { isMovieReleased, buildFilmMessage, nextRunAt } = require('../../src/cron');
const { digitalReleaseDate, nextEpisodeFields } = require('../../src/api/tmdb');
const {
    getWatchLinks,
    formatWatchLinks,
    formatDigitalDate,
    isFinishedStatus,
    UPDATE_INTERVAL_HOURS
} = require('../../src/constants');

mock.method(console, 'log', () => {});

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

describe('digitalReleaseDate', () => {
    // TMDB release types: 3 theatrical, 4 digital
    const country = (code, ...dates) => ({ iso_3166_1: code, release_dates: dates });
    const digital = (date) => ({ type: 4, release_date: `${date}T00:00:00.000Z` });
    const theatrical = (date) => ({ type: 3, release_date: `${date}T00:00:00.000Z` });

    test('Russia first, then the US, then the earliest anywhere', () => {
        const all = [
            country('DE', digital('2026-01-05')),
            country('US', digital('2026-02-01')),
            country('RU', digital('2026-03-01'))
        ];
        assert.equal(digitalReleaseDate({ results: all }), '2026-03-01');
        assert.equal(digitalReleaseDate({ results: all.slice(0, 2) }), '2026-02-01');
        assert.equal(digitalReleaseDate({ results: all.slice(0, 1) }), '2026-01-05');
    });

    test('a theatrical date is not a digital one', () => {
        assert.equal(digitalReleaseDate({ results: [country('RU', theatrical('2026-03-01'))] }), null);
    });

    test('nothing known', () => {
        assert.equal(digitalReleaseDate(undefined), null);
        assert.equal(digitalReleaseDate({ results: [] }), null);
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
    test('with a Kinopoisk ID: HDRezka, SSPoisk and Kinopoisk, straight to the title', () => {
        const links = getWatchLinks({ title: 'Dune', kinopoiskId: 123, mediaType: 'movie' });
        assert.deepEqual(
            links.map((l) => l.url),
            [
                'https://rezka.ag/search/?do=search&subaction=search&q=Dune',
                'https://www.sspoisk.ru/film/123/',
                'https://www.kinopoisk.ru/film/123/'
            ]
        );
    });

    test('a series links to /series/ on Kinopoisk and SSPoisk', () => {
        const links = getWatchLinks({ title: 'X', kinopoiskId: 7, mediaType: 'tv' });
        assert.equal(links[1].url, 'https://www.sspoisk.ru/series/7/');
    });

    test('without an ID: no SSPoisk, Kinopoisk falls back to a search', () => {
        const links = getWatchLinks({ title: 'Тёмная материя', kinopoiskId: null, mediaType: 'tv' });
        assert.equal(links.length, 2);
        assert.ok(links[1].url.startsWith('https://www.kinopoisk.ru/index.php?kp_query=%D0'));
    });

    test('the HTML block escapes & in hrefs for Telegram', () => {
        const html = formatWatchLinks({ title: 'A&B', kinopoiskId: null, mediaType: 'movie' });
        assert.match(html, /href="https:\/\/rezka\.ag\/search\/\?do=search&amp;subaction=search&amp;q=A%26B"/);
        assert.doesNotMatch(html, /&subaction/);
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

    describe('nextRunAt', () => {
        const at = (h, m) => new Date(2026, 9, 12, h, m);
        const midnight = new Date(2026, 9, 13, 0, 0);

        // The configured interval, whatever it is: expectations follow the constant
        const H = UPDATE_INTERVAL_HOURS;
        const lastSlot = Math.floor(23 / H) * H;

        test(`the configured interval (${H} h): the next slot, then midnight after the last one`, () => {
            // Just before a slot
            assert.deepEqual(nextRunAt(at(H - 1, 30)), at(H, 0));
            // Exactly on a slot: the one after it
            assert.deepEqual(nextRunAt(at(H, 0)), lastSlot >= 2 * H ? at(2 * H, 0) : midnight);
            // Past the day's last slot
            assert.deepEqual(nextRunAt(at(lastSlot, 30)), midnight);
        });

        test('an interval that does not divide 24 still restarts at midnight, like cron', () => {
            // */5 fires at 0, 5, 10, 15, 20: after 20:00 comes 00:00, not 01:00
            assert.deepEqual(nextRunAt(at(20, 10), 5), midnight);
            assert.deepEqual(nextRunAt(at(14, 0), 5), at(15, 0));
        });
    });
});
