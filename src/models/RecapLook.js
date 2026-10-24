const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * What a recap card is drawn on (src/recap/backgrounds.js): one row per card that has a picture,
 * 1 to 6. No row, or no picture: the card's plain colour.
 */
const RecapLook = sequelize.define('RecapLook', {
    card: { type: DataTypes.INTEGER, primaryKey: true },
    // The picture's id in the backgrounds store
    background: { type: DataTypes.STRING(40), allowNull: true },
    // How much the picture is darkened under the text, in percent
    dim: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
});

module.exports = RecapLook;
