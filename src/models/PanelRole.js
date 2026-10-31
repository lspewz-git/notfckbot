const { DataTypes } = require('sequelize');
const sequelize = require('../database');

/**
 * A person's role in the panel, set by an admin (src/account/roles.js). Without a row a person the
 * bot knows is a user while sign-up is open, and has no access while it is closed.
 */
const PanelRole = sequelize.define('PanelRole', {
    // The Telegram user
    userId: { type: DataTypes.BIGINT, primaryKey: true },
    // 'none': no access, even with sign-up open
    role: { type: DataTypes.ENUM('admin', 'user', 'none'), allowNull: false }
});

module.exports = PanelRole;
