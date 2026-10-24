// SoundCloud adapter. Wraps the owner's soundcloud-worker `/api/v1/*` API and
// normalizes results into the internal Track shape.
//
// Discovered live endpoints:
//   GET /api/v1/search?q=…&page=N  -> {ok,results:[{id:"sc_..",sid,title,artist,
//         duration_ms,cover,page_url,created_at,hasProgressive,hasHls,hasMp3,downloadable}]}
//   GET /api/v1/track?id=SID       -> {ok,track:{…,transcodings}}
//   GET /api/v1/resolve?url=…      -> {ok,track:{…}}
//   GET /api/v1/download?id=SID    -> binary audio (m4a/mp3) stream
//   GET /api/v1/download?id=SID&check=1 -> {mode,ext,segments,size,hls}
//   GET /api/v1/cover?url=…        -> proxied image

import { httpJson, cachedJson, HttpError } from "../utils/http.js";
import { trackKey, toYear } from "./track.js";

export class SoundCloud {
  constructor(env) {
    this.base = (env.SOUNDCLOUD_API_URL || "").replace(/\/$/, "");
    this.timeout = +(env.API_TIMEOUT_MS || 10000);
    this.searchTtl = +(env.SEARCH_CACHE_TTL || 300);
    this.trackTtl = +(env.TRACK_CACHE_TTL || 3600);
  }

  _norm(t) {
    if (!t) return null;
    const sid = String(t.sid || String(t.id || "").replace(/^sc_/, ""));
    return {
      id: sid,
      key: trackKey("sc", sid),
      source: "sc",
      title: t.title || "",
      artist: t.artist || "",
      artistId: t.user_id || null,
      album: t.album || "",
      year: toYear(t.created_at || t.release),
      date: t.created_at || "",
      duration_ms: t.duration_ms || 0,
      artwork: (t.cover || "").replace("-t500x500", "-t500x500") || null,
      pageUrl: t.page_url || "",
      genre: t.genre || "",
      plays: t.plays || 0,
      downloadable: !!t.downloadable,
      streamable: !!t.streamable,
      // The worker's own download/stream endpoints.
      downloadUrl: `${this.base}/api/v1/download?id=${sid}`,
      streamUrl: `${this.base}/api/v1/stream?id=${sid}`,
    };
  }

  /** Search tracks. Returns Track[]. Throws on upstream failure. */
  async search(query, page = 1, limit = 24) {
    const url = `${this.base}/api/v1/search?q=${encodeURIComponent(query)}&page=${page}`;
    const data = await cachedJson(url, { ttlSec: this.searchTtl, timeout: this.timeout });
    if (!data.ok) throw new HttpError("sc search failed", { code: "UPSTREAM", url });
    return (data.results || []).map((t) => this._norm(t)).filter(Boolean);
  }

  /** Full track info by numeric SID. Returns Track or null. */
  async track(sid) {
    const url = `${this.base}/api/v1/track?id=${encodeURIComponent(sid)}`;
    const data = await cachedJson(url, { ttlSec: this.trackTtl, timeout: this.timeout });
    if (!data.ok) return null;
    return this._norm(data.track);
  }

  /** Resolve a soundcloud.com page URL to a Track. */
  async resolve(pageUrl) {
    const url = `${this.base}/api/v1/resolve?url=${encodeURIComponent(pageUrl)}`;
    const data = await httpJson(url, { timeout: this.timeout });
    if (!data.ok || !data.track) return null;
    return this._norm(data.track);
  }

  /**
   * Check download feasibility/size without fetching bytes.
   * -> {mode:"direct"|"browser",ext,size,segments,hls}
   */
  async downloadInfo(sid) {
    const url = `${this.base}/api/v1/download?id=${encodeURIComponent(sid)}&check=1`;
    return httpJson(url, { timeout: this.timeout });
  }

  /** Proxied cover image URL (keeps artwork fetch on the worker's allowlist). */
  coverUrl(imageUrl) {
    return `${this.base}/api/v1/cover?url=${encodeURIComponent(imageUrl)}`;
  }

  /** Health ping. Returns latency ms or -1. */
  async ping() {
    const t = Date.now();
    try {
      await httpJson(`${this.base}/health`, { timeout: 5000, retries: 0 });
      return Date.now() - t;
    } catch {
      return -1;
    }
  }
}
