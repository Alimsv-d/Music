'use strict';
// In-memory LRU caches + negative cache + request coalescing.
<<<<<<< HEAD
=======
// Central policy lives here so every service benefits from the same budget-aware
// behavior: longer TTLs for immutable data, negative caching to avoid upstream
// 404s, and coalescing so concurrent users share one outbound request.
>>>>>>> main
class LRU {
  constructor(max = 500, ttl = 600000) {
    this.max = max; this.ttl = ttl; this.map = new Map();
  }
  get(k) {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (Date.now() > e.exp) { this.map.delete(k); return undefined; }
    this.map.delete(k); this.map.set(k, e); // refresh recency
    return e.v;
  }
  set(k, v, ttl) {
    this.map.delete(k);
    this.map.set(k, { v, exp: Date.now() + (ttl || this.ttl) });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  has(k) { return this.get(k) !== undefined; }
  del(k) { this.map.delete(k); }
<<<<<<< HEAD
  get size() { return this.map.size; }
}

const searchCache = new LRU(300, 10 * 60 * 1000);   // 10 min
const trackCache = new LRU(500, 60 * 60 * 1000);    // 1 hour
const negCache = new LRU(500, 5 * 60 * 1000);        // negative results
=======
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

// Cache budgets: generous TTLs are safe because the worker APIs are read-only
// for the bot's purposes.  Raising them is the cheapest way to save quota.
const SEARCH_TTL = 30 * 60 * 1000;      // 30 min — searches are the hottest key
const TRACK_TTL  = 24 * 60 * 60 * 1000; // 24 h   — track metadata rarely changes
const NEG_TTL    = 15 * 60 * 1000;      // 15 min — remember 'no results' too
const RECOG_TTL  = 60 * 60 * 1000;      // 1 h    — same clip = same song

const searchCache  = new LRU(400,  SEARCH_TTL);
const trackCache   = new LRU(1000, TRACK_TTL);
const negCache     = new LRU(600,  NEG_TTL);
const recogCache   = new LRU(300,  RECOG_TTL);
const fileIdCache  = new LRU(2000, TRACK_TTL);
>>>>>>> main

const inflight = new Map(); // key -> Promise
function coalesce(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => { try { return await fn(); } finally { inflight.delete(key); } })();
  inflight.set(key, p);
  return p;
}

<<<<<<< HEAD
module.exports = { LRU, searchCache, trackCache, negCache, coalesce };
=======
// Cheap daily quota guard.  Counts outbound calls per worker host; when the
// free-tier budget is exhausted we return synthetic 429s instead of wasting
// real requests.  Owners can still force through via owner-exempt checks.
const quota = new Map(); // host -> {day, n}
const DAILY_BUDGET = Number(process.env.API_DAILY_BUDGET || 8000); // safe margin under 10k

function quotaKey(host) { return `${host}:${new Date().toISOString().slice(0, 10)}`; }
function quotaExceeded(host) {
  const k = quotaKey(host);
  const q = quota.get(k) || { n: 0 };
  return q.n >= DAILY_BUDGET;
}
function quotaUse(host) {
  const k = quotaKey(host);
  const q = quota.get(k) || { n: 0 };
  q.n++;
  quota.set(k, q);
  // evict old days
  for (const key of quota.keys()) if (key !== k && key.split(':')[1] !== k.split(':')[1]) quota.delete(key);
  return q.n;
}
function quotaStats() {
  const out = {};
  for (const [k, v] of quota) out[k] = v.n;
  return out;
}

module.exports = { LRU, searchCache, trackCache, negCache, recogCache, fileIdCache, coalesce, quotaExceeded, quotaUse, quotaStats };
>>>>>>> main
