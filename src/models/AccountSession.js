const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * A signed-in browser on the account pages (src/account/auth.js). The id is a SHA-256 digest,
 * never the cookie token itself: a copy of the table can't sign anyone in.
 */
const AccountSession = sequelize.define(
    'AccountSession',
    {
        id: { type: DataTypes.STRING(64), primaryKey: true },
        // The Telegram user it belongs to
        userId: { type: DataTypes.BIGINT, allowNull: false },
        userName: { type: DataTypes.STRING, allowNull: true },
        // false: signed in by /code digits nobody confirmed ("Это я"). Browsers this session marks are
        // remembered as untrusted, whatever cookie they bring (src/account/devices.js)
        trusted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        // For the Devices list in Account settings: "Safari, iPhone" (set once), and the country, network,
        // address and time of the browser's latest request (src/account/auth.js noteSession)
        name: { type: DataTypes.STRING(64), allowNull: true },
        country: { type: DataTypes.STRING(2), allowNull: true },
        network: { type: DataTypes.STRING(128), allowNull: true },
        // The address of that latest request, shown only to the session's owner in Devices
        ip: { type: DataTypes.STRING(45), allowNull: true },
        seenAt: { type: DataTypes.DATE, allowNull: true },
        expiresAt: { type: DataTypes.DATE, allowNull: false }
    },
    { updatedAt: false, indexes: [{ fields: ['userId'] }, { fields: ['expiresAt'] }] }
);

module.exports = AccountSession;
