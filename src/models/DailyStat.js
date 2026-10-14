const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * What the bot did on a day (Moscow time), for the dashboard's numbers and charts: notifications
 * that went out or didn't, update checks run and failed. Kept from when this table appeared.
 */
const DailyStat = sequelize.define(
    'DailyStat',
    {
        day: {
            type: DataTypes.STRING(10),
            primaryKey: true
        },
        sent: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        failed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        checks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        check_errors: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
    },
    { timestamps: false }
);

module.exports = DailyStat;
