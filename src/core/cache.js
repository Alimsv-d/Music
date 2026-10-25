'use strict';
// In-memory LRU caches + negative cache + request coalescing.
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
  get size() { return this.map.size; }
}

const searchCache = new LRU(300, 10 * 60 * 1000);   // 10 min
const trackCache = new LRU(500, 60 * 60 * 1000);    // 1 hour
const negCache = new LRU(500, 5 * 60 * 1000);        // negative results

const inflight = new Map(); // key -> Promise
function coalesce(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => { try { return await fn(); } finally { inflight.delete(key); } })();
  inflight.set(key, p);
  return p;
}

module.exports = { LRU, searchCache, trackCache, negCache, coalesce };
