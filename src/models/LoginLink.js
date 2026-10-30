const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * A one-time sign-in link not used yet (src/account/auth.js): from /login in the bot, or from
 * login-link.js on the server when Telegram is out of reach. Kept in the database so the script,
 * a process of its own, can make one, and a restart doesn't void it. The id is the token's SHA-256.
 */
const LoginLink = sequelize.define(
    'LoginLink',
    {
        id: { type: DataTypes.STRING(64), primaryKey: true },
        userId: { type: DataTypes.BIGINT, allowNull: false },
        userName: { type: DataTypes.STRING, allowNull: true },
        // The chat /login was sent from: the panel opens it first
        chatId: { type: DataTypes.BIGINT, allowNull: true },
        expiresAt: { type: DataTypes.DATE, allowNull: false }
    },
    { updatedAt: false, indexes: [{ fields: ['expiresAt'] }] }
);

module.exports = LoginLink;
