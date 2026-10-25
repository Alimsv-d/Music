'use strict';
// Instagram service client.
const config = require('../config');
const { getJson, downloadTo } = require('../core/http');

const base = () => config.instaApi;

class ServiceError extends Error {
  constructor(code, message, status) { super(message || code); this.code = code; this.status = status || 0; }
}

const INSTA_RE = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(p|reel|reels|tv|stories)\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_-]+))?/i;
function isInstaUrl(s) { return INSTA_RE.test(s || ''); }
// Strip tracker params (?igsh, ?dlrf, ?utm_*) — they break upstream resolution.
function cleanUrl(s) {
  const m = String(s || '').match(INSTA_RE);
  if (!m) return s;
  const path = m[0].replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  return 'https://www.instagram.com/' + path.replace(/\/+$/, '') + '/';
}

async function resolve(url) {
  const d = await getJson(base() + '/api/v1/resolve?' + new URLSearchParams({ url }), { timeout: 20000, retries: 2 });
  if (!d.ok) throw new ServiceError(d.error && d.error.code || 'RESOLVE_FAIL', d.error && d.error.message || 'resolve failed', d.status);
  return d.data;
}

// download params: url = the POST url (not media cdn url), quality, index
function downloadUrlFor(postUrl, { quality, index } = {}) {
  const p = { url: postUrl };
  if (quality) p.quality = quality;
  if (index != null) p.index = index;
  return base() + '/api/v1/download?' + new URLSearchParams(p);
}
function thumbUrl(mediaUrl) {
  return base() + '/api/v1/thumbnail?' + new URLSearchParams({ url: mediaUrl });
}
async function downloadFile(postUrl, sel, filePath, maxBytes = 80 * 1024 * 1024) {
  await downloadTo(downloadUrlFor(postUrl, sel), filePath, { timeout: 120000, maxBytes });
}
async function health() {
  const t0 = Date.now();
  try { const d = await getJson(base() + '/health', { timeout: 8000, retries: 1 }); return { ok: !!d.ok, ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: e.code || e.message }; }
}
module.exports = { isInstaUrl, cleanUrl, resolve, downloadUrlFor, thumbUrl, downloadFile, health, ServiceError, INSTA_RE };
