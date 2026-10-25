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

function hlsUrl(idOrSid) {
  const sid = String(idOrSid).replace(/^sc_/, '');
  return `${base()}/api/v1/hls?id=${encodeURIComponent(sid)}`;
}
function hlsSegUrl(u) {
  return `${base()}/api/v1/hls-seg?u=${u}`;
}

// Parse an m3u8 media playlist: returns {init, segs[]}
function parseM3U8(text) {
  const lines = text.split(/\r?\n/);
  let init = null;
  const segs = [];
  for (const line of lines) {
    const m = line.match(/#EXT-X-MAP:URI="([^"]+)"/);
    if (m) init = m[1];
    else if (line && !line.startsWith('#')) segs.push(line.trim());
  }
  return { init, segs };
}

// Download an HLS track by fetching the init + every segment (parallel batches,
// order preserved) and concatenating into one fMP4 stream.
async function downloadHls(idOrSid, filePath, { maxBytes = 50 * 1024 * 1024, concurrency = 6, timeout = 120000 } = {}) {
  const fs = require('node:fs');
  const manifestRes = await request(hlsUrl(idOrSid), { timeout: 20000, maxBytes: 4 * 1024 * 1024 });
  const text = manifestRes.text();
  if (!/^#EXTM3U/i.test(text.trim())) throw new ServiceError('NOT_HLS', 'not an hls manifest');
  const { init, segs } = parseM3U8(text);
  if (!segs.length) throw new ServiceError('EMPTY_MANIFEST', 'no segments');
  const fd = fs.openSync(filePath, 'w');
  try {
    let written = 0;
    const writeBuf = (buf) => { fs.writeSync(fd, buf, 0, buf.length, written); written += buf.length; if (written > maxBytes) throw new ServiceError('PAYLOAD_TOO_LARGE', 'hls too large'); };
    const fetchSeg = async (u) => {
      const r = await request(u, { timeout, retries: 2, maxBytes });
      return r.body;
    };
    if (init) writeBuf(await fetchSeg(init));
    // fetch in ordered batches
    for (let i = 0; i < segs.length; i += concurrency) {
      const batch = segs.slice(i, i + concurrency);
      const bufs = await Promise.all(batch.map(fetchSeg));
      for (const b of bufs) writeBuf(b);
    }
    return { ok: true, via: 'hls', segments: segs.length, size: written };
  } finally { try { fs.closeSync(fd); } catch (_) {} }
}

async function downloadFile(idOrSid, filePath, maxBytes = 50 * 1024 * 1024) {
  const sid = String(idOrSid).replace(/^sc_/, '');
  const fs = require('node:fs');
  const bufHead = () => { try { return fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).slice(0, 256); } catch (_) { return ''; } };
  const isBadBody = () => { const h = bufHead(); return h.trimStart().startsWith('{') || /^#EXTM3U/i.test(h); };

  // 1) direct download (progressive mp3/m4a)
  try {
    await downloadTo(downloadUrl(sid), filePath, { timeout: 90000, maxBytes });
    if (!isBadBody()) return { ok: true, via: 'download' };
  } catch (_) {}
  try { fs.unlinkSync(filePath); } catch (_) {}

  // 2) progressive stream
  try {
    await downloadTo(streamUrl(sid), filePath, { timeout: 120000, maxBytes });
    if (!isBadBody()) return { ok: true, via: 'stream' };
  } catch (_) {}
  try { fs.unlinkSync(filePath); } catch (_) {}

  // 3) HLS stitching (long/streamable tracks) — the manifest's signed seg URLs
  //    already point through the worker's /hls-seg proxy, so use them verbatim.
  return downloadHls(sid, filePath, { maxBytes });
}

async function health() {
  const t0 = Date.now();
  try { const d = await getJson(base() + '/health', { timeout: 8000, retries: 1 }); return { ok: !!d.ok, ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: e.code || e.message }; }
}

module.exports = { search, track, resolveUrl, checkDownload, downloadFile, streamUrl, downloadUrl, coverUrl, sidOf, health, ServiceError };
