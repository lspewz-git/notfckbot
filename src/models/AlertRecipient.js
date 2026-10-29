const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * Who gets the bot's alerts (src/alerts/): a chat the bot already knows, a person or a group, and
 * what it wants to hear about. preset: all, critical, or custom with the event keys in `events`.
 */
const AlertRecipient = sequelize.define('AlertRecipient', {
    chatId: { type: DataTypes.BIGINT, primaryKey: true },
    preset: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'critical' },
    // custom only: a JSON array of event keys (src/alerts/catalog.js)
    events: { type: DataTypes.TEXT, allowNull: true },
    last_alert_at: { type: DataTypes.DATE, allowNull: true }
});

module.exports = AlertRecipient;
