const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * A notification that reached its chat, for the dashboard: clicking a day of the notifications
 * chart lists them next to the ones that didn't (SendFailure, src/send-failures.js). DailyStat only
 * counts them. Kept 40 days, a little past the chart's 30.
 */
const SentNotification = sequelize.define(
    'SentNotification',
    {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        // The chart's day, Moscow time, as DailyStat
        day: { type: DataTypes.STRING(10), allowNull: false },
        chatId: { type: DataTypes.BIGINT, allowNull: false },
        // What it was about: a title, "3 notifications held overnight", "Weekly digest"
        about: { type: DataTypes.STRING(255), allowNull: true },
        // episode / premiere / complete / status / film / film_digital (the update check), retry
        // (sent from the queue), held (the list after quiet hours), digest_w / digest_m
        kind: { type: DataTypes.STRING(20), allowNull: true },
        season: { type: DataTypes.INTEGER, allowNull: true },
        episode: { type: DataTypes.INTEGER, allowNull: true },
        // Notifications it stands for: a held list is several
        count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 }
    },
    { updatedAt: false, indexes: [{ fields: ['day'] }] }
);

module.exports = SentNotification;
