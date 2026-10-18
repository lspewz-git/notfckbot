/**
 * A film's dates besides its main release: the premiere in Russia and the digital releases, from
 * Kinopoisk's distributions (src/api/kinopoisk.js) and TMDB's release dates (src/api/tmdb.js),
 * shown in the bot's film card and the "film is out" message. Kinopoisk is stubbed.
 * Run: npm run test:unit
 */
const { test, describe, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

mock.method(console, 'error', () => {});
process.env.KINOPOISK_API_KEY = 'test-key';

const kinopoisk = require('../../src/api/kinopoisk');
const { digitalReleaseDate, digitalRelease } = require('../../src/api/tmdb');
const { extraFilmDates, premiereMonthOnly } = require('../../src/constants');
const { filmCard } = require('../../src/bot/search-views');
const { buildFilmMessage } = require('../../src/cron');

const item = (type, date, country, ...companies) => ({
    type,
    subType: null,
    date,
    country: country ? { country } : null,
    companies: companies.map((name) => ({ name }))
});

let asked;
const answer = (items) =>
    mock.method(axios, 'get', async (url) => {
        asked.push(url);
        return { data: { items } };
    });

beforeEach(() => {
    asked = [];
});

describe('the Russian dates from Kinopoisk', () => {
    test('the premiere in Russia, and the online release with its cinemas', async () => {
        answer([
            item('PREMIERE', '2027-01-09', 'США'),
            item('PREMIERE', '2027-01-16', 'Россия'),
            item('COUNTRY_SPECIFIC', '2027-01-23', 'Россия'),
            item('DIGITAL', '2027-02-27', null, 'Okko', 'START'),
            item('DIGITAL', '2027-03-10', null, 'Иви')
        ]);
        const dates = await kinopoisk.russianDates(101);
        assert.deepEqual(dates, { premiere: '2027-01-16', digital: '2027-02-27', services: ['Okko', 'START'] });
        assert.match(asked[0], /\/api\/v2\.2\/films\/101\/distributions$/);
    });

    test('a film not released in Russia: no dates; asked again only after a day', async () => {
        answer([item('PREMIERE', '2024-02-25', 'США')]);
        assert.deepEqual(await kinopoisk.russianDates(102), kinopoisk.NO_DATES);
        await kinopoisk.russianDates(102);
        assert.equal(asked.length, 1, 'from the cache the second time');
    });

    test('Kinopoisk failing: no dates, marked failed, no error; no ID or no key: not even asked', async () => {
        mock.method(axios, 'get', async () => {
            throw Object.assign(new Error('HTTP 500'), { response: { status: 500 } });
        });
        // Told apart from "no dates", so the stored ones aren't wiped
        assert.deepEqual(await kinopoisk.russianDates(103), { ...kinopoisk.NO_DATES, failed: true });
        answer([]);
        assert.deepEqual(await kinopoisk.russianDates(null), kinopoisk.NO_DATES);
        const key = process.env.KINOPOISK_API_KEY;
        delete process.env.KINOPOISK_API_KEY;
        try {
            assert.deepEqual(await kinopoisk.russianDates(104), kinopoisk.NO_DATES);
        } finally {
            process.env.KINOPOISK_API_KEY = key;
        }
        assert.equal(asked.length, 0);
    });

    test('for the card: a Kinopoisk that does not answer in time leaves TMDB dates only', async () => {
        mock.method(axios, 'get', () => new Promise(() => {}));
        const started = Date.now();
        const quick = await kinopoisk.kinopoiskQuick('movie_999', 'tt999', 50);
        assert.deepEqual(quick, { kinopoiskId: null, ru: kinopoisk.NO_DATES });
        assert.ok(Date.now() - started < 1000);
    });
});

describe("TMDB's digital release", () => {
    const country = (code, ...dates) => ({
        iso_3166_1: code,
        release_dates: dates.map((release_date) => ({ type: 4, release_date }))
    });

    test('Russia first, then the US, then the earliest anywhere; with its country', () => {
        const list = (...countries) => ({ results: countries });
        assert.equal(digitalReleaseDate(list(country('US', '2027-02-06'), country('RU', '2027-02-27'))), '2027-02-27');
        assert.deepEqual(digitalRelease(list(country('DE', '2027-03-01'), country('US', '2027-02-06'))), {
            date: '2027-02-06',
            country: 'US'
        });
        assert.deepEqual(digitalRelease(list(country('DE', '2027-03-01'), country('GB', '2027-02-20'))), {
            date: '2027-02-20',
            country: 'GB'
        });
        assert.deepEqual(digitalRelease(list()), { date: null, country: null });
    });
});

describe('the lines in the card and the message', () => {
    const data = { digital_release_date: '2027-02-06', digital_release_country: 'US' };
    const ru = { premiere: '2027-01-16', digital: '2027-02-27', services: ['Okko'] };

    test('the premiere in Russia, the digital release with its country, the Russian one with its cinema', () => {
        assert.deepEqual(extraFilmDates(data, ru), [
            '🎟 Премьера в России: <b>16 января 2027 г.</b>\n',
            '💻 Цифровой релиз: <b>6 февраля 2027 г.</b> (США)\n',
            '💻 Цифровой релиз в России: <b>27 февраля 2027 г.</b> · Okko\n'
        ]);
    });

    test("TMDB's date already Russia's and the same: said once", () => {
        const lines = extraFilmDates({ digital_release_date: '2027-02-27', digital_release_country: 'RU' }, ru);
        assert.equal(lines.filter((l) => l.includes('Цифровой')).length, 1);
        assert.match(lines.join(''), /\(Россия\)/);
    });

    test('nothing known: no lines; names escaped; "(ожидается)" only when asked', () => {
        assert.deepEqual(extraFilmDates({}, {}), []);
        assert.match(extraFilmDates({}, { digital: '2027-02-27', services: ['A <B>'] }).join(''), /· A &lt;B&gt;/);
        const marked = extraFilmDates(data, {}, { markExpected: new Date('2027-01-01') }).join('');
        assert.match(marked, /\(США\) \(ожидается\)/);
    });

    test('the film card and the "film is out" message carry them', () => {
        const film = { id: 7, title: 'Пчеловод 2', release_date: '2027-01-09', status: 'Post Production', ...data };
        const card = filmCard(film, { now: new Date('2026-10-18'), ru });
        assert.match(card.caption, /Релиз: <b>9 января 2027 г\.<\/b>\n🎟 Премьера в России: <b>16 января 2027 г\.<\/b>/);
        assert.match(card.caption, /Цифровой релиз в России: <b>27 февраля 2027 г\.<\/b> · Okko/);

        const msg = buildFilmMessage({
            entry: { title: 'Пчеловод 2', year: 2027 },
            data: film,
            links: '',
            now: new Date('2027-01-10'),
            ru
        });
        assert.match(msg, /Дата релиза: <b>9 января 2027 г\.<\/b>\n🎟 Премьера в России/);
        assert.match(msg, /Цифровой релиз: <b>6 февраля 2027 г\.<\/b> \(США\) \(ожидается\)/);
    });
});

describe('a Russian premiere known only to the month', () => {
    test('the 1st and not a Thursday: the month; a Thursday or 1 January: the day', () => {
        assert.equal(premiereMonthOnly('2027-02-01'), true, 'a Monday');
        assert.equal(premiereMonthOnly('2026-10-01'), false, 'a Thursday: a real premiere day');
        assert.equal(premiereMonthOnly('2027-01-01'), false, 'New Year premieres are real');
        assert.equal(premiereMonthOnly('2027-02-04'), false);
    });

    test('said as the month in the card and the message', () => {
        assert.deepEqual(extraFilmDates({}, { premiere: '2027-02-01' }), [
            '🎟 Премьера в России: <b>февраль 2027 г.</b>\n'
        ]);
    });
});
