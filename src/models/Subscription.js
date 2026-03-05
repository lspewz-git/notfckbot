const { DataTypes } = require('sequelize');
const sequelize = require('../database');
const Chat = require('./Chat');
const Series = require('./Series');

const Subscription = sequelize.define('Subscription', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    notify_type: {
        type: DataTypes.ENUM('episode', 'season', 'first_and_full'),
        defaultValue: 'episode',
        allowNull: false
    }
});

// Relationships
Chat.belongsToMany(Series, { through: Subscription, foreignKey: 'chatId' });
Series.belongsToMany(Chat, { through: Subscription, foreignKey: 'seriesId' });

Subscription.belongsTo(Chat, { foreignKey: 'chatId' });
Subscription.belongsTo(Series, { foreignKey: 'seriesId' });

module.exports = Subscription;
