const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * A browser a user has signed in from (src/account/devices.js). The id is a SHA-256 digest of the
 * browser's own nfb_device cookie, so a copy of the table can't pose as anyone's browser. Kept after
 * sign-out: the browser stays known, and the bot doesn't ask "Это вы?" for it again.
 */
const AccountDevice = sequelize.define(
    'AccountDevice',
    {
        deviceId: { type: DataTypes.STRING(64), primaryKey: true },
        userId: { type: DataTypes.BIGINT, primaryKey: true },
        // "Safari, iPhone", the country code and the network, as last seen
        name: { type: DataTypes.STRING(64), allowNull: true },
        country: { type: DataTypes.STRING(2), allowNull: true },
        network: { type: DataTypes.STRING(128), allowNull: true },
        // false: signed in by digits nobody confirmed ("Это я"); a later /code from it asks again
        trusted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        firstSeen: { type: DataTypes.DATE, allowNull: false },
        lastSeen: { type: DataTypes.DATE, allowNull: false }
    },
    { timestamps: false, indexes: [{ fields: ['userId'] }, { fields: ['lastSeen'] }] }
);

module.exports = AccountDevice;
