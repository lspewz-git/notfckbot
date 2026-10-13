const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * A notification Telegram didn't take (network, proxy, flood limit) after a few tries. The next
 * update check sends it again before anything new (src/cron/outbox.js), so a chat hears about an
 * episode or a film late rather than never.
 */
const PendingMessage = sequelize.define('PendingMessage', {
    chatId: {
        type: DataTypes.BIGINT,
        allowNull: false
    },
    text: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    // A poster URL: the message goes out as a photo with the text as its caption
    photo: {
        type: DataTypes.STRING(500),
        allowNull: true
    },
    // Update checks that have tried to send it again
    attempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0
    }
});

module.exports = PendingMessage;
