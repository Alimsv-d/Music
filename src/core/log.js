'use strict';
// Minimal structured logger; never logs secrets or full tokens.
const config = require('../config');

const SENSITIVE = /[0-9]{8,10}:[A-Za-z0-9_-]{35}/g;
function scrub(s) {
  return String(s).replace(SENSITIVE, '[TOKEN]').replace(config.botToken || '£££', '[TOKEN]');
}
function line(level, msg, extra) {
  const o = { t: new Date().toISOString(), level, msg: scrub(msg) };
  if (extra) o.data = scrub(typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 400));
  process.stdout.write(JSON.stringify(o) + '\n');
}
module.exports = {
  info: (m, e) => line('info', m, e),
  warn: (m, e) => line('warn', m, e),
  error: (m, e) => line('error', m, e),
  debug: (m, e) => { if (process.env.DEBUG) line('debug', m, e); },
};
