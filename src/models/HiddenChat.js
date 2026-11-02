const { DataTypes } = require('sequelize');
const sequelize = require('../database');

// Personal display preference only; membership and subscriptions are unchanged.
module.exports = sequelize.define('HiddenChat', {
    userId: { type: DataTypes.BIGINT, primaryKey: true },
    chatId: { type: DataTypes.BIGINT, primaryKey: true }
});
