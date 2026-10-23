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
    // The film's other dates, kept by the update check for the panel (shown, not acted on):
    // TMDB's digital release and its country ("US"), every check; from Kinopoisk once a day,
    // the premiere in Russia, the online release there and its cinemas ("Okko, START")
    digital_date: { type: DataTypes.STRING(10), allowNull: true },
    digital_country: { type: DataTypes.STRING(2), allowNull: true },
    ru_premiere: { type: DataTypes.STRING(10), allowNull: true },
    ru_digital: { type: DataTypes.STRING(10), allowNull: true },
    ru_services: { type: DataTypes.STRING, allowNull: true },
    // When Kinopoisk was last asked; null = never
    ru_checked_at: { type: DataTypes.DATE, allowNull: true },
    // What the title is, for the chats' statistics (titleFacts() in src/api/tmdb.js); kept current
    // by the update check
    genres: { type: DataTypes.STRING, allowNull: true },
    countries: { type: DataTypes.STRING(40), allowNull: true },
    runtime: { type: DataTypes.INTEGER, allowNull: true },
    rating: { type: DataTypes.FLOAT, allowNull: true },
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
