const { Sequelize } = require('sequelize');
require('dotenv').config();

const isDocker = process.env.IS_DOCKER === 'true';
const dbHost = process.env.DB_HOST || 'db';

const sequelize = new Sequelize(
  process.env.DB_NAME || 'series_bot',
  process.env.DB_USER || 'bot_user',
  process.env.DB_PASSWORD || 'bot_password',
  {
    host: (dbHost === 'db' && !isDocker) ? 'localhost' : dbHost,
    dialect: 'mariadb',
    logging: false,
    dialectOptions: {
      connectTimeout: 60000
    }
  }
);

module.exports = sequelize;
