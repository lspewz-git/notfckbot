const { DataTypes } = require('sequelize');
const sequelize = require('../database');

// Display preferences belong to a person, including the local maintenance account (id 0).
module.exports = sequelize.define('AccountPreference', {
    userId: { type: DataTypes.BIGINT, primaryKey: true },
    language: { type: DataTypes.ENUM('auto', 'en', 'ru'), allowNull: false, defaultValue: 'auto' }
});
