/**
 * The day the bot will message a chat about a calendar row, for the bell in the panel's Calendar:
 * null when the subscription's mode stays silent on that row.
 *
 * When it goes out (an estimate, the bot has no air times):
 * - an episode reaches the update check about a day after its TMDB date: TMDB moves it to
 *   last_episode_to_air once that US day ends, ≈04–06 UTC, and it goes out with the first check
 *   from 06 UTC on (checks run at the hours UPDATE_INTERVAL_HOURS divides; .claude/notes/bot.md);
 * - the check sees only the day's last episode (src/cron/series.js): episodes out together give one
 *   message, about the last of them;
 * - a film's selected Release goes out once its chat-local date has come and TMDB says Released;
 *   its calendar bell is the earliest expected day, since the status may update later;
 * - in the chat's quiet hours the message waits for their end (src/cron/held.js), so it can move to
 *   the next day.
 */
const { zoneOf, hasQuietHours } = require('../quiet');
const { UPDATE_INTERVAL_HOURS } = require('../constants');

const EPISODE_READY_UTC_HOUR = 6;

/** The first update check at or after 06 UTC (may pass midnight: it is then the next day's) */
function episodeSendHour(interval = UPDATE_INTERVAL_HOURS) {
    const every = Number.isInteger(interval) && interval > 0 ? interval : 3;
    return Math.ceil(EPISODE_READY_UTC_HOUR / every) * every;
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

/**
 * @param {{ kind: string, date: string, mode?: string | null, mark?: string, episode?: number,
 *   last?: boolean, lastOfDay?: boolean, premiereDay?: boolean }} item a calendar row; `premiereDay`:
 *   the season's first episode comes out the same day
 * @param {{ timezone?: string | null, quiet_start?: number | null, quiet_end?: number | null } | null} chat
 * @param {number} [interval] hours between update checks
 * @returns {string | null} the chat's local "YYYY-MM-DD" of the message
 */
function notifyDay(item, chat, interval = UPDATE_INTERVAL_HOURS) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.date || '')) || !messages(item)) return null;
    const tv = item.kind === 'tv';
    const midnight = Date.parse(`${item.date}T00:00:00Z`);
    let sendAt = new Date(midnight + (24 + episodeSendHour(interval)) * 36e5);
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
    if (!hasQuietHours(chat)) return day;
    const { quiet_start: start, quiet_end: end } = chat;
    const quiet = start < end ? hour >= start && hour < end : hour >= start || hour < end;
    // Held until the hours end: later the same morning, or the next one when they started before midnight
    return quiet && start > end && hour >= start ? nextDay(day) : day;
}

/** notifyDay() for a whole calendar: episodes out the same day give one message, about the last */
function notifyDays(items, chat, interval = UPDATE_INTERVAL_HOURS) {
    const order = (i) => Number(i.season) * 10000 + Number(i.episode);
    const latest = new Map();
    // Days a season's first episode comes out: the bot announces the premiere with the day's last
    const premieres = new Set();
    for (const i of items) {
        if (i.kind !== 'tv') continue;
        const key = `${i.tmdbId}|${i.date}`;
        if (!(latest.get(key) >= order(i))) latest.set(key, order(i));
        if (Number(i.episode) === 1 || i.mark === 'premiere') premieres.add(`${key}|${i.season}`);
    }
    return items.map((i) =>
        notifyDay(
            i.kind === 'tv'
                ? {
                      ...i,
                      lastOfDay: latest.get(`${i.tmdbId}|${i.date}`) === order(i),
                      premiereDay: premieres.has(`${i.tmdbId}|${i.date}|${i.season}`)
                  }
                : i,
            chat,
            interval
        )
    );
}

module.exports = { notifyDay, notifyDays, episodeSendHour };
