/** The panel's tables: chats, subscriptions, films, series. */
const { Chat, Series, Subscription, Watchlist } = require('../../db');
const { isFinishedStatus } = require('../../constants');

const router = require('express').Router();
const { log } = require('../../log');
const { isTelegramReady } = require('../../telegram-ready');
const { rolesOf } = require('../../account/roles');
const { withPasswords } = require('../../account/password');
const { sendPanel } = require('../catalog-names');

// A name's wait: the table doesn't hang on a Telegram that doesn't answer
const NAME_TIMEOUT_MS = 5000;

// Chats whose name Telegram refused to give us (bot kicked, chat deleted...): a 400 or 403, not a
// network failure, a 429 or a 5xx. Remembered so the polling admin panel doesn't retry them on
// every refresh.
const unresolvableChatNames = new Set();
let backfill = null;

async function backfillChatNames(chats, bot) {
    // Before Telegram's first answer every name would wait out its timeout: the table comes first
    if (!bot || !isTelegramReady() || backfill) return;

    const pending = chats.filter(
        (c) => !c.username && c.type !== 'private' && !unresolvableChatNames.has(String(c.id))
    );
    if (!pending.length) return;

    backfill = (async () => {
        for (let i = 0; i < pending.length; i += 4) {
            await Promise.all(
                pending.slice(i, i + 4).map(async (chat) => {
                    try {
                        const info = await bot.telegram.callApi(
                            'getChat',
                            { chat_id: chat.id },
                            { signal: AbortSignal.timeout(NAME_TIMEOUT_MS) }
                        );
                        const name = info.title || (info.username ? `@${info.username}` : null);
                        if (name) {
                            await chat.update({ username: name });
                        } else {
                            unresolvableChatNames.add(String(chat.id));
                        }
                    } catch (err) {
                        if (err.response && [400, 403].includes(err.response.error_code)) {
                            unresolvableChatNames.add(String(chat.id));
                        }
                        log.error(`[Admin] Could not resolve name for chat ${chat.id}: ${err.message}`);
                    }
                })
            );
        }
    })().finally(() => {
        backfill = null;
    });
    await backfill;
}

router.get('/api/data/:type', async (req, res) => {
    try {
        const { type } = req.params;
        let data = [];
        if (type === 'subs') {
            const subs = await Subscription.findAll({
                include: [{ model: Chat }, { model: Series }]
            });
            // The server owns the "archived" rule so the panel never keeps its own status list
            data = subs.map((s) => ({ ...s.toJSON(), archived: isFinishedStatus(s.Series && s.Series.status) }));
        } else if (type === 'series') {
            data = await Series.findAll();
        } else if (type === 'films') {
            data = await Watchlist.findAll({
                include: [{ model: Chat }]
            });
        } else if (type === 'chats') {
            data = await Chat.findAll({
                order: [['createdAt', 'DESC']]
            });
            backfillChatNames(data, req.app.get('bot')).catch((err) =>
                log.warn(`[Admin] Chat name backfill failed: ${err.message}`)
            );
            // Who may sign in to the panel: a badge on the row and the role in its menu (routes/access.js
            // sets it), and whether they have a password the menu can remove
            const people = data.filter((c) => c.type === 'private').map((c) => String(c.id));
            const [roles, passwords] = await Promise.all([rolesOf(people), withPasswords()]);
            data = data.map((c) =>
                c.type === 'private'
                    ? { ...c.toJSON(), panelRole: roles.get(String(c.id)), hasPassword: passwords.has(String(c.id)) }
                    : { ...c.toJSON(), panelRole: null }
            );
        }
        if (type === 'chats') res.json(data);
        else await sendPanel(req, res, data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
