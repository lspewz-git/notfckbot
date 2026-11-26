/**
 * The day the bot will message a chat about a calendar row, for the bell in the panel's Calendar:
 * null when the subscription's mode stays silent on that row.
 *
 * When it goes out (planned, actual delivery may be delayed):
 * - a TVmaze-primary episode uses the first check once its outAt moment has passed;
 * - the TMDB fallback reaches the update check about a day after its date: TMDB moves it to
 *   last_episode_to_air once that US day ends, by 08 UTC (seen 13.11: still not at 06:00, done by
 *   08:10, sent at the 09:00 check), and it goes out with the first check after 08 UTC (checks run
 *   at the hours UPDATE_INTERVAL_HOURS divides; .claude/notes/bot.md);
 * - the check sees only the day's last episode (src/cron/series.js): episodes out together give one
 *   message, about the last of them;
 * - a film's selected Release goes out once its chat-local date has come and TMDB says Released;
 *   its calendar bell is the earliest expected day, since the status may update later;
 * - in the chat's quiet hours the message waits for their end (src/cron/held.js), so it can move to
 *   the next day.
 */
const { zoneOf, hasQuietHours } = require('../quiet');
const { UPDATE_INTERVAL_HOURS } = require('../constants');

const EPISODE_READY_UTC_HOUR = 8;

/**
 * The first update check after 08 UTC (a check at 08:00 itself may come before TMDB's move; the
 * hour may pass midnight: it is then the next day's)
 */
function episodeSendHour(interval = UPDATE_INTERVAL_HOURS) {
    const every = Number.isInteger(interval) && interval > 0 ? interval : 3;
    return (Math.floor(EPISODE_READY_UTC_HOUR / every) + 1) * every;
}

/**
 * Whether the bot writes about this row in this mode (src/cron/series.js). `lastOfDay`: no later
 * episode of the series comes out the same day; `last`: the season's final episode
 */
function messages(item) {
    if (item.kind !== 'tv') return item.event === 'release';
    if (item.lastOfDay === false) return false;
    const last = item.last ?? item.mark === 'finale';
    if (item.mode === 'episode') return true;
    if (item.mode === 'season') return Boolean(last);
    if (item.mode === 'first_and_full')
        return item.episode === 1 || item.mark === 'premiere' || Boolean(item.premiereDay) || Boolean(last);
    return false;
}

/** "YYYY-MM-DD" and the hour of a moment in a time zone */
function localOf(date, zoneId) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone: zoneOf(zoneId).id,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: 'numeric',
            hourCycle: 'h23'
        })
            .formatToParts(date)
            .map((p) => [p.type, p.value])
    );
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

/** The first update check at or after a moment (checks at the UTC hours `interval` divides) */
function firstCheckFrom(ms, interval = UPDATE_INTERVAL_HOURS) {
    const every = Number.isInteger(interval) && interval > 0 ? interval : 3;
    const hourStart = Math.ceil(ms / 36e5) * 36e5;
    for (let at = hourStart; at < hourStart + 48 * 36e5; at += 36e5) {
        if (new Date(at).getUTCHours() % every === 0) return at;
    }
    return hourStart;
}

/**
 * A primary series follows TVmaze's outAt only. The legacy TMDB fallback can still take
 * the earlier of its estimated catalog move and the matching TVmaze episode's outAt.
 */
function episodeSendAt(item, interval = UPDATE_INTERVAL_HOURS) {
    if (item.episodeSource === 'tvmaze')
        return Number.isFinite(item.outAt) ? firstCheckFrom(item.outAt, interval) : null;
    const byTmdb = Date.parse(`${item.date}T00:00:00Z`) + (24 + episodeSendHour(interval)) * 36e5;
    return Number.isFinite(item.outAt) ? Math.min(byTmdb, firstCheckFrom(item.outAt, interval)) : byTmdb;
}

/**
 * @param {{ kind: string, date: string, mode?: string | null, mark?: string, episode?: number,
 *   last?: boolean, lastOfDay?: boolean, premiereDay?: boolean, outAt?: number | null,
 *   episodeSource?: string | null, dayOnly?: boolean }} item a
 *   calendar row (`date`: TMDB's for an episode); `premiereDay`: the season's first episode comes
 *   out the same day; `outAt`: the moment it is out by TVmaze
 * @param {{ timezone?: string | null, quiet_start?: number | null, quiet_end?: number | null } | null} chat
 * @param {number} [interval] hours between update checks
 * @returns {{ notifyOn: string, sendAt: string, sendKind: 'timed' | 'quiet' | 'day' | 'not_before' } | null}
 *   the chat's local "YYYY-MM-DD" of the message, its moment (ISO, UTC) and how sure it is: `timed`
 *   by TVmaze's hour, `quiet` a known hour held to the end of quiet hours, `day` the hour unknown
 *   (streaming without one, TMDB only, including quiet-hour shifts), `not_before` a film waiting
 *   for TMDB's Released
 */
