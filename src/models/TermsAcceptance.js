const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * Proof that a person accepted the Terms of Service and the Privacy Policy: one row per acceptance,
 * only ever added (src/account/terms.js), never changed or removed by the app.
 */
module.exports = sequelize.define(
    'TermsAcceptance',
    {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        userId: { type: DataTypes.STRING(32), allowNull: false },
        termsVersion: { type: DataTypes.STRING(16), allowNull: false },
        privacyVersion: { type: DataTypes.STRING(16), allowNull: false },
        // 'signin' (the checkbox on the sign-in screen) or 'before-you-start' (after signing in)
        source: { type: DataTypes.STRING(24), allowNull: false },
        ip: { type: DataTypes.STRING(45), allowNull: true },
        userAgent: { type: DataTypes.STRING(512), allowNull: true }
    },
    { updatedAt: false, indexes: [{ fields: ['userId', 'termsVersion', 'privacyVersion'] }] }
);
