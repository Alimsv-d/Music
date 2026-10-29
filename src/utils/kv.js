// KV data access layer. One key per entity with prefixes (see README §data
// model). All access is isolated here so it can later be swapped for D1 /
// Durable Objects without touching handler code.
//
// NOTE on counters: KV is not atomic. We keep approximate counters under
// stat:<yyyymmdd>:<metric> and accept small races — documented in README.

const J = {
  get: async (kv, k) => {
    try { return await kv.get(k, "json"); } catch { return null; }
  },
  put: (kv, k, v, ttl) =>
    kv.put(k, JSON.stringify(v), ttl ? { expirationTtl: ttl } : {}).catch(() => {}),
};

export class Store {
  constructor(kv) { this.kv = kv; }

  // ── users ────────────────────────────────────────────────────────────────
  async getUser(id) {
    return (await J.get(this.kv, `u:${id}`)) || null;
  }
  async upsertUser(id, patch) {
    const cur = (await this.getUser(id)) || {};
    const next = { ...cur, ...patch, id: String(id), lastSeen: Date.now() };
    await J.put(this.kv, `u:${id}`, next);
    return next;
  }
  async setUserInactive(id) {
    const u = await this.getUser(id);
    if (u) { u.inactive = true; await J.put(this.kv, `u:${id}`, u); }
  }
  async listUsers() {
    return this._collect("u:");
  }
  async countUsers() {
    return this._count("u:");
  }

  // ── chats (groups) ───────────────────────────────────────────────────────
  async getChat(id) { return J.get(this.kv, `chat:${id}`); }
  async upsertChat(id, patch) {
    const cur = (await this.getChat(id)) || {};
    const next = { ...cur, ...patch, id: String(id) };
    await J.put(this.kv, `chat:${id}`, next);
    return next;
  }
  async listChats() { return this._collect("chat:"); }

  // ── admins ───────────────────────────────────────────────────────────────
  async getAdmins() {
    return this._collect("admin:", (v) => v.id);
  }
  async addAdmin(id, meta = {}) {
    await J.put(this.kv, `admin:${id}`, { id: String(id), addedAt: Date.now(), ...meta });
  }
  async removeAdmin(id) { await this.kv.delete(`admin:${id}`).catch(() => {}); }
  async isAdmin(id) { return !!(await J.get(this.kv, `admin:${id}`)); }

  // ── forced-join channels ─────────────────────────────────────────────────
  async getChannels() {
    return this._collect("ch:");
  }
  async getChannel(id) { return J.get(this.kv, `ch:${id}`); }
  async putChannel(id, data) {
    await J.put(this.kv, `ch:${id}`, { id: String(id), enabled: true, addedAt: Date.now(), ...data });
  }
  async removeChannel(id) { await this.kv.delete(`ch:${id}`).catch(() => {}); }

  // ── config (live settings) ───────────────────────────────────────────────
  async getCfg(name, fallback = null) {
    const v = await J.get(this.kv, `cfg:${name}`);
    return v === null || v === undefined ? fallback : v;
  }
  async setCfg(name, value) { await J.put(this.kv, `cfg:${name}`, value); }

  // ── search-result handles (callback pagination) ─────────────────────────
  async putSearch(shortId, data, ttl = 3600) {
    await J.put(this.kv, `srch:${shortId}`, data, ttl);
  }
  async getSearch(shortId) { return J.get(this.kv, `srch:${shortId}`); }

  // ── track file_id cache ──────────────────────────────────────────────────
  async getTrackFileId(key) {
    const v = await J.get(this.kv, `track:${key}`);
    return v?.file_id || null;
  }
  async putTrack(key, data) {
    await J.put(this.kv, `track:${key}`, { ...data, cachedAt: Date.now() });
  }
  async getTrack(key) { return J.get(this.kv, `track:${key}`); }

  // ── favorites ────────────────────────────────────────────────────────────
  async getFavs(userId) {
    return (await J.get(this.kv, `fav:${userId}`)) || [];
  }
  async addFav(userId, track) {
    const favs = await this.getFavs(userId);
    if (favs.some((f) => f.key === track.key)) return favs;
    favs.unshift({ ...track, addedAt: Date.now() });
    const trimmed = favs.slice(0, 200);
    await J.put(this.kv, `fav:${userId}`, trimmed);
    return trimmed;
  }
  async removeFav(userId, key) {
    const favs = (await this.getFavs(userId)).filter((f) => f.key !== key);
    await J.put(this.kv, `fav:${userId}`, favs);
    return favs;
  }

