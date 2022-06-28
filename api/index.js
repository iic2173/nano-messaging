/* eslint no-console: "off" */

const mainApp = require('./src/app');
const db = require('./src/models');
const newRelic = require('newrelic');

require('dotenv').config();

const PORT = process.env.PORT || 7777;

db.sequelize
  .authenticate()
  .then(() => {
    console.log('Connection to the database has been established successfully.');
    mainApp.listen(PORT, (err) => {
      if (err) {
        return console.error('Failed', err);
      }
      console.log(`Listening on port ${PORT}`);
      return mainApp;
    });
  })
  .catch((err) => console.error('Unable to connect to the database:', err));
