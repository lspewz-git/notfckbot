const { DataTypes } = require('sequelize');
const sequelize = require('../database');

const Series = sequelize.define('Series', {
    kp_id: {
        type: DataTypes.INTEGER,
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
    }
});

module.exports = Series;