  // ── search history ───────────────────────────────────────────────────────
  async pushHistory(userId, query) {
    const hist = (await J.get(this.kv, `hist:${userId}`)) || [];
    const filtered = hist.filter((h) => h !== query);
    filtered.unshift(query);
    await J.put(this.kv, `hist:${userId}`, filtered.slice(0, 10));
  }
  async getHistory(userId) {
    return (await J.get(this.kv, `hist:${userId}`)) || [];
  }

  // ── stats counters (approximate) ─────────────────────────────────────────
  async bump(metric, n = 1) {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const key = `stat:${day}:${metric}`;
    const cur = (await J.get(this.kv, key)) || 0;
    await J.put(this.kv, key, cur + n, 60 * 60 * 24 * 40); // keep 40 days
    // lifetime counter
    const tk = `stat_total:${metric}`;
    const tv = (await J.get(this.kv, tk)) || 0;
    await J.put(this.kv, tk, tv + n);
  }
  async getStat(metric, dateStr) {
    const day = dateStr || new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return (await J.get(this.kv, `stat:${day}:${metric}`)) || 0;
  }
  async getStatTotal(metric) {
    return (await J.get(this.kv, `stat_total:${metric}`)) || 0;
  }

  // ── broadcast jobs ───────────────────────────────────────────────────────
  async putJob(id, job) { await J.put(this.kv, `job:${id}`, job); }
  async getJob(id) { return J.get(this.kv, `job:${id}`); }
  async deleteJob(id) { await this.kv.delete(`job:${id}`).catch(() => {}); }
  async listJobs() { return this._collect("job:"); }

  // ── errors log (last 20) ─────────────────────────────────────────────────
  async logError(entry) {
    const list = (await J.get(this.kv, "err:log")) || [];
    list.unshift({ ...entry, at: Date.now() });
    await J.put(this.kv, "err:log", list.slice(0, 20));
  }
  async getErrors() { return (await J.get(this.kv, "err:log")) || []; }

  // ── update dedupe ────────────────────────────────────────────────────────
  async seenUpdate(updateId) {
    const key = `dup:${updateId}`;
    const seen = await this.kv.get(key);
    if (seen) return true;
    await this.kv.put(key, "1", { expirationTtl: 600 }).catch(() => {});
    return false;
  }

  // ── membership cache (forced-join) ───────────────────────────────────────
  async getMembership(userId, chId) { return J.get(this.kv, `mem:${userId}:${chId}`); }
  async putMembership(userId, chId, ok) {
    await J.put(this.kv, `mem:${userId}:${chId}`, { ok, at: Date.now() }, 60);
  }

  // ── rate limiting ────────────────────────────────────────────────────────
  // Simple fixed-window counter under rl:<uid>:<windowStart>. Short TTL.
  async rateLimit(userId, limitPerMin, heavy = false) {
    const win = Math.floor(Date.now() / 60000);
    const key = `rl:${heavy ? "h" : "n"}:${userId}:${win}`;
    const cur = parseInt((await this.kv.get(key)) || "0", 10);
    const next = cur + 1;
    await this.kv.put(key, String(next), { expirationTtl: 120 }).catch(() => {});
    return { allowed: next <= limitPerMin, count: next, retryAfter: 60 - Math.floor((Date.now() % 60000) / 1000) };
  }

  // ── generic key get/put ──────────────────────────────────────────────────
  async get(key) { return J.get(this.kv, key); }
  async put(key, val, ttl) { return J.put(this.kv, key, val, ttl); }
  async del(key) { return this.kv.delete(key).catch(() => {}); }

  /** List [{key, value}] for a prefix (bounded to 5000 entries). */
  async listWithPrefix(prefix) {
    const out = [];
    let cursor;
    do {
      const page = await this.kv.list({ prefix, cursor, limit: 1000 });
      for (const k of page.keys) {
        const v = await J.get(this.kv, k.name);
        if (v !== null) out.push({ key: k.name.slice(prefix.length), value: v });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
  }

  // ── internals ────────────────────────────────────────────────────────────
  async _collect(prefix, map) {
    const out = [];
    let cursor;
    do {
      const page = await this.kv.list({ prefix, cursor, limit: 1000 });
      for (const k of page.keys) {
        const v = await J.get(this.kv, k.name);
        if (v !== null) out.push(map ? map(v) : v);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
  }
  async _count(prefix) {
    let n = 0, cursor;
    do {
      const page = await this.kv.list({ prefix, cursor, limit: 1000 });
      n += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return n;
  }
}
