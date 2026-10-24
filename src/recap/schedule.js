/**
 * The year's recap sent by date: a day between 15 December and 10 January and an hour, the same
 * hour in each chat's own time zone. Kept in .env (RECAP_SCHEDULE on/off, RECAP_SCHEDULE_DAY,
 * RECAP_SCHEDULE_HOUR) and set from the panel's Year recap → Schedule.
 *
 * It can't go out early: every ten minutes (src/cron/index.js) a chat is queued only when the
 * switch is on, a day is set and that hour has come in the chat's zone. The year is the day's
 * (a January day sends the year before) and the day can't change while the switch is on. The
 * queue is the one the panel's buttons fill (send.js): quiet hours wait, a chat gets a year once.
 * When the bot was down at the hour, it sends when it is back, however late (the user's choice
 * 24.10); only to chats that had something to show by their hour, so a chat that subscribes
 * in February doesn't get last year's recap.
 */
const { fn, col } = require('sequelize');
const { Chat, Subscription, Watchlist } = require('../db');
const { ZONES, zoneOf } = require('../quiet');
const { writeEnv } = require('../admin/env');
const { audience, enqueue, unqueue } = require('./send');
const { drawInBackground, drawingState } = require('./render');
const { toDraw } = require('./ready');
const { log } = require('../log');

const HOUR_MS = 60 * 60 * 1000;
// The days it may be set to, as "MM-DD": from the 15th of December to the 10th of January
const WINDOW = { from: '12-15', to: '01-10' };
// Turning it on needs the first chat's hour at least this far ahead
const LEAD_MS = HOUR_MS;
// ...and the day no further than the season after the coming one could start
const AHEAD_MS = 400 * 24 * HOUR_MS;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether "YYYY-MM-DD" is a real day in the window. */
function inWindow(day) {
    const m = DAY.exec(day || '');
    if (!m) return false;
    const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (date.toISOString().slice(0, 10) !== day) return false;
    const md = day.slice(5);
    return md >= WINDOW.from || md <= WINDOW.to;
}

/** The year a day sends: its own in December, the one before in January. */
const yearOf = (day) => Number(day.slice(0, 4)) - (day.slice(5, 7) === '01' ? 1 : 0);

/**
 * The schedule as .env has it: { on, done, day, hour, year }; day and hour null when not set or
 * broken, and on only with both (an "on" the old Settings switch left has no day: it is off).
 * done: it went out, every zone's hour having passed; it stays off until turned on for a new day.
 */
function readSchedule(env = process.env) {
    const day = inWindow(env.RECAP_SCHEDULE_DAY) ? env.RECAP_SCHEDULE_DAY : null;
    const hour = /^\d{1,2}$/.test(env.RECAP_SCHEDULE_HOUR || '') ? Number(env.RECAP_SCHEDULE_HOUR) : null;
    const set = day !== null && hour !== null && hour <= 23;
    return {
        on: set && env.RECAP_SCHEDULE === 'on',
        done: set && env.RECAP_SCHEDULE === 'done',
        day: set ? day : null,
        hour: set ? hour : null,
        year: set ? yearOf(day) : null
    };
}

/** The moment the hour of the day comes in a time zone (Russia's have no summer time). */
function momentIn(schedule, zoneId) {
    const [y, m, d] = schedule.day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, schedule.hour) - zoneOf(zoneId).offset * HOUR_MS);
}

/** The first and the last moment over all the zones: the far east goes first. */
function span(schedule) {
    const moments = ZONES.map((z) => momentIn(schedule, z.id).getTime());
    return { first: new Date(Math.min(...moments)), last: new Date(Math.max(...moments)) };
}

/**
 * What is wrong with saving this schedule now, or null. The day and the hour change only while
 * it is off; on needs a day and an hour whose first chat is at least an hour ahead.
 * @param {{ on: boolean, day: string | null, hour: number | null }} next
 * @param {{ on: boolean, day: string | null, hour: number | null }} current
 */
function problemWith(next, current, now = new Date()) {
    const moved = next.day !== current.day || next.hour !== current.hour;
    if (moved && current.on && next.on) return 'Turn it off before changing the day';
    if (next.day !== null && !inWindow(next.day)) return 'Pick a day from 15 December to 10 January';
    if (next.hour !== null && !(Number.isInteger(next.hour) && next.hour >= 0 && next.hour <= 23))
        return 'Pick an hour from 0 to 23';
    if ((next.day === null) !== (next.hour === null)) return 'Pick both a day and an hour';
    const timed = next.day !== null && (moved || (next.on && !current.on));
    if (timed && span(next).first.getTime() < now.getTime() + LEAD_MS) {
        return 'That day and hour have passed or are less than an hour away';
    }
    // The coming season only: a day years ahead (sent straight to the API) would send a year
    // that hasn't happened yet
    if (timed && span(next).first.getTime() > now.getTime() + AHEAD_MS) return 'Pick a day in the coming season';
    if (next.on && next.day === null) return 'Pick a day and an hour first';
    return null;
}

// Drawn ahead once per schedule while this process runs; a drawn set is skipped anyway
let drewFor = null;
// One run at a time: a slow one (drawing ahead reads every chat's year) mustn't meet the next tick
let running = false;

const envOf = ({ on, day, hour, done = false }) => ({
    RECAP_SCHEDULE: on ? 'on' : done ? 'done' : 'off',
    RECAP_SCHEDULE_DAY: day || '',
    RECAP_SCHEDULE_HOUR: hour === null || hour === undefined ? '' : String(hour)
});

