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
    menu_enabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    }
});

module.exports = Chat;
