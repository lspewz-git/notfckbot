const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * A notification that didn't reach its chat for good, for the dashboard: clicking a day of the
 * notifications chart lists them (src/send-failures.js). DailyStat only counts them. Kept 40 days,
 * a little past the chart's 30.
 */
const SendFailure = sequelize.define(
    'SendFailure',
    {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        // The chart's day, Moscow time, as DailyStat
        day: { type: DataTypes.STRING(10), allowNull: false },
        chatId: { type: DataTypes.BIGINT, allowNull: false },
        // What it was about: a title, "3 notifications held overnight", "Weekly digest"
        about: { type: DataTypes.STRING(255), allowNull: true },
        // gave_up: the queue's tries ran out; too_old: it waited in the queue past two days;
        // rejected: Telegram refused it; gone: the chat blocked the bot; not_queued: it couldn't
        // even be kept for a retry
        status: { type: DataTypes.STRING(20), allowNull: false },
        error: { type: DataTypes.STRING(500), allowNull: true },
        // Notifications it stands for: a held list is several
        count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
        // Update checks that tried it again from the queue
        tries: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        // When it first failed, for one that waited in the queue
        since: { type: DataTypes.DATE, allowNull: true }
    },
    { updatedAt: false, indexes: [{ fields: ['day'] }] }
);

module.exports = SendFailure;
