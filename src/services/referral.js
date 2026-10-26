'use strict';
// Referral system: per-user invite codes/links, verification rules, anti-fraud
// guards, points ledger, tiers, and owner controls. All state lives in the
// generic `referral` kv table + per-user fields on `users`.
const crypto = require('node:crypto');
const { getStore } = require('../core/store');
const config = require('../config');

const store = getStore();

const TIERS = [
  { n: 100, name: 'الماس', mult: 3 },
  { n: 40, name: 'طلایی', mult: 2 },
  { n: 15, name: 'نقره‌ای', mult: 1.5 },
  { n: 5, name: 'برنزی', mult: 1.2 },
];

function codeFor(uid) {
  const u = store.get('users', String(uid)) || {};
  if (u.ref_code) return u.ref_code;
  const code = crypto.createHash('sha256').update(`ref:${uid}:${config.botToken.slice(-8)}`).digest('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  u.ref_code = code;
  store.set('users', String(uid), u);
  return code;
}
function linkFor(uid, botUsername) { return `https://t.me/${botUsername}?start=ref_${codeFor(uid)}`; }

function uidByCode(code) {
  for (const [k, u] of store.all('users')) if (u.ref_code === code) return k;
  return null;
}

function enabled() { const s = store.get('settings', 'ref') || {}; return s.enabled !== false; }
function cfg() { return { enabled: true, rateCap: 15, groupMinMembers: 20, groupMinRequests: 5, ...(store.get('settings', 'ref') || {}) }; }

function record(uid, inviter, status, reason) {
  const ev = { invitee: String(uid), inviter: String(inviter), status, reason: reason || '', ts: Date.now() };
  const id = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  store.set('referral', id, ev);
  return id;
}

function statsFor(uid) {
  const all = store.all('referral').map(([, v]) => v);
  const mine = all.filter((e) => e.inviter === String(uid));
  const inv = mine.filter((e) => e.status === 'verified').length;
  return { invited: mine.length, verified: inv, held: mine.filter((e) => e.status === 'held').length, points: inv, tier: tierFor(inv) };
}
function tierFor(verified) {
  for (const t of TIERS) if (verified >= t.n) return t;
  return { n: 0, name: '', mult: 1 };
}
function top(limit = 10) {
  const count = new Map();
  for (const [, e] of store.all('referral')) if (e.status === 'verified') count.set(e.inviter, (count.get(e.inviter) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([uid, n]) => {
    const u = store.get('users', uid) || {};
    const name = (u.name || 'کاربر').replace(/(.{2}).+/, '$1***');
    return { uid, n, name };
  });
}

// Anti-fraud: self-invite, duplicate (already has inviter or used bot before),
// rate cap (held for owner review).
function evaluate(uid, code) {
  if (!enabled()) return null;
  const inviter = uidByCode(code);
  if (!inviter) return { status: 'rejected', reason: 'bad_code' };
  if (inviter === String(uid)) return { status: 'rejected', reason: 'self' };
  const u = store.get('users', String(uid)) || {};
  if (u.referred_by) return { status: 'rejected', reason: 'already_referred' };
  if (u.first && Date.now() - u.first > 10 * 60 * 1000) return { status: 'rejected', reason: 'not_new' };
  // rate cap: recent verified invites by this inviter
  const recent = store.all('referral').map(([, v]) => v).filter((e) => e.inviter === inviter && e.status === 'verified' && Date.now() - e.ts < 3600000).length;
  const status = recent >= cfg().rateCap ? 'held' : 'pending';
  u.referred_by = inviter;
  u.ref_status = status;
  store.set('users', String(uid), u);
  record(uid, inviter, status, status === 'held' ? 'rate_cap' : '');
  return { status, inviter };
}

// Called after the invitee's first successful use (search/download/recog) while
// pending: require force-join pass + first-use within 7 days -> verified.
function maybeVerify(uid, notify) {
  const u = store.get('users', String(uid)) || {};
  if (u.ref_status !== 'pending' || !u.referred_by) return;
  if (Date.now() - u.first > 7 * 86400000) { u.ref_status = 'rejected'; store.set('users', String(uid), u); return; }
  u.ref_status = 'verified';
  store.set('users', String(uid), u);
  record(uid, u.referred_by, 'verified');
  if (notify) {
    const key = 'refn:' + u.referred_by;
    const last = store.get('settings', key) || 0;
    if (Date.now() - last > 3600000) {
      store.set('settings', key, Date.now());
      const s = statsFor(u.referred_by);
      notify(u.referred_by, s).catch(() => {});
    }
  }
}

function revoke(eventId) {
  const ev = store.get('referral', eventId);
  if (ev) { ev.status = 'rejected'; ev.reason = 'revoked'; store.set('referral', eventId, ev); }
}

module.exports = { codeFor, linkFor, evaluate, maybeVerify, statsFor, top, enabled, cfg, revoke, uidByCode, TIERS };
