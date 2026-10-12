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
    // Who may press the bot's inline buttons in a group: 'owner', only whoever called up that
    // message (a search, the subscriptions menu); 'all', anyone in the chat. Private chats
    // have one user, so it doesn't apply there.
    buttons_mode: {
        type: DataTypes.ENUM('owner', 'all'),
        allowNull: false,
        defaultValue: 'owner'
    },
    blockedUntil: {
        type: DataTypes.DATE,
        allowNull: true
    }
});

module.exports = Chat;
