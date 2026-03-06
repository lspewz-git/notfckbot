const { DataTypes } = require('sequelize');
const sequelize = require('../database');
const Chat = require('./Chat');

/**
 * Watchlist — tracks unreleased movies a user wants to be notified about.
 * The cron job checks premiere.digital and notifies when it arrives.
 */
const Watchlist = sequelize.define('Watchlist', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    // TMDB ID of the movie
    tmdb_id: {
        type: DataTypes.STRING,
        allowNull: false
    },
    title: {
        type: DataTypes.STRING,
        allowNull: false
    },
    poster_url: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // Expected release year from API
    year: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    // Last known digital premiere date (ISO string). Null = not announced yet.
    premiere_digital: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // Whether we have already sent the release notification
    notified: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    }
});

// Associations
Chat.hasMany(Watchlist, { foreignKey: 'chatId', onDelete: 'CASCADE' });
Watchlist.belongsTo(Chat, { foreignKey: 'chatId' });

module.exports = Watchlist;
