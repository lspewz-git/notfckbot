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
    }
});

module.exports = Series;
