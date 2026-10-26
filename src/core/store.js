'use strict';
// Storage abstraction. Node >= 22.5 uses node:sqlite; falls back to a JSON
// document store with atomic writes + debounce (so it also runs anywhere).
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const TABLES = ['users', 'chats', 'settings', 'channels', 'posted_tracks', 'queue', 'stats', 'bans', 'file_id_cache', 'tickets', 'favorites', 'history', 'negcache', 'follows', 'referral'];

let driver;
try {
  // node:sqlite is present on Node >= 22.5
  driver = require('node:sqlite');
} catch (_) {
  driver = null;
}

class Store {
  constructor() {
    this.db = null;
    this.json = null;
    this.jsonPath = path.join(config.dataDir, 'store.json');
    this._saveTimer = null;
    if (driver && driver.DatabaseSync) {
      try {
        fs.mkdirSync(config.dataDir, { recursive: true });
        this.db = new driver.DatabaseSync(path.join(config.dataDir, 'store.db'));
        this._initSqlite();
      } catch (_) { this.db = null; }
    }
    if (!this.db) this._initJson();
    this._migrateCaches();
  }

  _migrateCaches() {
    const current = this.get('settings', 'file_cache_version');
    const wanted = 'audio-v5-inmem';
    if (current === wanted) return;
    // Invalidate every old file_id: old pipeline could cache a short/invalid file.
    for (const k of this.keys('file_id_cache')) this.del('file_id_cache', k);
    this.set('settings', 'file_cache_version', wanted);
  }

  _initSqlite() {
    this.db.exec('PRAGMA journal_mode=WAL;');
    for (const t of TABLES) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${t} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    }
  }

  _initJson() {
    try {
      this.json = JSON.parse(fs.readFileSync(this.jsonPath, 'utf8'));
    } catch (_) { this.json = {}; }
    for (const t of TABLES) if (!this.json[t]) this.json[t] = {};
  }

  _scheduleJsonSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._flushJson();
    }, 800);
    this._saveTimer.unref && this._saveTimer.unref();
  }
  _flushJson() {
    try {
      const tmp = this.jsonPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.json));
      fs.renameSync(tmp, this.jsonPath);
    } catch (_) {}
  }

  get(table, key) {
    if (this.db) {
      const row = this.db.prepare(`SELECT v FROM ${table} WHERE k=?`).get(String(key));
      return row ? JSON.parse(row.v) : undefined;
    }
    const v = this.json[table][key];
    return v === undefined ? undefined : v;
  }

  set(table, key, value) {
    if (this.db) {
      this.db.prepare(`INSERT INTO ${table}(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(String(key), JSON.stringify(value));
      return;
    }
    this.json[table][key] = value;
    this._scheduleJsonSave();
  }

  del(table, key) {
    if (this.db) { this.db.prepare(`DELETE FROM ${table} WHERE k=?`).run(String(key)); return; }
    delete this.json[table][key];
    this._scheduleJsonSave();
  }

  has(table, key) { return this.get(table, key) !== undefined; }

  keys(table) {
    if (this.db) return this.db.prepare(`SELECT k FROM ${table}`).all().map((r) => r.k);
    return Object.keys(this.json[table]);
  }

  all(table) {
    if (this.db) return this.db.prepare(`SELECT k,v FROM ${table}`).all().map((r) => [r.k, JSON.parse(r.v)]);
    return Object.entries(this.json[table]);
  }

  count(table) {
    if (this.db) return this.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
    return Object.keys(this.json[table]).length;
  }

  incrStats(field, n = 1) {
    const day = new Date().toISOString().slice(0, 10);
    const cur = this.get('stats', 'counters') || {};
    cur[field] = (cur[field] || 0) + n;
    cur['day:' + day + ':' + field] = (cur['day:' + day + ':' + field] || 0) + n;
    this.set('stats', 'counters', cur);
  }
  getStats() { return this.get('stats', 'counters') || {}; }

  close() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._flushJson(); }
    if (this.db) { try { this.db.close(); } catch (_) {} }
  }
}

let instance = null;
function getStore() {
  if (!instance) instance = new Store();
  return instance;
}
module.exports = { getStore, Store };
