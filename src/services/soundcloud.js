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
// Playable = the worker can produce a complete media file for the track.
// The catalog is effectively all-HLS: /download and /stream assemble a single
// fMP4/m4a for "direct" mode, and /hls+/hls-seg provide segments for "browser"
// mode. check=1 distinguishes, but cheaply we just need downloadable||streamable.
function isPlayable(t) {
  return !!(t && (t.hasMp3 || t.hasProgressive || t.downloadable || t.streamable));
}

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
  } catch (e) {
    try { fs.unlinkSync(filePath); } catch (_) {}
    throw e;
  } finally { try { fs.closeSync(fd); } catch (_) {} }
}

// Fetch a whole media response into memory (no disk). Returns Buffer.
async function fetchBuffer(url, { timeout = 90000, maxBytes = 48 * 1024 * 1024, retries = 2 } = {}) {
  const res = await request(url, { timeout, retries, maxBytes });
  const ct = String(res.headers['content-type'] || '').toLowerCase();
  const head = res.body.slice(0, 16).toString('utf8');
  if (ct.includes('application/json') || /^\s*\{/.test(head) || /^#EXTM3U/i.test(res.body.slice(0, 8).toString('utf8'))) {
    const e = new Error('endpoint returned manifest/json, not media'); e.code = 'NOT_MEDIA'; throw e;
  }
  return res.body;
}

// Assemble an HLS track entirely in memory: init + segments fetched in ordered
// parallel batches, concatenated into a single fMP4 Buffer. No disk writes.
async function fetchHlsBuffer(idOrSid, { maxBytes = 48 * 1024 * 1024, concurrency = 4, timeout = 90000 } = {}) {
  const manifestRes = await request(hlsUrl(idOrSid), { timeout: 20000, maxBytes: 4 * 1024 * 1024 });
  const text = manifestRes.text();
  if (!/^#EXTM3U/i.test(text.trim())) { const e = new Error('not an hls manifest'); e.code = 'NOT_HLS'; throw e; }
  const { init, segs } = parseM3U8(text);
  if (!segs.length) { const e = new Error('no segments'); e.code = 'EMPTY_MANIFEST'; throw e; }
  const parts = [];
  let total = 0;
  const push = (buf) => { total += buf.length; if (total > maxBytes) { const e = new Error('hls too large'); e.code = 'PAYLOAD_TOO_LARGE'; throw e; } parts.push(buf); };
  const seg = async (u) => (await request(u, { timeout, retries: 2, maxBytes })).body;
  if (init) push(await seg(init));
  for (let i = 0; i < segs.length; i += concurrency) {
    const batch = segs.slice(i, i + concurrency);
    const bufs = await Promise.all(batch.map(seg));
    for (const b of bufs) push(b);
  }
  return Buffer.concat(parts, total);
}

// Fetch the best playable bytes for a track into memory. Chooses single-GET
// (/stream) for direct mode, HLS stitching for browser/long mode. No disk.
async function fetchTrackBuffer(idOrSid, { maxBytes = 48 * 1024 * 1024 } = {}) {
  const sid = String(idOrSid).replace(/^sc_/, '');
  const chk = await checkDownload(sid).catch(() => null);
  // browser/long mode -> stitch segments
  if (chk && chk.ok && chk.mode === 'browser') {
    const buf = await fetchHlsBuffer(sid, { maxBytes });
    return { buf, via: 'hls', segments: chk.segments || 0 };
  }
  // direct mode (or unknown) -> try single GET endpoints
  try { return { buf: await fetchBuffer(streamUrl(sid), { maxBytes }), via: 'stream' }; } catch (_) {}
  try { return { buf: await fetchBuffer(downloadUrl(sid), { maxBytes }), via: 'download' }; } catch (_) {}
  // last resort: HLS
  const buf = await fetchHlsBuffer(sid, { maxBytes });
  return { buf, via: 'hls' };
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

module.exports = { search, track, resolveUrl, checkDownload, downloadFile, downloadHls, fetchBuffer, fetchHlsBuffer, fetchTrackBuffer, parseM3U8, streamUrl, downloadUrl, hlsUrl, coverUrl, sidOf, isPlayable, health, ServiceError };
