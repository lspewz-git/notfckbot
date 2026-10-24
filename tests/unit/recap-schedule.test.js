/**
 * The year's recap sent by date (src/recap/schedule.js, src/admin/routes/recap-schedule.js): it
 * goes out at the hour in each chat's zone and never before; the day can't move while it is on;
 * the panel's Stop turns it off. The clock is a parameter, the database and the queue stand-ins,
 * .env a temporary file. Run: npm run test:unit
 */
const { test, describe, mock, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-schedule-'));
const KEYS = ['RECAP_SCHEDULE', 'RECAP_SCHEDULE_DAY', 'RECAP_SCHEDULE_HOUR'];
const savedEnv = Object.fromEntries([...KEYS, 'ENV_FILE'].map((k) => [k, process.env[k]]));
process.env.ENV_FILE = path.join(DIR, '.env');

// The queue, the drawing and the chats, before schedule.js takes its references (all given back
// after the file)
const send = require('../../src/recap/send');
const render = require('../../src/recap/render');
const ready = require('../../src/recap/ready');
const { Chat, Subscription, Watchlist } = require('../../src/db');

let eligible = [];
let chats = [];
const queued = [];
let toDraw = [];
const drawing = [];
const unqueued = [];
// Something the panel does while a run reads the chats, or while it writes the rows (Stop)
let meanwhile = null;
let whileWriting = null;
mock.method(send, 'audience', async () => {
    if (meanwhile) await meanwhile();
    return { eligible, sent: 0, queued: 0, failed: 0, nothing: 1, blocked: 0 };
});
mock.method(send, 'enqueue', async (ids, year) => {
    queued.push({ ids, year });
    if (whileWriting) whileWriting();
    return ids.length;
});
mock.method(send, 'unqueue', async (ids, year) => {
    unqueued.push({ ids, year });
    return ids.length;
});
mock.method(send, 'progress', async () => ({ queued: 0, sending: 0, sent: 0, failed: 0, quiet: 0, total: 0 }));
mock.method(render, 'drawInBackground', (ids, year) => {
    drawing.push({ ids, year });
    return true;
});
mock.method(ready, 'toDraw', async () => toDraw);
// A drawing (the panel's) going
let drawingBusy = false;
mock.method(render, 'drawingState', () => ({ running: drawingBusy, left: 0 }));
mock.method(Chat, 'findAll', async ({ where } = {}) =>
    where ? chats.filter((c) => where.id.includes(String(c.id))) : chats
);
// Since when each chat has had something to show: its oldest subscription (no films here)
mock.method(Subscription, 'findAll', async ({ where }) =>
    chats.filter((c) => where.chatId.includes(String(c.id))).map((c) => ({ chatId: c.id, since: c.since }))
);
mock.method(Watchlist, 'findAll', async () => []);

const schedule = require('../../src/recap/schedule');

/** Sets the schedule in this process as .env would have it. */
function set({ on = true, day = '2026-12-28', hour = 12 } = {}) {
    process.env.RECAP_SCHEDULE = on ? 'on' : 'off';
    process.env.RECAP_SCHEDULE_DAY = day || '';
    process.env.RECAP_SCHEDULE_HOUR = hour === null ? '' : String(hour);
}

const OLD = new Date('2026-01-01T00:00:00Z');
const MOSCOW = { id: 1, timezone: 'Europe/Moscow', since: OLD };
const KAMCHATKA = { id: 2, timezone: 'Asia/Kamchatka', since: OLD };
const KALININGRAD = { id: 3, timezone: 'Europe/Kaliningrad', since: OLD };
// No zone set: Moscow
const NO_ZONE = { id: 4, timezone: null, since: OLD };

afterEach(() => {
    eligible = [];
    chats = [];
    queued.length = 0;
    toDraw = [];
    drawing.length = 0;
    unqueued.length = 0;
    meanwhile = null;
    whileWriting = null;
    drawingBusy = false;
    for (const k of KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});
after(() => {
    mock.restoreAll();
    if (savedEnv.ENV_FILE === undefined) delete process.env.ENV_FILE;
    else process.env.ENV_FILE = savedEnv.ENV_FILE;
    fs.rmSync(DIR, { recursive: true, force: true });
});

describe('the day and the hour', () => {
    test('a day from 15 December to 10 January; a January day sends the year before', () => {
        for (const day of ['2026-12-15', '2026-12-31', '2027-01-01', '2027-01-10'])
            assert.ok(schedule.inWindow(day), day);
        for (const day of ['2026-12-14', '2027-01-11', '2026-06-01', '2026-02-30', '28.12.2026', '', undefined])
            assert.ok(!schedule.inWindow(day), String(day));
        assert.equal(schedule.yearOf('2026-12-28'), 2026);
        assert.equal(schedule.yearOf('2027-01-05'), 2026);
    });

    test('the hour is each chat’s own: the far east first, Kaliningrad last', () => {
        const s = { day: '2026-12-28', hour: 12 };
        assert.equal(schedule.momentIn(s, 'Europe/Moscow').toISOString(), '2026-12-28T09:00:00.000Z');
        assert.equal(schedule.momentIn(s, 'Asia/Kamchatka').toISOString(), '2026-12-28T00:00:00.000Z');
        assert.equal(schedule.momentIn(s, null).toISOString(), '2026-12-28T09:00:00.000Z');
        const { first, last } = schedule.span(s);
        assert.equal(first.toISOString(), '2026-12-28T00:00:00.000Z');
        assert.equal(last.toISOString(), '2026-12-28T10:00:00.000Z');
    });

    test('.env read with care: a broken day or hour is no day', () => {
        set({ day: '2026-12-28', hour: 12 });
        assert.deepEqual(schedule.readSchedule(), { on: true, done: false, day: '2026-12-28', hour: 12, year: 2026 });
        process.env.RECAP_SCHEDULE_HOUR = '25';
        assert.equal(schedule.readSchedule().day, null);
        // On with no day (as the old Settings switch left it): off
        set({ day: '2026-07-01' });
        assert.deepEqual(schedule.readSchedule(), { on: false, done: false, day: null, hour: null, year: null });
        // The hours at the edges
        for (const [hour, ok] of [
            ['0', true],
            ['23', true],
            ['24', false],
            ['-1', false],
            ['1.5', false]
        ]) {
            set({ day: '2026-12-28' });
            process.env.RECAP_SCHEDULE_HOUR = hour;
            assert.equal(schedule.readSchedule().day !== null, ok, `hour ${hour}`);
        }
    });

    test('hour 0: the far east starts on the day before in UTC, and drawing ahead still comes first', () => {
        const s = { day: '2026-12-28', hour: 0 };
        assert.equal(schedule.momentIn(s, 'Asia/Kamchatka').toISOString(), '2026-12-27T12:00:00.000Z');
        assert.equal(schedule.span(s).last.toISOString(), '2026-12-27T22:00:00.000Z');
        const late = { day: '2026-12-28', hour: 23 };
        assert.equal(schedule.span(late).last.toISOString(), '2026-12-28T21:00:00.000Z');
    });

    test('the days the panel offers: one season, from tomorrow; the saved day kept; 28 December first', () => {
        const { dayChoices } = require('../../src/admin/routes/recap-schedule');
        const oct = dayChoices(new Date('2026-10-24T12:00:00Z'));
        assert.equal(oct.length, 27);
        assert.equal(oct[0], '2026-12-15');
        assert.equal(oct.at(-1), '2027-01-10');
        assert.deepEqual(dayChoices(new Date('2027-01-05T12:00:00Z')), [
            '2027-01-06',
            '2027-01-07',
            '2027-01-08',
            '2027-01-09',
            '2027-01-10'
        ]);
        // The season over: the next one
        assert.equal(dayChoices(new Date('2027-01-10T12:00:00Z'))[0], '2027-12-15');
        assert.equal(dayChoices(new Date('2027-01-11T12:00:00Z'), '2026-12-28')[0], '2026-12-28');
    });
});

describe('saving', () => {
    const NOW = new Date('2026-10-24T12:00:00Z');
    const off = { on: false, day: null, hour: null };
    const problem = (next, current = off, now = NOW) => schedule.problemWith(next, current, now);

    test('a day ahead in the window, turned on: fine', () => {
        assert.equal(problem({ on: false, day: '2026-12-28', hour: 12 }), null);
        assert.equal(
            problem({ on: true, day: '2026-12-28', hour: 12 }, { on: false, day: '2026-12-28', hour: 12 }),
            null
        );
    });

    test('outside the window, half set, or on with nothing set: refused', () => {
        assert.match(problem({ on: false, day: '2026-11-28', hour: 12 }), /15 December to 10 January/);
        assert.match(problem({ on: false, day: '2026-12-28', hour: null }), /both/);
        assert.match(problem({ on: true, day: null, hour: null }), /first/);
    });

    test('a passed day, or one less than an hour before the first chat: refused', () => {
        // The first chat, Kamchatka, is at 00:00 UTC on the 28th
        const dec27 = new Date('2026-12-27T23:30:00Z');
        assert.match(problem({ on: true, day: '2026-12-28', hour: 12 }, off, dec27), /less than an hour/);
        const jan = new Date('2027-01-05T00:00:00Z');
        assert.match(problem({ on: false, day: '2026-12-28', hour: 12 }, off, jan), /passed/);
    });

    test('while on, the day and the hour stay; turning off is always possible, even after the day', () => {
        const on = { on: true, day: '2026-12-28', hour: 12 };
        assert.match(problem({ on: true, day: '2026-12-29', hour: 12 }, on), /Turn it off/);
        assert.match(problem({ on: true, day: '2026-12-28', hour: 13 }, on), /Turn it off/);
        assert.equal(problem({ on: false, day: '2026-12-28', hour: 12 }, on, new Date('2027-03-01T00:00:00Z')), null);
    });

    test('a day beyond the coming season (sent straight to the API): refused', () => {
        assert.match(problem({ on: true, day: '2031-12-20', hour: 12 }), /coming season/);
        assert.equal(problem({ on: true, day: '2027-01-10', hour: 12 }), null);
    });
});

describe('sending by the clock', () => {
    test('off, or no day: nothing is queued, whatever the time', async () => {
        eligible = ['1'];
        chats = [MOSCOW];
        set({ on: false });
        assert.equal(await schedule.runSchedule(new Date('2026-12-28T12:00:00Z')), 0);
        set({ day: null, hour: null });
        assert.equal(await schedule.runSchedule(new Date('2026-12-28T12:00:00Z')), 0);
        assert.deepEqual(queued, []);
    });

    test('a minute before the first chat’s hour: nothing; then each chat at its own hour', async () => {
        set();
        eligible = ['1', '2', '3', '4'];
        chats = [MOSCOW, KAMCHATKA, KALININGRAD, NO_ZONE];
        assert.equal(await schedule.runSchedule(new Date('2026-12-27T23:59:00Z')), 0);
        assert.deepEqual(queued, []);

        // 12:00 in Kamchatka
        await schedule.runSchedule(new Date('2026-12-28T00:00:00Z'));
        assert.deepEqual(queued.pop(), { ids: ['2'], year: 2026 });
        // 11:59 in Moscow: still only Kamchatka (send.audience leaves out the queued, here a stand-in)
        eligible = ['1', '3', '4'];
        assert.equal(await schedule.runSchedule(new Date('2026-12-28T08:59:00Z')), 0);
        await schedule.runSchedule(new Date('2026-12-28T09:00:00Z'));
        assert.deepEqual(queued.pop(), { ids: ['1', '4'], year: 2026 });
        eligible = ['3'];
        await schedule.runSchedule(new Date('2026-12-28T10:00:00Z'));
        assert.deepEqual(queued.pop(), { ids: ['3'], year: 2026 });
    });

    test('a January day sends the year before', async () => {
        set({ day: '2027-01-05', hour: 12 });
        eligible = ['1'];
        chats = [MOSCOW];
        await schedule.runSchedule(new Date('2027-01-05T09:00:00Z'));
        assert.deepEqual(queued, [{ ids: ['1'], year: 2026 }]);
    });

    test('the bot down at the hour: it sends when back, however late; not to a chat that subscribed since', async () => {
        set();
        const newcomer = { id: 5, timezone: 'Europe/Moscow', since: new Date('2027-01-20T00:00:00Z') };
        eligible = ['1', '5'];
        chats = [MOSCOW, newcomer];
        await schedule.runSchedule(new Date('2027-02-01T00:00:00Z'));
        assert.deepEqual(queued, [{ ids: ['1'], year: 2026 }]);
    });

    test('an old chat that subscribes on the day: before its own hour it gets it, after it not', async () => {
        set();
        // 08:00 and 10:00 UTC: an hour before and after 12:00 in Moscow
        const early = { id: 6, timezone: 'Europe/Moscow', since: new Date('2026-12-28T08:00:00Z') };
        const late = { id: 7, timezone: 'Europe/Moscow', since: new Date('2026-12-28T10:00:00Z') };
        eligible = ['6', '7'];
        chats = [early, late];
        await schedule.runSchedule(new Date('2026-12-28T09:50:00Z'));
        assert.deepEqual(queued, [{ ids: ['6'], year: 2026 }]);
    });

    test('drawing ahead failing (the database for one chat): the queuing goes on', async () => {
        set({ day: '2027-01-02', hour: 12 });
        eligible = ['2'];
        chats = [KAMCHATKA];
        ready.toDraw.mock.mockImplementationOnce(async () => {
            throw new Error('Database gone');
        });
        // The day before: only drawing ahead, which fails and is logged
        assert.equal(await schedule.runSchedule(new Date('2027-01-01T00:00:00Z')), 0);
        // Kamchatka's hour
        await schedule.runSchedule(new Date('2027-01-02T00:00:00Z'));
        assert.deepEqual(queued, [{ ids: ['2'], year: 2026 }]);
    });

    test('after the last zone’s hour it is done: a chat with something to show only later gets nothing', async () => {
        set();
        eligible = ['1'];
        chats = [MOSCOW];
        // Kaliningrad's 12:00, the last
        await schedule.runSchedule(new Date('2026-12-28T10:00:00Z'));
        assert.deepEqual(queued.pop(), { ids: ['1'], year: 2026 });
        assert.equal(schedule.readSchedule().done, true);
        assert.equal(schedule.readSchedule().on, false);
        assert.match(fs.readFileSync(process.env.ENV_FILE, 'utf8'), /RECAP_SCHEDULE=done/);
        // An old chat that subscribes in February
        eligible = ['3'];
        chats = [KALININGRAD];
        assert.equal(await schedule.runSchedule(new Date('2027-02-10T00:00:00Z')), 0);
        assert.deepEqual(queued, []);
    });

    test('Stop pressed while a run reads the chats: the run queues nothing', async () => {
        set();
        eligible = ['1'];
        chats = [MOSCOW];
        meanwhile = () => schedule.turnOff();
        assert.equal(await schedule.runSchedule(new Date('2026-12-28T09:00:00Z')), 0);
        assert.deepEqual(queued, []);
    });

    test('Stop pressed while the rows are written: the run takes them back', async () => {
        set();
        eligible = ['1'];
        chats = [MOSCOW];
        whileWriting = () => schedule.turnOff();
        assert.equal(await schedule.runSchedule(new Date('2026-12-28T09:00:00Z')), 0);
        assert.deepEqual(unqueued, [{ ids: ['1'], year: 2026 }]);
    });

    test('turned off and on again for a new day while the last run writes: its rows go, the new day stays', async () => {
        set();
        eligible = ['3'];
        chats = [KALININGRAD];
        whileWriting = () => set({ day: '2027-01-05', hour: 12 });
        // Kaliningrad's hour, the last: this run would mark the old day done
        assert.equal(await schedule.runSchedule(new Date('2026-12-28T10:00:00Z')), 0);
        assert.deepEqual(unqueued, [{ ids: ['3'], year: 2026 }]);
        assert.deepEqual(schedule.readSchedule(), { on: true, done: false, day: '2027-01-05', hour: 12, year: 2026 });
    });

    test('.env can’t be written: Stop and "done" still hold in the running bot', async () => {
        set();
        // A folder where the file should be: every write fails
        fs.rmSync(process.env.ENV_FILE, { force: true });
        fs.mkdirSync(process.env.ENV_FILE);
        try {
            // Off in the bot, and the panel is told .env still says on
            assert.deepEqual(schedule.turnOff(), { off: true, saved: false });
            assert.equal(schedule.readSchedule().on, false);
            set();
            eligible = ['1'];
            chats = [MOSCOW];
            await schedule.runSchedule(new Date('2026-12-28T10:00:00Z'));
            assert.equal(schedule.readSchedule().done, true);
        } finally {
            fs.rmSync(process.env.ENV_FILE, { recursive: true, force: true });
        }
    });

    test('done here but .env still says on (its write failed): Stop writes it again', () => {
        fs.writeFileSync(
            process.env.ENV_FILE,
            'RECAP_SCHEDULE=on\nRECAP_SCHEDULE_DAY=2026-12-28\nRECAP_SCHEDULE_HOUR=12\n'
        );
        process.env.RECAP_SCHEDULE = 'done';
        process.env.RECAP_SCHEDULE_DAY = '2026-12-28';
        process.env.RECAP_SCHEDULE_HOUR = '12';
        assert.deepEqual(schedule.turnOff(), { off: false, saved: true });
        assert.match(fs.readFileSync(process.env.ENV_FILE, 'utf8'), /RECAP_SCHEDULE=done/);
        assert.equal(schedule.readSchedule().done, true);
    });

    test('a run already going: the next tick does nothing rather than run beside it', async () => {
        set();
        eligible = ['1'];
        chats = [MOSCOW];
        let release;
        meanwhile = () => {
            meanwhile = null;
            return new Promise((resolve) => {
                release = resolve;
            });
        };
        const slow = schedule.runSchedule(new Date('2026-12-28T09:00:00Z'));
        assert.equal(await schedule.runSchedule(new Date('2026-12-28T09:00:00Z')), 0);
        if (release) release();
        await slow;
        assert.equal(queued.length, 1);
    });

    test('no drawing ahead once every hour has passed: a restart months later draws nothing', async () => {
        set({ day: '2026-12-29', hour: 12 });
        toDraw = ['1'];
        await schedule.runSchedule(new Date('2027-03-01T00:00:00Z'));
        assert.deepEqual(drawing, []);
    });

    test('a drawing already going (the panel’s): not asked again, tried on a later run', async () => {
        // A day of its own: what was drawn ahead is remembered per day and hour
        set({ day: '2026-12-31', hour: 12 });
        toDraw = ['1'];
        drawingBusy = true;
        await schedule.runSchedule(new Date('2026-12-30T00:00:00Z'));
        assert.deepEqual(drawing, []);
        drawingBusy = false;
        await schedule.runSchedule(new Date('2026-12-30T00:10:00Z'));
        assert.deepEqual(drawing, [{ ids: ['1'], year: 2026 }]);
    });

    test('from 03:00 Moscow time the day before, the cards not yet drawn are drawn, once', async () => {
        // A day of its own: what was drawn ahead is remembered per day and hour
        set({ day: '2026-12-29', hour: 12 });
        toDraw = ['1', '2'];
        await schedule.runSchedule(new Date('2026-12-27T23:59:00Z'));
        assert.deepEqual(drawing, []);
        await schedule.runSchedule(new Date('2026-12-28T00:00:00Z'));
        await schedule.runSchedule(new Date('2026-12-28T00:10:00Z'));
        assert.deepEqual(drawing, [{ ids: ['1', '2'], year: 2026 }]);
        assert.deepEqual(queued, [], 'drawing ahead sends nothing');
    });
});

describe('the API', () => {
    let server;
    let base;
    before(async () => {
        const app = express();
        app.use(express.json());
        app.use(require('../../src/admin/routes/recap-schedule'));
        app.use(require('../../src/admin/routes/recap'));
        await new Promise((resolve) => {
            server = app.listen(0, resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => server.close());

    const call = async (method, url, body) => {
        const res = await fetch(base + url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body && JSON.stringify(body)
        });
        return { status: res.status, body: await res.json() };
    };

    // A day the real clock still allows: the last one the panel offers now
    const { dayChoices } = require('../../src/admin/routes/recap-schedule');
    const DAY = dayChoices(new Date()).at(-1);
    const OTHER = dayChoices(new Date()).at(-2) || DAY;
    const envFile = () => fs.readFileSync(process.env.ENV_FILE, 'utf8');

    test('saved to .env and shown with who would get it; a refused save writes nothing', async () => {
        set({ on: false, day: null, hour: null });
        eligible = ['1', '2'];
        chats = [MOSCOW, KAMCHATKA];
        const saved = await call('PUT', '/api/recap/schedule', { on: true, day: DAY, hour: 12 });
        assert.equal(saved.status, 200);
        assert.equal(saved.body.on, true);
        assert.equal(saved.body.year, schedule.yearOf(DAY));
        assert.equal(saved.body.audience.eligible, 2);
        assert.equal(saved.body.firstAt, `${DAY}T00:00:00.000Z`);
        assert.equal(saved.body.lastAt, `${DAY}T09:00:00.000Z`);
        // The east has got it and only Moscow waits: the first hour is still Kamchatka's
        eligible = ['1'];
        const later = await call('GET', '/api/recap/schedule');
        assert.equal(later.body.firstAt, `${DAY}T00:00:00.000Z`);
        assert.match(envFile(), new RegExp(`RECAP_SCHEDULE=on\\nRECAP_SCHEDULE_DAY=${DAY}\\nRECAP_SCHEDULE_HOUR=12`));
        const written = envFile();

        // Moved while on; a day gone by; not a boolean: refused, .env and the bot as they were
        const moved = await call('PUT', '/api/recap/schedule', { on: true, day: OTHER, hour: 13 });
        assert.equal(moved.status, 400);
        assert.match(moved.body.error, /Turn it off/);
        await call('PUT', '/api/recap/schedule', { on: false, day: DAY, hour: 12 });
        const off = envFile();
        const passed = await call('PUT', '/api/recap/schedule', { on: true, day: '2020-12-28', hour: 12 });
        assert.equal(passed.status, 400);
        assert.match(passed.body.error, /passed/);
        const bad = await call('PUT', '/api/recap/schedule', { on: 'yes', day: DAY, hour: 12 });
        assert.equal(bad.status, 400);
        assert.equal(envFile(), off);
        assert.notEqual(off, written);
        assert.equal(process.env.RECAP_SCHEDULE_DAY, DAY);
    });

    test('the panel’s Stop also turns the schedule off, or it would queue the chats again', async () => {
        set({ on: true, day: DAY, hour: 12 });
        mock.method(send, 'stop', async () => 3, { times: 1 });
        const res = await call('POST', '/api/recap/stop');
        assert.deepEqual(res.body, { removed: 3, scheduleOff: true, scheduleSaved: true });
        assert.equal(process.env.RECAP_SCHEDULE, 'off');
        assert.equal(process.env.RECAP_SCHEDULE_DAY, DAY, 'the day stays for turning it on again');
    });
});
