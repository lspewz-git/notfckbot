/** Shared film policy: actual theatrical release, with an independent known digital release. */
const { premiereMonthOnly } = require('./constants');
const { countries } = require('countries-list');

const RELEASE_RULE_VERSION = 1;

/** Reject incomplete dates rather than turning a month or an invalid day into a release. */
function dayOf(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return null;
    const day = value.slice(0, 10);
    const time = Date.parse(`${day}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? day : null;
}

function eventsOf(data, types, country = null) {
    return (data.release_dates?.results || [])
        .filter((group) => !country || group.iso_3166_1 === country)
        .flatMap((group) =>
            (group.release_dates || [])
                .filter((event) => types.includes(event.type))
                .map((event) => ({ date: dayOf(event.release_date), country: group.iso_3166_1 || null }))
        )
        .filter((event) => event.date);
}

function firstOf(events) {
    const sorted = events.filter((event) => dayOf(event.date)).sort((a, b) => a.date.localeCompare(b.date));
    if (!sorted.length) return null;
    const date = sorted[0].date;
    const countries = [
        ...new Set(
            sorted
                .filter((event) => event.date === date)
                .map((event) => event.country)
                .filter(Boolean)
        )
    ].sort();
    return { date, country: countries[0] || null, countries };
}

/** Display heuristic only: at least 10 markets in 3 regions during 7 calendar days. */
function worldwideRelease(data) {
    const regions = new Set(['AF', 'AS', 'EU', 'NA', 'OC', 'SA']);
    const events = eventsOf(data, [3]).filter(
        ({ country }) => Object.hasOwn(countries, country) && regions.has(countries[country].continent)
    );
    const starts = [...new Set(events.map((event) => event.date))].sort();
    for (const date of starts) {
        const end = Date.parse(date) + 6 * 24 * 60 * 60 * 1000;
        const codes = [
            ...new Set(
                events
                    .filter((event) => event.date >= date && Date.parse(event.date) <= end)
                    .map((event) => event.country)
            )
        ].sort();
        if (codes.length >= 10 && new Set(codes.map((code) => countries[code].continent)).size >= 3) {
            return { date, countries: codes };
        }
    }
    return null;
}

function isRussian(data) {
    const origin = data.origin_country?.length
        ? data.origin_country
        : (data.production_countries || []).map((country) => country.iso_3166_1);
    return origin.includes('RU');
}

function russianCinema(data, ru) {
    const kp = dayOf(ru.premiere);
    if (kp && !premiereMonthOnly(kp)) return { date: kp, country: 'RU', countries: ['RU'] };
    return firstOf(eventsOf(data, [2, 3], 'RU')) || firstOf([{ date: dayOf(data.cinema_ru_date), country: 'RU' }]);
}

/** First public cinema release worldwide; Russian films use Russia's cinema release. */
function cinemaDate(data, ru = {}) {
    if (isRussian(data)) return russianCinema(data, ru);
    return (
        firstOf(eventsOf(data, [2, 3])) ||
        firstOf([
            { date: dayOf(data.cinema_release_date), country: data.cinema_release_country || null },
            { date: dayOf(data.limited_release_date), country: data.limited_release_country || null }
        ])
    );
}

/** Films without a cinema release use their known digital release as the main event. */
function releaseDate(data, ru = {}) {
    return cinemaDate(data, ru) || onlineDate(data, ru);
}

/** The date AND Released are required, even when the date is long past. */
function hasCome(data, date, today) {
    return Boolean(dayOf(today) && date && date <= today && data.status === 'Released');
}

function isReleased(data, ru = {}, today) {
    return hasCome(data, releaseDate(data, ru)?.date, today);
}

/** A known digital date only. Never infer digital availability from cinema or status. */
function onlineDate(data, ru = {}) {
    return firstOf([
        ...eventsOf(data, [4]),
        { date: dayOf(data.digital_first_date), country: data.digital_first_country || null },
        { date: dayOf(data.digital_release_date), country: data.digital_release_country || null },
        { date: dayOf(ru.digital), country: 'RU' }
    ]);
}

function isOnline(data, ru = {}, today) {
    return hasCome(data, onlineDate(data, ru)?.date, today);
}

/** Persist the same selected dates used for sending, display and release history. */
function storedDates(data, ru = {}) {
    const cinema = releaseDate(data, ru);
    const online = onlineDate(data, ru);
    return {
        premiere_digital: cinema?.date || null,
        cinema_date: cinema?.date || null,
        cinema_country: cinema?.country || null,
        release_countries: cinema?.countries.join(',') || null,
        cinema_ru_date: russianCinema(data, ru)?.date || null,
        online_date: online?.date || null,
        online_estimate: false,
        digital_date: online?.date || null,
        digital_country: online?.country || null
    };
}

/** Legacy rows enter the new rule silently; future films incorrectly marked out wait again. */
function initialReleaseState(data, ru, today, previous = {}) {
    const release = releaseDate(data, ru);
    const notified = previous.notified ? !release || release.date <= today : isReleased(data, ru, today);
    return {
        notified,
        digital_notified: Boolean(previous.digital_notified || isOnline(data, ru, today)),
        release_rule_version: RELEASE_RULE_VERSION
    };
}

function rowRelease(row) {
    const date = dayOf(row.cinema_date);
    if (!date) return null;
    const countries = row.release_countries
        ? row.release_countries.split(',').filter(Boolean)
        : [row.cinema_country].filter(Boolean);
    return { date, country: countries[0] || null, countries };
}

const ruCinemaDate = (row) => dayOf(row.cinema_ru_date);
const onlineCountry = (row) =>
    !row.online_estimate && row.online_date === row.digital_date ? row.digital_country || null : null;

module.exports = {
    worldwideRelease,
    releaseDate,
    isReleased,
    onlineDate,
    isOnline,
    storedDates,
    initialReleaseState,
    rowRelease,
    ruCinemaDate,
    onlineCountry,
    RELEASE_RULE_VERSION
};
