// Shazam (Shzm) adapter. Wraps the owner's shazam-worker `/api/v1/*` API.
//
// Discovered live endpoints:
//   GET  /api/v1/health         -> {ok,data:{status}}
//   POST /api/v1/search         {query,limit,lyrics} -> {data:{found,results,track?…}}
//   GET  /api/v1/lyrics?artist=&title=  -> {data:{found,lyrics:{text}}}
//   POST /api/v1/recognize      multipart file=.wav | json {signature}|{pcm_base64}
//                               -> {data:{found,track:{title,artist,album,
//                                   release_date,genre,artwork,links},lyrics,confidence}}
//   POST /api/v1/recognize/url  {url} -> needs BACKEND_URL (ffmpeg); optional.
//
// Audio format caveat (documented): the worker only fingerprints WAV/PCM or a
// pre-computed Shazam signature. Telegram voice is OGG-Opus; without an ffmpeg
// backend we cannot decode it in a Worker. We therefore:
//   * accept WAV upload directly,
//   * accept raw s16le PCM via `pcm_base64`,
//   * fall back to recognize/url when SHAZAM_BACKEND_URL is configured,
//   * otherwise degrade gracefully (caller shows "send clearer clip").

import { http, httpJson, HttpError } from "../utils/http.js";
import { trackKey, toYear } from "./track.js";
import { bytesToB64 } from "../utils/audioparse.js";

export class Shazam {
  constructor(env) {
    this.base = (env.SHAZAM_API_URL || "").replace(/\/$/, "");
    this.timeout = +(env.API_TIMEOUT_MS || 10000);
    this.backendUrl = env.SHAZAM_BACKEND_URL || "";
    this.backendKey = env.SHAZAM_BACKEND_KEY || "";
  }

  /** Text search (title/artist/lyrics). -> {found, results:[{artist,title}], track?, artwork, lyrics} */
  async search(query, limit = 8) {
    const data = await httpJson(`${this.base}/api/v1/search`, {
      method: "POST",
      timeout: this.timeout,
      headers: { "content-type": "application/json" },
       body: JSON.stringify({ query, limit, lyrics: true }),
    });
    return data.data || data;
  }

  /** Lyrics for artist+title. -> {found, lyrics:{text, synced}} */
  async lyrics(artist, title) {
    const url = `${this.base}/api/v1/lyrics?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`;
    const data = await httpJson(url, { timeout: this.timeout });
    return data.data || data;
  }

  _normTrack(t, extra = {}) {
    if (!t || !t.title) return null;
    return {
      id: t.shazam_id || t.apple_id || `${t.artist}-${t.title}`,
      key: trackKey("shz", t.shazam_id || `${t.artist}::${t.title}`),
      source: "shz",
      title: t.title,
      artist: t.artist || "",
      album: t.album || "",
      year: toYear(t.release_date),
      date: t.release_date || "",
      genre: t.genre || "",
      artwork: t.artwork_hq || t.artwork || null,
      previewUrl: t.preview_url || null,
      links: t.links || {},
      duration_ms: t.duration_ms || 0,
      confidence: extra.confidence ?? null,
      lyrics: extra.lyrics || null,
    };
  }

  /**
   * Recognize from raw audio bytes.
   * `bytes` = Uint8Array; `kind` = "wav" | "pcm" | "ogg" | other.
   * Returns normalized Track or null.
   */
  async recognize(bytes, kind = "wav", filename = "audio.wav") {    let result;
    if (kind === "pcm") {
      // Send raw s16le 16kHz mono as base64 JSON.
      const b64 = bytesToB64(bytes);
      const data = await httpJson(`${this.base}/api/v1/recognize`, {
        method: "POST",
        timeout: this.timeout,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pcm_base64: b64, lyrics: true }),
      });
      result = data.data || data;
    } else if (kind === "wav") {
      const fd = new FormData();
      fd.append("lyrics", "true");
      fd.append("file", new Blob([bytes], { type: "audio/wav" }), filename);
      const res = await http(`${this.base}/api/v1/recognize`, {
        method: "POST",
        timeout: this.timeout,
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok && !data.data) return null;
      result = data.data || data;
    } else {
      // Unsupported container without backend.
      return null;
    }
    if (!result || !result.found || !result.track) return null;
    return this._normTrack(result.track, { confidence: result.confidence, lyrics: result.lyrics });
  }

  /** Recognize from 16 kHz mono Int16 samples (from the in-worker decoder). */
  async recognizePcm(samples, lyrics = true) {
    const b64 = bytesToB64(new Uint8Array(samples.buffer, 0, samples.length * 2));
    const data = await httpJson(`${this.base}/api/v1/recognize`, {
      method: "POST",
      timeout: Math.max(this.timeout, 30000),
      retries: 1,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pcm_base64: b64, lyrics }),
    });
    const result = data.data || data;
    if (!result || !result.found || !result.track) return null;
    return this._normTrack(result.track, { confidence: result.confidence, lyrics: result.lyrics });
  }

  /** Recognize from a remote URL — only works when BACKEND_URL is configured. */
  async recognizeUrl(url) {
    if (!this.backendUrl) return null;
    const data = await httpJson(`${this.base}/api/v1/recognize/url`, {
      method: "POST",
      timeout: 45000,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const d = data.data || data;
    if (!d || !d.found || !d.track) return null;
    return this._normTrack(d.track, { confidence: d.confidence, lyrics: d.lyrics });
  }

  async ping() {
    const t = Date.now();
    try {
      await httpJson(`${this.base}/api/v1/health`, { timeout: 5000, retries: 0 });
      return Date.now() - t;
    } catch { return -1; }
  }
}
