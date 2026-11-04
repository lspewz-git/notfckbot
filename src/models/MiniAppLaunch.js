const { DataTypes } = require('sequelize');
const sequelize = require('../database');

// Keep spent launches independently of sessions so signing out does not make them usable again.
module.exports = sequelize.define(
    'MiniAppLaunch',
    {
        id: { type: DataTypes.STRING(64), primaryKey: true },
        expiresAt: { type: DataTypes.DATE, allowNull: false }
    },
    { timestamps: false, indexes: [{ fields: ['expiresAt'] }] }
);
