const { DataTypes } = require('sequelize');
const sequelize = require('../database');

const Chat = sequelize.define('Chat', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        allowNull: false
    },
    type: {
        type: DataTypes.ENUM('private', 'group', 'supergroup', 'channel'),
        allowNull: false
    },
    username: {
        type: DataTypes.STRING,
        allowNull: true
    },
    menu_enabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    blockedUntil: {
        type: DataTypes.DATE,
        allowNull: true
    }
});

module.exports = Chat;
