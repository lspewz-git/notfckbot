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
    // Quiet hours: whole hours in the chat's time zone (src/quiet.js); both null when off.
    // Notifications in them are held and come as one message when they end.
    quiet_start: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    quiet_end: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    // An IANA zone of Russia's (src/quiet.js ZONES): for quiet hours and the digests' send time
    timezone: {
        type: DataTypes.STRING(40),
        allowNull: false,
        defaultValue: 'Europe/Moscow'
    },
    // The digests: the week ahead on Mondays, the month on the 1st, at 10:00 in the chat's zone
    // (src/cron/digests.js). Off until the chat turns them on
    digest_week: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    digest_month: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
    },
    // The period last sent (the week's Monday, "2026-10-12"; the month, "2026-10"), so each goes once
    digest_week_sent: {
        type: DataTypes.STRING(10),
        allowNull: true
    },
    digest_month_sent: {
        type: DataTypes.STRING(7),
        allowNull: true
    },
    blockedUntil: {
        type: DataTypes.DATE,
        allowNull: true
    },
    // Whether the bot can still reach the chat (src/bot-status.js): active; stopped, a user who
    // blocked the bot; removed, a group that took it out; deleted, an account or chat that is gone.
    // The panel's own block is blockedUntil, not this.
    bot_status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'active'
    },
    // When it last changed (null: never, since recording began) and who did it in a group
    bot_status_at: {
        type: DataTypes.DATE,
        allowNull: true
    },
    bot_status_by: {
        type: DataTypes.STRING,
        allowNull: true
    },
    // The chat's last message or button to the bot, written every ten minutes at most
    last_seen_at: {
        type: DataTypes.DATE,
        allowNull: true
    }
});

module.exports = Chat;