function notifyDay(item, chat, interval = UPDATE_INTERVAL_HOURS) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.date || '')) || !messages(item)) return null;
    const tv = item.kind === 'tv';
    const kind = !tv ? 'not_before' : Number.isFinite(item.outAt) && !item.dayOnly ? 'timed' : 'day';
    const midnight = Date.parse(`${item.date}T00:00:00Z`);
    const episodeAt = tv ? episodeSendAt(item, interval) : null;
    if (tv && episodeAt === null) return null;
    let sendAt = new Date(tv ? episodeAt : midnight + (24 + episodeSendHour(interval)) * 36e5);
    if (!tv) {
        const every = Number.isInteger(interval) && interval > 0 ? interval : 3;
        // Cron hours restart at UTC midnight; a chat's first slot may be on the previous UTC day.
        for (let hour = -24; hour < 48; hour += 1) {
            const candidate = new Date(midnight + hour * 36e5);
            if (candidate.getUTCHours() % every === 0 && localOf(candidate, chat?.timezone).day === item.date) {
                sendAt = candidate;
                break;
            }
        }
    }
    const { day, hour } = localOf(sendAt, chat?.timezone);
    const send = (notifyOn, at, sendKind) => ({ notifyOn, sendAt: new Date(at).toISOString(), sendKind });
    if (!hasQuietHours(chat)) return send(day, sendAt, kind);
    const { quiet_start: start, quiet_end: end } = chat;
    const quiet = start < end ? hour >= start && hour < end : hour >= start || hour < end;
    if (!quiet) return send(day, sendAt, kind);
    // Held until the hours end: later the same morning, or the next one when they started before midnight;
    // the 10-minute pass at the end hour sends it (src/cron/held.js). Our zones keep a fixed offset.
    const heldDay = start > end && hour >= start ? nextDay(day) : day;
    const endAt = Date.parse(`${heldDay}T00:00:00Z`) + (end - zoneOf(chat.timezone).offset) * 36e5;
    return send(heldDay, endAt, kind === 'timed' ? 'quiet' : kind);
}

/**
 * The separate digital release message of a calendar or list film (rowFilmDates()): null unless
 * the chat wants it, or when it comes the day of the main release (src/cron/films.js puts it into
 * that message). Sent like the release: its day has come and TMDB says Released.
 */
function digitalSend(film, chat, interval = UPDATE_INTERVAL_HOURS) {
    const date = film.online?.date;
    if (!film.notifyDigital || !date || date === film.release?.date) return null;
    return notifyDay({ kind: 'movie', event: 'release', date }, chat, interval);
}

/**
 * The chat's day an episode comes out for the bot: the update check finds it and sends its
 * message, whatever the subscription's mode. Quiet hours may hold the message later; the
 * calendars still show the episode on this day.
 * @param {string} tmdbDate "YYYY-MM-DD", TMDB's air date
 * @param {{ timezone?: string | null } | null} chat
 */
const episodeArrivalDay = (tmdbDate, chat, interval = UPDATE_INTERVAL_HOURS) =>
    notifyDay({ kind: 'tv', date: tmdbDate, mode: 'episode' }, { timezone: chat ? chat.timezone : null }, interval)
        ?.notifyOn ?? null;

/**
 * notifyDay() for a whole calendar: episodes the same check finds give one message, about the
 * last. An episode goes by TMDB's day (`tmdbDate`) and TVmaze's moment (`outAt`), not by the day
 * the calendar shows it on.
 */
function notifyDays(rows, chat, interval = UPDATE_INTERVAL_HOURS) {
    const items = rows.map((i) => (i.kind === 'tv' && i.tmdbDate ? { ...i, date: i.tmdbDate } : i));
    const order = (i) => Number(i.season) * 10000 + Number(i.episode);
    // The check that finds it: episodes found by the same one go out together
    const slot = (i) =>
        `${i.tmdbId}|${/^\d{4}-\d{2}-\d{2}$/.test(String(i.date || '')) ? episodeSendAt(i, interval) : i.date}`;
    const latest = new Map();
    // Checks that find a season's first episode: the bot announces the premiere with the last found
    const premieres = new Set();
    for (const i of items) {
        if (i.kind !== 'tv') continue;
        const key = slot(i);
        if (!(latest.get(key) >= order(i))) latest.set(key, order(i));
        if (Number(i.episode) === 1 || i.mark === 'premiere') premieres.add(`${key}|${i.season}`);
    }
    return items.map((i) =>
        notifyDay(
            i.kind === 'tv'
                ? {
                      ...i,
                      lastOfDay: latest.get(slot(i)) === order(i),
                      premiereDay: premieres.has(`${slot(i)}|${i.season}`)
                  }
                : i,
            chat,
            interval
        )
    );
}

module.exports = { notifyDay, notifyDays, digitalSend, episodeSendHour, episodeArrivalDay, firstCheckFrom };
