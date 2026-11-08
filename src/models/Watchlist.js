const { DataTypes } = require('sequelize');
const sequelize = require('../database');
const Chat = require('./Chat');

/**
 * Watchlist tracks each chat's main release and optional digital notification independently.
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
    // Legacy column name: the selected main Release date, not necessarily a digital release.
    premiere_digital: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // The film's known digital date and country, kept by the check; Kinopoisk once a day,
    // the premiere in Russia, the online release there and its cinemas ("Okko, START")
    digital_date: { type: DataTypes.STRING(10), allowNull: true },
    digital_country: { type: DataTypes.STRING(2), allowNull: true },
    ru_premiere: { type: DataTypes.STRING(10), allowNull: true },
    ru_digital: { type: DataTypes.STRING(10), allowNull: true },
    ru_services: { type: DataTypes.STRING, allowNull: true },
    // Selected Release and its countries; cinema_date is also the main date for digital-only films.
    // online_estimate is retained to identify and clear legacy guesses, never generated now.
    cinema_date: { type: DataTypes.STRING(10), allowNull: true },
    cinema_country: { type: DataTypes.STRING(2), allowNull: true },
    release_countries: { type: DataTypes.TEXT, allowNull: true },
    cinema_ru_date: { type: DataTypes.STRING(10), allowNull: true },
    online_date: { type: DataTypes.STRING(10), allowNull: true },
    online_estimate: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    digital_notified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    // Zero marks existing rows, baselined silently by the first successful date refresh.
    release_rule_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // When Kinopoisk was last asked; null = never
    ru_checked_at: { type: DataTypes.DATE, allowNull: true },
    // What the title is, for the chats' statistics (titleFacts() in src/api/tmdb.js); kept current
    // by the update check
    genres: { type: DataTypes.STRING, allowNull: true },
    countries: { type: DataTypes.STRING(40), allowNull: true },
    runtime: { type: DataTypes.INTEGER, allowNull: true },
    rating: { type: DataTypes.FLOAT, allowNull: true },
    // Whether the main Release has been notified, or was already out when added/baselined.
    notified: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    // Legacy mark retained so upgrading the schema does not drop existing columns.
    premiere_notified: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    }
});

// Associations
Chat.hasMany(Watchlist, { foreignKey: 'chatId', onDelete: 'CASCADE' });
Watchlist.belongsTo(Chat, { foreignKey: 'chatId' });

module.exports = Watchlist;
