const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * Each alert the bot sent, for the panel's "Recent alerts": the event, whether it was the alert,
 * the "fixed" message or a test, and how many recipients got it. Kept a week (src/alerts/).
 */
const AlertLog = sequelize.define(
    'AlertLog',
    {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        event: { type: DataTypes.STRING(30), allowNull: false },
        // alert, fixed or test
        kind: { type: DataTypes.STRING(10), allowNull: false },
        sent: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        failed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        // Who got it, when one person did: the log says the name rather than "1 person"
        sentTo: { type: DataTypes.STRING, allowNull: true }
    },
    { updatedAt: false, indexes: [{ fields: ['createdAt'] }] }
);

module.exports = AlertLog;
