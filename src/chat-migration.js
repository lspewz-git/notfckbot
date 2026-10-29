/**
 * A group that becomes a supergroup gets a new chat id from Telegram: the old one stops working
 * ("group chat was upgraded to a supergroup chat"). Everything the bot keeps for the chat moves
 * to the new id in one go: its settings, subscriptions, films, held and queued messages, its
 * events (statistics) and its year recap sends. Told by the service message in either chat
 * (migrate_to_chat_id / migrate_from_chat_id, src/bot/index.js) or, if the bot missed it, by a
 * send that fails with the new id (src/delivery.js).
 */
const sequelize = require('./database');
const {
    Chat,
    Subscription,
    Watchlist,
    PendingMessage,
    HeldNotification,
    ChatEvent,
    RecapSend,
    AlertRecipient
} = require('./db');
const events = require('./chat-events');
const botStatus = require('./bot-status');
const { log } = require('./log');

// The chat's own settings, carried over to the new id (its name and type come from Telegram, and
// whether the bot is in it is the new chat's own: src/bot-status.js)
const KEEP = ['id', 'type', 'username', 'createdAt', 'updatedAt', 'bot_status', 'bot_status_at', 'bot_status_by'];

/**
 * Moves a chat's data from its old id to the new one. Rows the new chat already has for the same
 * title (or recap year) win; the old chat's copies of those go. Safe to call twice.
 * @returns {Promise<boolean>} whether there was anything to move
 */
async function migrateChat(fromId, toId) {
    const from = String(fromId);
    const to = String(toId);
    if (!from || !to || from === to) return false;
    const moved = await sequelize.transaction(async (transaction) => {
        const old = await Chat.findByPk(from, { transaction });
        if (!old) return false;
        const settings = Object.fromEntries(
            Object.entries(old.get({ plain: true })).filter(([k]) => !KEEP.includes(k))
        );
        const existing = await Chat.findByPk(to, { transaction });
        if (existing) await existing.update(settings, { transaction });
        else await Chat.create({ ...settings, id: to, type: 'supergroup', username: old.username }, { transaction });

        // What the new chat has already: the old chat's copies of those would clash
        const clashing = async (model, field) =>
            (await model.findAll({ where: { chatId: to }, attributes: [field], raw: true, transaction })).map(
                (r) => r[field]
            );
        const series = await clashing(Subscription, 'seriesId');
        if (series.length) await Subscription.destroy({ where: { chatId: from, seriesId: series }, transaction });
        const films = await clashing(Watchlist, 'tmdb_id');
        if (films.length) await Watchlist.destroy({ where: { chatId: from, tmdb_id: films }, transaction });
        const years = await clashing(RecapSend, 'year');
        if (years.length) await RecapSend.destroy({ where: { chatId: from, year: years }, transaction });
        // An alert recipient is the chat itself (its id is the key): the old row goes when the new is one already
        if (await AlertRecipient.findByPk(to, { transaction })) {
            await AlertRecipient.destroy({ where: { chatId: from }, transaction });
        }

        const models = [
            Subscription,
            Watchlist,
            PendingMessage,
            HeldNotification,
            ChatEvent,
            RecapSend,
            AlertRecipient
        ];
        for (const model of models) {
            await model.update({ chatId: to }, { where: { chatId: from }, transaction });
        }
        await old.destroy({ transaction });
        return true;
    });
    if (moved) {
        // Events and statuses noted but not written yet carry the old id too
        events.moveChat(from, to);
        botStatus.moveChat(from, to);
        log.info(`[Chat] Group ${from} became supergroup ${to}: its data moved`);
    }
    return moved;
}

/** The new id a failed send names, when the group became a supergroup; else null. */
function migratedTo(err) {
    const params = err && err.response && err.response.parameters;
    return params && params.migrate_to_chat_id ? String(params.migrate_to_chat_id) : null;
}

module.exports = { migrateChat, migratedTo };
