'use strict';
// Token-bucket rate limiting with graduated penalties and owner/whitelist exemption.
const config = require('../config');
const { getStore } = require('./store');

const buckets = new Map(); // key -> {tokens, last}
function take(key, rate, per) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { tokens: rate, last: now }; buckets.set(key, b); }
  const refill = ((now - b.last) / per) * rate;
  b.tokens = Math.min(rate, b.tokens + refill);
  b.last = now;
  if (b.tokens >= 1) { b.tokens -= 1; return 0; }
  return Math.ceil(((1 - b.tokens) * per / rate));
}

const LIMITS = {
  action: { rate: 8, per: 10000 },
  search: { rate: 1, per: 2000 },
  download: { rate: 6, per: 60000 },
  recognize: { rate: 4, per: 60000 },
  group: { rate: 20, per: 60000 },
  ticket: { rate: 3, per: 3600000 },
};

const strikes = new Map(); // userId -> {count, until}
const PENALTIES = [60000, 600000, 3600000, 86400000];

function isExempt(userId) {
  if (userId === config.ownerId) return true;
  const wl = getStore().get('settings', 'whitelist') || [];
  return wl.includes(userId);
}

function isBanned(userId) {
  const b = getStore().get('bans', String(userId));
  return !!b;
}

// returns ms remaining if blocked (0 => allowed)
function check(userId, kind) {
  if (isExempt(userId)) return 0;
  if (isBanned(userId)) return -1;
  const s = strikes.get(userId);
  if (s && s.until > Date.now()) return Math.ceil(s.until - Date.now());
  const lim = LIMITS[kind] || LIMITS.action;
  const wait = take(`${userId}:${kind}`, lim.rate, lim.per);
  if (wait > 0) {
    // escalate strike
    const st = strikes.get(userId) || { count: 0, until: 0 };
    st.count++;
    st.until = Date.now() + PENALTIES[Math.min(st.count - 1, PENALTIES.length - 1)];
    strikes.set(userId, st);
    return Math.ceil(st.until - Date.now());
  }
  return 0;
}

function groupLimit(chatId) {
  const lim = LIMITS.group;
  return take(`g:${chatId}`, lim.rate, lim.per) > 0;
}

function remainingPenalty(userId) {
  const s = strikes.get(userId);
  return s && s.until > Date.now() ? Math.ceil(s.until - Date.now()) : 0;
}

function fmtWait(ms, lang, t) {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return t(lang, 'wait_seconds', { n: s });
  if (s < 3600) return t(lang, 'wait_minutes', { n: Math.ceil(s / 60) });
  return t(lang, 'wait_hours', { n: Math.ceil(s / 3600) });
}

module.exports = { check, groupLimit, isBanned, isExempt, remainingPenalty, fmtWait, take };
