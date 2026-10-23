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
    },
    // What the title is, for the chats' statistics (titleFacts() in src/api/tmdb.js); kept current
    // by the update check
    genres: { type: DataTypes.STRING, allowNull: true },
    networks: { type: DataTypes.STRING, allowNull: true },
    countries: { type: DataTypes.STRING(40), allowNull: true },
    runtime: { type: DataTypes.INTEGER, allowNull: true },
    rating: { type: DataTypes.FLOAT, allowNull: true },
    // The years in which an episode aired, with their seasons, as "2024:2;2025:2,3", for the
    // release history. Null until every season has been looked at once
    // (src/cron/release-seasons.js); "" when none aired yet.
    release_seasons: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    // How many episodes aired each month, by season, and their minutes, for the chats'
    // statistics: "2026-03:2=4/180,3=1/45;2026-04:3=3/135" (src/cron/aired-episodes.js). Null until
    // every season has been looked at once
    aired_episodes: {
        type: DataTypes.TEXT,
        allowNull: true
    }
});

module.exports = Series;
