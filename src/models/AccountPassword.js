const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * A panel user's password (src/account/password.js), set by the user after signing in with
 * Telegram. Only the scrypt hash with its salt is stored.
 */
const AccountPassword = sequelize.define('AccountPassword', {
    // The Telegram user it belongs to
    userId: { type: DataTypes.BIGINT, primaryKey: true },
    hash: { type: DataTypes.STRING(160), allowNull: false }
});

module.exports = AccountPassword;
