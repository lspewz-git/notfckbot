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
        // notified, subscribed, mode, unsubscribed, film_added, film_removed, used
        kind: { type: DataTypes.STRING(20), allowNull: false },
        // notified: episode / premiere / complete / status / film; subscribed and mode: the
        // notify_type; used: the part of the bot (search, card, subs, calendar, history, ...)
        detail: { type: DataTypes.STRING(30), allowNull: true },
        // notified only: sent, held (quiet hours), queued (for the next check) or failed
        outcome: { type: DataTypes.STRING(10), allowNull: true },
        tmdb_id: { type: DataTypes.STRING, allowNull: true },
        title: { type: DataTypes.STRING, allowNull: true },
        season: { type: DataTypes.INTEGER, allowNull: true },
        episode: { type: DataTypes.INTEGER, allowNull: true },
        // Who did it, in a group; null for the bot's own notifications and the panel's changes
        userId: { type: DataTypes.BIGINT, allowNull: true },
        userName: { type: DataTypes.STRING, allowNull: true }
    },
    { updatedAt: false, indexes: [{ fields: ['chatId', 'createdAt'] }] }
);

module.exports = ChatEvent;
