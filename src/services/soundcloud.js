'use strict';
// SoundCloud service client.
const config = require('../config');
const { getJson, request, downloadTo, HttpError } = require('../core/http');
const { searchCache, trackCache, negCache, coalesce } = require('../core/cache');
const { getStore } = require('../core/store');

const base = () => config.scApi;
const T = 8000; // search timeout

class ServiceError extends Error {
  constructor(code, message, status) { super(message || code); this.code = code; this.status = status || 0; }
}
function wrap(e) {
  if (e instanceof ServiceError) return e;
  const code = e.code || 'SERVICE_ERROR';
  return new ServiceError(code, e.message, e.status);
}
async function call(path, params, timeout) {
  try {
    const url = base() + path + (params ? '?' + new URLSearchParams(params) : '');
    return await getJson(url, { timeout: timeout || 12000, retries: 2 });
  } catch (e) { throw wrap(e); }
}

function sidOf(track) { return String(track.sid || (track.id || '').replace(/^sc_/, '')); }

async function search(q, page = 1, lang) {
  const key = `s:${q.toLowerCase()}:${page}`;
  const c = searchCache.get(key);
  if (c) return c;
  return coalesce(key, async () => {
    const d = await call('/api/v1/search', { q, page, ...(lang ? { lang } : {}) }, T);
    if (!d.ok) throw new ServiceError(d.error && d.error.code || 'SEARCH_FAIL', 'search failed');
    if (!d.results || !d.results.length) negCache.set(key, true);
    searchCache.set(key, d);
    return d;
  });
}

async function track(idOrSid) {
  const sid = String(idOrSid).replace(/^sc_/, '');
  const key = `t:${sid}`;
  const c = trackCache.get(key);
  if (c) return c;
  return coalesce(key, async () => {
    const d = await call('/api/v1/track', { id: sid });
    if (!d.ok) throw new ServiceError(d.error && d.error.code || 'TRACK_FAIL', 'track failed');
    trackCache.set(key, d.track);
    return d.track;
  });
}

async function resolveUrl(url) {
  const d = await call('/api/v1/resolve', { url });
  if (!d.ok) throw new ServiceError(d.error && d.error.code || 'RESOLVE_FAIL', 'resolve failed');
  if (d.track) trackCache.set('t:' + sidOf(d.track), d.track);
  return d.track;
}

async function checkDownload(idOrSid) {
  const sid = String(idOrSid).replace(/^sc_/, '');
  try {
    const d = await call('/api/v1/download', { id: sid, check: 1 });
    return d;
  } catch (e) { throw wrap(e); }
}

function streamUrl(idOrSid) {
  const sid = String(idOrSid).replace(/^sc_/, '');
  return `${base()}/api/v1/stream?id=${encodeURIComponent(sid)}`;
}
function downloadUrl(idOrSid) {
  const sid = String(idOrSid).replace(/^sc_/, '');
  return `${base()}/api/v1/download?id=${encodeURIComponent(sid)}`;
}
function coverUrl(url, size = 't500x500') {
  if (!url) return null;
  // upgrade artwork resolution
  const big = url.replace(/-large|-t\d+x\d+/, '-' + size);
  return `${base()}/api/v1/cover?url=${encodeURIComponent(big)}`;
}

async function downloadFile(idOrSid, filePath, maxBytes = 50 * 1024 * 1024) {
  const sid = String(idOrSid).replace(/^sc_/, '');
  const { getStore } = require('../core/store');
  try {
    await downloadTo(downloadUrl(sid), filePath, { timeout: 60000, maxBytes });
    return { ok: true, via: 'download' };
  } catch (e) {
    // fall back to stream
    try {
      await downloadTo(streamUrl(sid), filePath, { timeout: 90000, maxBytes });
      return { ok: true, via: 'stream' };
    } catch (e2) { throw wrap(e2); }
  }
}

async function health() {
  const t0 = Date.now();
  try { const d = await getJson(base() + '/health', { timeout: 8000, retries: 1 }); return { ok: !!d.ok, ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: e.code || e.message }; }
}

module.exports = { search, track, resolveUrl, checkDownload, downloadFile, streamUrl, downloadUrl, coverUrl, sidOf, health, ServiceError };
