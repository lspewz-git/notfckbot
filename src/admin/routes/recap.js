/**
 * Sending the year's recap from the panel (src/recap/send.js): who would get it, how the sending
 * goes, and the two buttons, one chat and every chat. Each asks first in the panel.
 */
const { Chat, RecapSend } = require('../../db');
const recap = require('../../recap/send');
const schedule = require('../../recap/schedule');
const { z, valid, chatId } = require('../validate');
const { log } = require('../../log');

const router = require('express').Router();

const yearOf = (source, res) => {
    const parsed = valid(z.object({ year: z.coerce.number().int({ error: 'Bad year' }) }), source, res);
    if (!parsed) return null;
    if (!recap.sendableYear(parsed.year)) {
        res.status(400).json({ error: 'Only this year or the last one can be sent' });
        return null;
    }
    return parsed.year;
};

/** Starts the queue in the background; the answer doesn't wait for it. */
const kick = (req) =>
    recap.processQueue(req.app.get('bot')).catch((err) => log.error(`[Recap] Queue failed: ${err.message}`));

router.get('/api/recap', async (req, res) => {
    const year = yearOf(req.query, res);
    if (!year) return;
    try {
        const { eligible, ...counts } = await recap.audience(year);
        res.json({
            year,
            audience: { eligible: eligible.length, ...counts },
            progress: await recap.progress(year)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/recap/send', async (req, res) => {
    const year = yearOf(req.body || {}, res);
    if (!year) return;
    try {
        const { eligible } = await recap.audience(year);
        const queued = await recap.enqueue(eligible, year);
        log.info(`[Admin] Year recap ${year} queued for ${queued} chat(s)`);
        kick(req);
        res.json({ queued, progress: await recap.progress(year) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/recap/stop', async (req, res) => {
    // Stop means nothing more goes: the schedule off first (at once in this process, so a run
    // queuing right now takes its rows back; it doesn't throw), then the queue
    const { off: scheduleOff, saved } = schedule.turnOff();
    try {
        const removed = await recap.stop();
        log.info(
            `[Admin] Year recap stopped: ${removed} chat(s) taken off the queue${scheduleOff ? ', schedule turned off' : ''}`
        );
        res.json({ removed, scheduleOff, scheduleSaved: saved });
    } catch (err) {
        // The queue stays, but the schedule is off all the same: the panel says so
        res.status(500).json({ error: err.message, scheduleOff, scheduleSaved: saved });
    }
});

router.get('/api/chat/:chatId/recap-status', async (req, res) => {
    const params = valid(z.object({ chatId: chatId() }), req.params, res);
    const year = params && yearOf(req.query, res);
    if (!year) return;
    try {
        const row = await RecapSend.findOne({ where: { chatId: params.chatId, year } });
        res.json({
            status: row ? row.status : null,
            sentAt: row ? row.sentAt : null,
            error: row ? row.error : null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/chat/:chatId/recap/send', async (req, res) => {
    const params = valid(z.object({ chatId: chatId() }), req.params, res);
    const year = params && yearOf(req.body || {}, res);
    if (!year) return;
    // { again: true }: the preview's "Send again", asked a second time in the panel
    const again = Boolean(req.body && req.body.again === true);
    try {
        const chat = await Chat.findByPk(params.chatId);
        if (!chat) return res.status(404).json({ error: 'Chat not found' });
        const row = await RecapSend.findOne({ where: { chatId: params.chatId, year } });
        // On its way: never twice at once. Sent: only when asked for again on purpose (the whole
        // list never sends a chat its year twice). A failed one may always be tried again
        if (row && (row.status === 'queued' || row.status === 'sending')) {
            return res.status(409).json({ error: `Already queued for ${year}` });
        }
        if (row && row.status === 'sent' && !again) {
            return res.status(409).json({ error: `Already sent for ${year}` });
        }
        if (row) await row.destroy();
        await recap.enqueue([params.chatId], year);
        log.info(
            `[Admin] Year recap ${year} queued for chat ${params.chatId}${row ? ` (again: was ${row.status})` : ''}`
        );
        kick(req);
        res.json({ queued: 1 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
