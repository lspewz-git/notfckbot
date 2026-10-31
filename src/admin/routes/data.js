/** The panel's tables: chats, subscriptions, films, series. */
const { Chat, Series, Subscription, Watchlist } = require('../../db');
const { isFinishedStatus } = require('../../constants');

const router = require('express').Router();
const { log } = require('../../log');
const { isTelegramReady } = require('../../telegram-ready');
const { roleOf } = require('../../account/auth');

// A name's wait: the table doesn't hang on a Telegram that doesn't answer
const NAME_TIMEOUT_MS = 5000;

// Chats whose name Telegram refused to give us (bot kicked, chat deleted...): a 400 or 403, not a
// network failure, a 429 or a 5xx. Remembered so the polling admin panel doesn't retry them on
// every refresh.
const unresolvableChatNames = new Set();

async function backfillChatNames(chats, bot) {
    // Before Telegram's first answer every name would wait out its timeout: the table comes first
    if (!bot || !isTelegramReady()) return;

    const pending = chats.filter(
        (c) => !c.username && c.type !== 'private' && !unresolvableChatNames.has(String(c.id))
    );
    if (!pending.length) return;

    await Promise.all(
        pending.map(async (chat) => {
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
            await backfillChatNames(data, req.app.get('bot'));
            // Who may sign in to the panel: a badge on the row (routes/access.js sets it)
            data = data.map((c) => ({ ...c.toJSON(), panelRole: c.type === 'private' ? roleOf(c.id) : null }));
        }
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
