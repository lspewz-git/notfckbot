const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * What happened in a chat, for its statistics in the panel and the year's recap: a notification
 * sent (or held, queued, lost), a subscription or film added or removed, a part of the bot used.
 * Written in batches by src/chat-events.js. The title is kept so a removed one still has a name.
 */
const ChatEvent = sequelize.define(
    'ChatEvent',
    {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        chatId: { type: DataTypes.BIGINT, allowNull: false },
        // notified, subscribed, mode, unsubscribed, film_added, film_removed, settings, used, bot_on, bot_off
        kind: { type: DataTypes.STRING(20), allowNull: false },
        // notified: episode / premiere / complete / status / film; subscribed and mode: the
        // notify_type; settings: the setting (its line is the title); used: the part of the bot
        detail: { type: DataTypes.STRING(30), allowNull: true },
        // notified only: sent, held (quiet hours), queued (for the next check) or failed
        outcome: { type: DataTypes.STRING(10), allowNull: true },
        tmdb_id: { type: DataTypes.STRING, allowNull: true },
        title: { type: DataTypes.STRING, allowNull: true },
        season: { type: DataTypes.INTEGER, allowNull: true },
        episode: { type: DataTypes.INTEGER, allowNull: true },
        // Who did it; null for the bot's own notifications
        userId: { type: DataTypes.BIGINT, allowNull: true },
        userName: { type: DataTypes.STRING, allowNull: true },
        // Where a change came from, for the chat's change log (src/chat-changes.js): bot, panel or account
        source: { type: DataTypes.STRING(10), allowNull: true }
    },
    { updatedAt: false, indexes: [{ fields: ['chatId', 'createdAt'] }] }
);

module.exports = ChatEvent;
