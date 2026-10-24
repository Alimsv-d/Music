// Lyrics adapter — LRCLIB (free, no key). Used as fallback when the Shazam
// service has no lyrics for a track.
//
//   GET /api/get?artist_name=&track_name=&album_name=&duration=  -> {plainLyrics,syncedLyrics}
//   GET /api/search?track_name=&artist_name=&q=                  -> [{...}]

import { httpJson, cachedJson } from "../utils/http.js";

export class Lyrics {
  constructor(env) {
    this.base = (env.LRCLIB_API_URL || "https://lrclib.net").replace(/\/$/, "");
    this.timeout = +(env.API_TIMEOUT_MS || 10000);
    this.trackTtl = +(env.TRACK_CACHE_TTL || 3600);
  }

  /** Exact-ish fetch. -> plain lyrics string or null. */
  async get(artist, trackName, album = "", duration = 0) {
    const p = new URLSearchParams();
    if (artist) p.set("artist_name", artist);
    p.set("track_name", trackName);
    if (album) p.set("album_name", album);
    if (duration) p.set("duration", String(Math.round(duration)));
    try {
      const data = await cachedJson(`${this.base}/api/get?${p}`, { ttlSec: this.trackTtl, timeout: this.timeout });
      return this._pick(data);
    } catch {
      return null;
    }
  }

  /** Fuzzy search. -> array of {artist,title,album,lyrics} best-first. */
  async search(trackName, artist = "", q = "") {
    const p = new URLSearchParams();
    if (trackName) p.set("track_name", trackName);
    if (artist) p.set("artist_name", artist);
    if (q) p.set("q", q);
    try {
      const data = await cachedJson(`${this.base}/api/search?${p}`, { ttlSec: this.trackTtl, timeout: this.timeout });
      return (Array.isArray(data) ? data : []).map((r) => ({
        artist: r.artistName || "",
        title: r.trackName || r.name || "",
        album: r.albumName || "",
        duration: r.duration || 0,
        instrumental: !!r.instrumental,
        lyrics: this._pick(r),
      }));
    } catch {
      return [];
    }
  }

  _pick(r) {
    if (!r) return null;
    return r.plainLyrics || r.syncedLyrics || null;
  }

  async ping() {
    const t = Date.now();
    try {
      await httpJson(`${this.base}/api/search?track_name=test`, { timeout: 5000, retries: 0 });
      return Date.now() - t;
    } catch { return -1; }
  }
}
