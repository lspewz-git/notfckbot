const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * The year's recap to one chat (src/recap/send.js): queued from the panel, then sent, or failed.
 * One row per chat and year, so a chat gets its year once, however often the button is pressed.
 */
const RecapSend = sequelize.define(
    'RecapSend',
    {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        chatId: { type: DataTypes.BIGINT, allowNull: false },
        year: { type: DataTypes.INTEGER, allowNull: false },
        // queued (waiting, quiet hours included), sending, sent, failed (for good)
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'queued' },
        // Tries that ended in a temporary failure; after a few the row is failed
        attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        error: { type: DataTypes.STRING, allowNull: true },
        sentAt: { type: DataTypes.DATE, allowNull: true }
    },
    { indexes: [{ unique: true, fields: ['chatId', 'year'] }] }
);

module.exports = RecapSend;
