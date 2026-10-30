const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * A signed-in browser on the account pages (src/account/auth.js). The id is the SHA-256 of the
 * cookie's token, never the token itself: a copy of the table can't sign anyone in.
 */
const AccountSession = sequelize.define(
    'AccountSession',
    {
        id: { type: DataTypes.STRING(64), primaryKey: true },
        // The Telegram user it belongs to
        userId: { type: DataTypes.BIGINT, allowNull: false },
        userName: { type: DataTypes.STRING, allowNull: true },
        expiresAt: { type: DataTypes.DATE, allowNull: false }
    },
    { updatedAt: false, indexes: [{ fields: ['userId'] }, { fields: ['expiresAt'] }] }
);

module.exports = AccountSession;