/** Writes the schedule to .env and to this process (the panel's saves: a failed write changes nothing). */
function saveSchedule(schedule) {
    const changes = envOf(schedule);
    writeEnv(changes);
    Object.assign(process.env, changes);
    drewFor = null;
}

/**
 * Stops the schedule from sending: off (or done) in this process at once, then in .env. A failed
 * write is logged, not thrown: what matters now is that nothing more is queued.
 */
function stopSchedule(schedule) {
    const changes = envOf(schedule);
    Object.assign(process.env, changes);
    try {
        writeEnv(changes);
        return true;
    } catch (err) {
        log.error(`[Recap] Saving the schedule as ${changes.RECAP_SCHEDULE} failed: ${err.message}`);
        return false;
    }
}

/**
 * Turns the schedule off, keeping its day and hour (the panel's Stop does this too).
 * @returns {{ off: boolean, saved: boolean }} off: it was on; saved: false when .env couldn't be
 *   written, so after a restart it would be on again
 */
function turnOff() {
    const current = readSchedule();
    // Off or done already in this process: written again all the same, in case an earlier write
    // failed and .env still says on (a restart would then queue again what Stop takes off)
    if (!current.on) return { off: false, saved: current.day ? stopSchedule(current) : true };
    return { off: true, saved: stopSchedule({ ...current, on: false }) };
}

/**
 * Every ten minutes: queues the chats whose hour has come, and from 03:00 Moscow time the day
 * before draws the cards not yet drawn, so the sending doesn't wait on the drawing. The first run
 * after the last zone's hour (on time, or when the bot is back after being down) queues the rest
 * and marks the schedule done: a chat with something to show only later (it subscribes in
 * February) doesn't get last year's recap then.
 * @returns {Promise<number>} how many chats were queued
 */
async function runSchedule(now = new Date()) {
    const schedule = readSchedule();
    if (!schedule.on || !schedule.day || running) return 0;
    running = true;
    try {
        return await queueDue(schedule, now);
    } finally {
        running = false;
    }
}

/** Since when each chat has had something to show: its oldest subscription or film still kept. */
async function followingSince(chatIds) {
    const oldest = (model) =>
        model.findAll({
            attributes: ['chatId', [fn('MIN', col('createdAt')), 'since']],
            where: { chatId: chatIds },
            group: ['chatId'],
            raw: true
        });
    const since = new Map();
    for (const rows of await Promise.all([oldest(Subscription), oldest(Watchlist)])) {
        for (const { chatId, since: at } of rows) {
            const id = String(chatId);
            const time = new Date(at);
            if (!since.has(id) || time < since.get(id)) since.set(id, time);
        }
    }
    return since;
}

async function queueDue(schedule, now) {
    const { first, last } = span(schedule);
    const [y, m, d] = schedule.day.split('-').map(Number);
    // Midnight UTC the day before: 03:00 in Moscow, before the first chat's hour whatever it is
    const drawFrom = Date.UTC(y, m - 1, d - 1);
    const key = `${schedule.day}T${schedule.hour}`;
    // Only until the sending begins (from then on the sending draws what it needs), and not while
    // a drawing (the panel's) is going: asking every chat's year again would be work for nothing.
    // A help, never in the way: a failure here is logged and the queuing goes on
    if (now.getTime() >= drawFrom && now < first && drewFor !== key && !drawingState().running) {
        try {
            const ids = await toDraw(schedule.year);
            if (!ids.length || drawInBackground(ids, schedule.year)) {
                drewFor = key;
                if (ids.length) log.info(`[Recap] Drawing ahead of the ${schedule.day} sending: ${ids.length} chat(s)`);
            }
        } catch (err) {
            log.error(`[Recap] Drawing ahead failed: ${err.message}`);
        }
    }
    if (now < first) return 0;

    const { eligible } = await audience(schedule.year, now);
    const [chats, since] = eligible.length
        ? await Promise.all([
              Chat.findAll({ where: { id: eligible }, attributes: ['id', 'timezone'] }),
              followingSince(eligible)
          ])
        : [[], new Map()];
    // Each chat at its own hour, and only if it had something to show by then: one that subscribes
    // later (on the day, or while the bot was down) waits for a send by hand
    const due = chats
        .filter((chat) => {
            const at = momentIn(schedule, chat.timezone);
            const from = since.get(String(chat.id));
            return now >= at && from !== undefined && from < at;
        })
        .map((chat) => String(chat.id));
    // Still this schedule, on: Stop or a new day saved meanwhile in the panel means nothing goes
    const unchanged = () => {
        const still = readSchedule();
        return still.on && still.day === schedule.day && still.hour === schedule.hour;
    };
    if (!unchanged()) return 0;
    const queued = await enqueue(due, schedule.year);
    // Changed while the rows were being written: they go too
    if (!unchanged()) {
        await unqueue(due, schedule.year);
        return 0;
    }
    if (queued) log.info(`[Recap] Scheduled sending of ${schedule.year}: ${queued} chat(s) queued`);
    if (now >= last) {
        // Done in this process at once; a failed .env write is logged by stopSchedule, and after a
        // restart the next run marks it done again (whoever got it is not sent it twice)
        stopSchedule({ ...schedule, on: false, done: true });
        log.info(`[Recap] Scheduled sending of ${schedule.year} done`);
    }
    return queued;
}

module.exports = {
    inWindow,
    yearOf,
    readSchedule,
    momentIn,
    span,
    problemWith,
    saveSchedule,
    turnOff,
    runSchedule
};
