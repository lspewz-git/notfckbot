const { DataTypes } = require('sequelize');
const sequelize = require('../database');

const Series = sequelize.define('Series', {
    tmdb_id: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false
    },
    title: {
        type: DataTypes.STRING,
        allowNull: false
    },
    last_season: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    last_episode: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    last_episode_name: {
        type: DataTypes.STRING,
        allowNull: true
    },
    poster_url: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // TMDB production status: Returning Series / In Production / Planned /
    // Pilot / Ended / Canceled. Null until the next update check fills it in.
    status: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // Last season announced as complete ("весь сезон вышел"). Kept apart from
    // last_season so completion can be announced on a later check than the final
    // episode. Null until the first check after this column was added.
    completed_season: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    // Kinopoisk film ID for the watch links (kinopoisk.ru/film/ID, sspoisk.ru/film/ID).
    // Null until found; kinopoisk_checked_at spaces out retries for unknown titles.
    kinopoisk_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    kinopoisk_checked_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    // TMDB's next_episode_to_air, refreshed on every update check. Null when
    // nothing is announced (shown as TBA in the admin panel).
    next_episode_date: {
        type: DataTypes.DATEONLY,
        allowNull: true
    },
    next_episode_season: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    next_episode_number: {
        type: DataTypes.INTEGER,
        allowNull: true
    }
});

module.exports = Series;
