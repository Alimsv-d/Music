// Instagram adapter. Prefers the owner's insta-worker `/api/v1/resolve` +
// `/api/v1/download`, falls back to the legacy catplus-style API.
//
// insta-worker resolve -> {ok,data:{type,author:{username,full_name,avatar},
//   caption,thumbnail,items:[{type,index,thumbnail,
//     variants:[{url,quality,width,height,bitrate,size,mime,filename,has_audio}]}],
//   source_url,shortcode,provider}}
// download: GET /api/v1/download?url=&index=&quality=best -> binary stream
// legacy catplus -> {video:[{video,thumbnail}],image:[url]}

import { httpJson, HttpError } from "../utils/http.js";

export class Insta {
  constructor(env) {
    this.base = (env.INSTA_API_URL || "").replace(/\/$/, "");
    this.legacy = (env.LEGACY_INSTA_API_URL || "").replace(/\/$/, "");
    this.apiKey = env.INSTA_API_KEY || "";
    this.timeout = +(env.API_TIMEOUT_MS || 10000);
  }

  _headers() {
    const h = {};
    if (this.apiKey) h["authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  /**
   * Resolve an instagram URL to normalized media.
   * -> {caption, author, thumbnail, shortcode, provider,
   *     items:[{type:"video"|"image", index, thumbnail,
   *             url, width,height,size,mime,has_audio}]}
   * url in each item is a direct CDN link; for insta-worker we expose a
   * proxy download URL via `downloadUrl(shortcode,index)`.
   */
  async resolve(url) {
    // Try insta-worker first.
    if (this.base) {
      try {
        const data = await httpJson(
          `${this.base}/api/v1/resolve?url=${encodeURIComponent(url)}`,
          { timeout: this.timeout, headers: this._headers() }
        );
        if (data.ok && data.data && data.data.items && data.data.items.length) {
          return this._normWorker(data.data, url);
        }
      } catch (e) {
        // fall through to legacy
      }
    }
    // Legacy catplus.
    if (this.legacy) {
      const data = await httpJson(`${this.legacy}?url=${encodeURIComponent(url)}`, { timeout: this.timeout });
      return this._normLegacy(data, url);
    }
    throw new HttpError("no insta provider", { code: "UPSTREAM" });
  }

  _normWorker(d, url) {
    const shortcode = d.shortcode || "";
    const items = (d.items || []).map((it, i) => {
      const best = (it.variants || [])[0] || {};
      return {
        type: it.type === "video" ? "video" : "image",
        index: i,
        thumbnail: it.thumbnail || d.thumbnail || null,
        url: best.url || null,
        width: best.width, height: best.height,
        size: best.size, mime: best.mime,
        has_audio: best.has_audio !== false,
        // Proxy through insta-worker to avoid exposing expiring CDN urls to TG.
        proxyUrl: this.downloadUrl(url, i),
      };
    });
    return {
      caption: d.caption || "",
      author: d.author || {},
      thumbnail: d.thumbnail || null,
      shortcode,
      provider: d.provider || "insta-worker",
      items,
      raw: d,
    };
  }

  _normLegacy(d, url) {
    const items = [];
    if (Array.isArray(d.video) && d.video.length) {
      d.video.forEach((v, i) => {
        if (v && v.video) items.push({
          type: "video", index: i, url: v.video,
          thumbnail: v.thumbnail || null, has_audio: true,
        });
      });
    }
    if (Array.isArray(d.image) && d.image.length) {
      d.image.forEach((img, i) => {
        if (img) items.push({ type: "image", index: items.length + i, url: img, thumbnail: img });
      });
    }
    if (!items.length) throw new HttpError("no media", { code: "NOT_FOUND" });
    return { caption: d.caption || "", author: {}, thumbnail: items[0].thumbnail, items, provider: "legacy", raw: d };
  }

  /** Proxy download URL for a resolved item via insta-worker. */
  downloadUrl(instaUrl, index = 0, quality = "best") {
    if (!this.base) return null;
    return `${this.base}/api/v1/download?url=${encodeURIComponent(instaUrl)}&index=${index}&quality=${quality}&inline=1`;
  }

  /** Direct CDN url of the best variant of item i (for media group). */
  bestUrl(resolved, index = 0) {
    return resolved?.items?.[index]?.url || resolved?.items?.[index]?.proxyUrl || null;
  }

  async ping() {
    const t = Date.now();
    try {
      await httpJson(`${this.base}/health`, { timeout: 5000, retries: 0 });
      return Date.now() - t;
    } catch { return -1; }
  }
}
