/**
 * Settings → Alerts (src/alerts/): who gets them and which, the shared rules, the last week's log,
 * and a test message. Recipients are chats the bot knows: a person who started it or a group.
 */
const { Op } = require('sequelize');
const { AlertRecipient, AlertLog, Chat } = require('../../db');
const catalog = require('../../alerts/catalog');
const alerts = require('../../alerts');
const { isLeft } = require('../../bot-status');
const { z, valid, chatId } = require('../validate');
const { log } = require('../../log');

const router = require('express').Router();

const CANDIDATES = 20;

/** A recipient as the panel shows it: the chat's name and type, what it gets, whether it can be reached. */
function recipientView(row, chat) {
    return {
        chatId: String(row.chatId),
        name: chat ? chat.username || null : null,
        type: chat ? chat.type : null,
        preset: row.preset,
        events: row.preset === 'custom' ? catalog.eventsOf(row) : null,
        lastAlertAt: row.last_alert_at,
        // stopped, removed, deleted (src/bot-status.js), missing: the chat is gone from the bot
        // left: lost moments ago, in memory only, so the row still says active
        unreachable: !chat ? 'missing' : !isLeft(chat) ? null : chat.bot_status === 'active' ? 'left' : chat.bot_status,
        unreachableAt: chat && isLeft(chat) ? chat.bot_status_at : null
    };
}

/** Everything the card shows. */
async function alertsState() {
    const rows = await AlertRecipient.findAll({ order: [['createdAt', 'ASC']] });
    const chats = rows.length ? await Chat.findAll({ where: { id: rows.map((r) => r.chatId) } }) : [];
    const byId = new Map(chats.map((c) => [String(c.id), c]));
    const recent = await AlertLog.findAll({
        where: { createdAt: { [Op.gte]: alerts.logSince() } },
        order: [['createdAt', 'DESC']],
        limit: 20
    });
    return {
        groups: catalog.GROUPS,
        events: catalog.EVENTS,
        rules: catalog.readRules(),
        recipients: rows.map((r) => recipientView(r, byId.get(String(r.chatId)))),
        log: recent.map((r) => ({
            event: r.event,
            kind: r.kind,
            sent: r.sent,
            failed: r.failed,
            sentTo: r.sentTo,
            at: r.createdAt
        }))
    };
}

/** Answers with the card's state, or 500. */
async function reply(res) {
    try {
        res.json(await alertsState());
    } catch (err) {
        log.error(`[Admin] Alerts failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
}

router.get('/api/alerts', (req, res) => reply(res));

// Chats to add: people and groups the bot can still reach, not recipients already, the most
// recently active first; `q` narrows by name or id
router.get('/api/alerts/candidates', async (req, res) => {
    const query = valid(z.object({ q: z.string().max(100).optional() }), req.query, res);
    if (!query) return;
    try {
        const taken = (await AlertRecipient.findAll({ attributes: ['chatId'] })).map((r) => String(r.chatId));
        const q = (query.q || '').trim().replace(/^@/, '');
        const where = {
            type: { [Op.in]: ['private', 'group', 'supergroup'] },
            bot_status: 'active',
            ...(taken.length ? { id: { [Op.notIn]: taken } } : {}),
            ...(q
                ? {
                      [Op.or]: [
                          { username: { [Op.like]: `%${q.replace(/[\\%_]/g, '\\$&')}%` } },
                          ...(/^-?\d{1,20}$/.test(q) ? [{ id: q }] : [])
                      ]
                  }
                : {})
        };
        const chats = await Chat.findAll({
            where,
            order: [['last_seen_at', 'DESC']],
            limit: CANDIDATES
        });
        res.json(
            chats.map((c) => ({
                chatId: String(c.id),
                name: c.username || null,
                type: c.type,
                lastSeenAt: c.last_seen_at
            }))
        );
    } catch (err) {
        log.error(`[Admin] Alert candidates failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

const idParam = z.object({ chatId: chatId() });

router.post('/api/alerts/recipients', async (req, res) => {
    const body = valid(idParam, req.body, res);
    if (!body) return;
    try {
        const chat = await Chat.findByPk(body.chatId);
        if (!chat) return res.status(404).json({ error: "The bot doesn't know this chat" });
        if (isLeft(chat)) return res.status(400).json({ error: "The bot can't write to this chat any more" });
        // New recipients start with the critical events only
        await AlertRecipient.findOrCreate({ where: { chatId: body.chatId }, defaults: { preset: 'critical' } });
        log.info(`[Admin] Alert recipient added: chat ${body.chatId}`);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
    reply(res);
});

const choice = z.object({
    preset: z.enum(catalog.PRESETS, { error: 'Pick everything, critical only or custom' }),
    events: z.array(z.enum(catalog.KEYS, { error: 'Unknown event' })).optional()
});

router.put('/api/alerts/recipients/:chatId', async (req, res) => {
    const params = valid(idParam, req.params, res);
    const body = params && valid(choice, req.body, res);
    if (!body) return;
    if (body.preset === 'custom' && !body.events) return res.status(400).json({ error: 'Custom needs its events' });
    try {
        const row = await AlertRecipient.findByPk(params.chatId);
        if (!row) return res.status(404).json({ error: 'Not a recipient' });
        await row.update({
            preset: body.preset,
            events: body.preset === 'custom' ? JSON.stringify([...new Set(body.events)]) : null
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
    reply(res);
});

router.delete('/api/alerts/recipients/:chatId', async (req, res) => {
    const params = valid(idParam, req.params, res);
    if (!params) return;
    try {
        await AlertRecipient.destroy({ where: { chatId: params.chatId } });
        log.info(`[Admin] Alert recipient removed: chat ${params.chatId}`);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
    reply(res);
});

// A test to one recipient (chatId) or to all; answers how many got it
router.post('/api/alerts/test', async (req, res) => {
    const body = valid(z.object({ chatId: chatId().optional() }), req.body, res);
    if (!body) return;
    try {
        // Removed meanwhile (another tab): say so, not "the bot can't reach them"
        if (body.chatId !== undefined && !(await AlertRecipient.findByPk(body.chatId))) {
            return res.status(404).json({ error: 'Not a recipient' });
        }
        res.json(await alerts.sendTest(body.chatId));
    } catch (err) {
        log.error(`[Admin] Alert test failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

const rules = z.object({
    downMinutes: z.number({ error: 'Minutes as a number' }),
    sendShare: z.string({ error: 'A share' }),
    repeatHours: z.number({ error: 'Hours as a number' }),
    fixed: z.boolean({ error: 'On or off' })
});

router.put('/api/alerts/rules', (req, res) => {
    const body = valid(rules, req.body, res);
    if (!body) return;
    const problem = catalog.problemWith(body);
    if (problem) return res.status(400).json({ error: problem });
    try {
        catalog.saveRules(body);
    } catch (err) {
        return res.status(500).json({ error: `Couldn't write .env: ${err.message}` });
    }
    log.info(`[Admin] Alert rules: ${JSON.stringify(body)}`);
    reply(res);
});

module.exports = router;
