/**
 * Film release decisions and the helpers behind every notification: dates, the next
 * episode, watch links. Run: npm run test:unit
 */
// Dates are formatted the way the server does it, in UTC, whatever machine runs the tests
process.env.TZ = 'UTC';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildFilmMessage, buildDigitalMessage, buildTestMessage } = require('../../src/cron/messages');
const { nextEpisodeFields, firstRelease } = require('../../src/api/tmdb');
const { getWatchLinks, formatWatchLinks, formatDigitalDate, isFinishedStatus } = require('../../src/constants');

const NOW = new Date('2026-10-12T12:00:00Z');

describe('buildFilmMessage', () => {
    const entry = { title: 'Дюна & Co', year: 2026 };

    for (const type of [2, 3]) {
        test(`compact release geography in real and test notifications for theatrical type ${type}`, () => {
            const codes =
                'AL AR AT BE BO BR CH CN CR CZ DE EC ES FI FO FR GB GH GP GR GT HN HU ID IE IL IT KR LA LU LV MA MK MT MX NI NO PE PH SE SI TW UA UY VE XK'.split(
                    ' '
                );
            const data = {
                release_dates: {
                    results: codes.map((iso_3166_1) => ({
                        iso_3166_1,
                        release_dates: [{ type, release_date: '2026-07-29' }]
                    }))
                },
                digital_first_date: '2026-10-06',
                digital_first_country: 'CA'
            };
            const real = buildFilmMessage({ entry, data, links: '<LINKS>', now: NOW });
            const releaseLine =
                `📅 Дата релиза: <b>29 июля 2026 г.</b> ` +
                (type === 3 ? '(мировой прокат)' : '(Албания, Аргентина, Австрия +43)');
            assert.equal(
                real.split('\n').find((line) => line.startsWith('📅')),
                releaseLine
            );
            assert.match(real, /Цифровой релиз: <b>6 октября 2026 г\.<\/b> \(Канада\)/);
            assert.doesNotMatch(real, /Бельгия|Косово/);
            const preview = buildTestMessage('film', { film: { entry, data }, links: '<LINKS>' });
            assert.equal(preview, '🧪 <b>[Тестовое уведомление]</b>\n\n' + real);
        });
    }

    for (const [codes, expected] of [
        [[], ''],
        [['US'], ' (США)'],
        [['CN', 'JP', 'US'], ' (Китай, Япония, США)']
    ]) {
        test(`compact countries keeps ${codes.length} countries without a counter`, () => {
            const data = {
                cinema_release_date: '2026-07-29',
                release_dates: {
                    results: codes.map((iso_3166_1) => ({
                        iso_3166_1,
                        release_dates: [{ type: 3, release_date: '2026-07-29' }]
                    }))
                }
            };
            const msg = buildFilmMessage({ entry, data, links: '', now: NOW });
            assert.equal(
                msg.split('\n').find((line) => line.startsWith('📅')),
                `📅 Дата релиза: <b>29 июля 2026 г.</b>${expected}`
            );
        });
    }

    test('digital expected status follows the chat-local day across UTC midnight', () => {
        const msg = buildFilmMessage({
            entry,
            data: { cinema_release_date: '2026-11-09', digital_first_date: '2026-11-09' },
            today: '2026-11-09',
            now: new Date('2026-11-08T18:00:00Z'),
            links: ''
        });
        assert.doesNotMatch(msg, /ожидается/);
    });

    test('"Фильм вышел", title escaped, year and the links; the selected cinema date', () => {
        const msg = buildFilmMessage({
            entry,
            data: { release_date: '2026-08-01', cinema_release_date: '2026-08-01', digital_release_date: '2026-10-01' },
            links: '<LINKS>',
            now: NOW
        });
        assert.match(msg, /^🎬 <b>Фильм вышел!<\/b>/);
        assert.match(msg, /Дюна &amp; Co<\/b> \(2026\)/);
        assert.match(msg, /Дата релиза/);
        assert.ok(msg.endsWith('\n\n<LINKS>'));
    });

    test('no digital release known: says the date is unknown, without a forecast', () => {
        const msg = buildFilmMessage({ entry, data: { release_date: '2026-08-01' }, links: '', now: NOW });
        assert.match(msg, /Дата цифрового релиза неизвестна/);
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
        assert.match(msg, /Дата цифрового релиза неизвестна/);
        assert.doesNotMatch(msg, /\(\d{4}\)/);
    });

    test('the director, escaped', () => {
        const msg = buildFilmMessage({ entry, data: { director_name: 'A <B>' }, links: '', now: NOW });
        assert.match(msg, /Режиссер: <b>A &lt;B&gt;<\/b>/);
    });
});

describe('buildDigitalMessage', () => {
    test('the independent digital event has its own heading, date and country', () => {
        const msg = buildDigitalMessage({
            entry: { title: 'Film', year: 2026 },
            data: { digital_first_date: '2026-11-11', digital_first_country: 'US' },
            links: '<INFO>'
        });
        assert.match(msg, /^💻 <b>Фильм вышел онлайн!/);
        assert.match(msg, /11 ноября 2026 г/);
        assert.match(msg, /США/);
        assert.doesNotMatch(msg, /напишу, когда выйдет/);
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
