const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * A notification that came up in a chat's quiet hours. Held until they end, then listed in one
 * message (src/cron/held.js); the full message stays a few days for that list's buttons.
 */
const HeldNotification = sequelize.define('HeldNotification', {
    chatId: {
        type: DataTypes.BIGINT,
        allowNull: false
    },
    // One line of the morning list, HTML: "📺 <b>Пацаны</b> — серия S5E4"
    line: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    // The list's button for it: "Пацаны S5E4"
    label: {
        type: DataTypes.STRING(120),
        allowNull: false
    },
    // The notification itself, as it would have gone out
    text: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    photo: {
        type: DataTypes.STRING(500),
        allowNull: true
    },
    // When the list with it went out; null while held
    sentAt: {
        type: DataTypes.DATE,
        allowNull: true
    }
});

module.exports = HeldNotification;
