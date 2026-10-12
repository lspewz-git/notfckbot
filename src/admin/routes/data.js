/** The panel's tables: chats, subscriptions, films, series. */
const { Chat, Series, Subscription, Watchlist } = require('../../db');
const { isFinishedStatus } = require('../../constants');

const router = require('express').Router();

// Chats whose name Telegram refused to give us (bot kicked, chat deleted...).
// Remembered so the polling admin panel doesn't retry them on every refresh.
const unresolvableChatNames = new Set();

async function backfillChatNames(chats, bot) {
    if (!bot) return;

    const pending = chats.filter(
        (c) => !c.username && c.type !== 'private' && !unresolvableChatNames.has(String(c.id))
    );
    if (!pending.length) return;

    await Promise.all(
        pending.map(async (chat) => {
            try {
                const info = await bot.telegram.getChat(chat.id);
                const name = info.title || (info.username ? `@${info.username}` : null);
                if (name) {
                    await chat.update({ username: name });
                } else {
                    unresolvableChatNames.add(String(chat.id));
                }
            } catch (err) {
                unresolvableChatNames.add(String(chat.id));
                console.error(`[Admin] Could not resolve name for chat ${chat.id}: ${err.message}`);
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
        }
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
