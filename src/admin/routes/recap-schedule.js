/**
 * Year recap → Schedule (src/recap/schedule.js): the day and the hour the recap goes out by
 * itself, the switch, and who it would go to.
 */
const { Chat } = require('../../db');
const schedule = require('../../recap/schedule');
const recap = require('../../recap/send');
const { z, valid } = require('../validate');
const { log } = require('../../log');

const router = require('express').Router();

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The days the form offers: those of the window still ahead (from tomorrow), this season's or,
 * once it is over, the next one's. The day saved is kept among them, even when it has passed.
 */
function dayChoices(now = new Date(), saved = null) {
    const days = [];
    for (let t = now.getTime() + DAY_MS; days.length < 40 && t < now.getTime() + 400 * DAY_MS; t += DAY_MS) {
        const day = iso(t);
        if (schedule.inWindow(day)) days.push(day);
        // The window's days run together: one season only
        else if (days.length) break;
    }
    if (saved && !days.includes(saved)) days.unshift(saved);
    return days;
}

/** 28 December when it is offered, else the first day offered: what the form shows before a day is picked. */
function suggestedDay(days) {
    return days.find((d) => d.endsWith('-12-28')) || days[0];
}

/** Everything the tab shows. */
async function scheduleState(now = new Date()) {
    const current = schedule.readSchedule();
    const days = dayChoices(now, current.day);
    const year = current.year || schedule.yearOf(suggestedDay(days));
    const [who, progress] = await Promise.all([recap.audience(year, now), recap.progress(year, now)]);
    let firstAt = null;
    let lastAt = null;
    if (current.day) {
        // Over the zones of every chat, not only those still waiting: once the east has got it, the
        // first hour stays the first, and the tab says it is sending rather than counting down again
        const chats = await Chat.findAll({ attributes: ['timezone'], raw: true });
        const moments = chats.length
            ? chats.map((c) => schedule.momentIn(current, c.timezone).getTime())
            : Object.values(schedule.span(current)).map((d) => d.getTime());
        firstAt = new Date(Math.min(...moments)).toISOString();
        lastAt = new Date(Math.max(...moments)).toISOString();
    }
    const { eligible, ...counts } = who;
    return {
        ...current,
        year,
        days,
        suggested: { day: suggestedDay(days), hour: 12 },
        firstAt,
        lastAt,
        audience: { eligible: eligible.length, ...counts },
        progress
    };
}

router.get('/api/recap/schedule', async (req, res) => {
    try {
        res.json(await scheduleState());
    } catch (err) {
        log.error(`[Admin] Recap schedule failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

const body = z.object({
    on: z.boolean({ error: 'On or off' }),
    day: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'A day as YYYY-MM-DD' })
        .nullable(),
    hour: z.number().int().min(0).max(23, { error: 'Pick an hour from 0 to 23' }).nullable()
});

router.put('/api/recap/schedule', async (req, res) => {
    const next = valid(body, req.body, res);
    if (!next) return;
    const current = schedule.readSchedule();
    const problem = schedule.problemWith(next, current);
    if (problem) return res.status(400).json({ error: problem });
    try {
        schedule.saveSchedule(next);
    } catch (err) {
        return res.status(500).json({ error: `Couldn't write .env: ${err.message}` });
    }
    log.info(
        `[Admin] Recap schedule ${next.on ? 'on' : 'off'}${next.day ? `: ${next.day} ${next.hour}:00 chat's time` : ''}`
    );
    try {
        res.json(await scheduleState());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
module.exports.dayChoices = dayChoices;
