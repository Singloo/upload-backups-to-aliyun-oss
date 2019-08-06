const { run } = require('./dist/index');
const schedule = require('node-schedule');
schedule.scheduleJob('0 1 * * *', function(fireDate) {
  console.log('This job was supposed to run at ' + fireDate);
  run();
});
console.log('cron job is running');
