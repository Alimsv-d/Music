'use strict';
// Shazam (Shzm) service client. Fingerprint computed in a worker thread.
// Quota-safe: identical clips are cached by content hash for 1 hour, negative
// results are remembered for 15 min, and concurrent identical uploads share
// one outbound request via coalescing.
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const crypto = require('node:crypto');
const config = require('../config');
const { postJson, getJson } = require('../core/http');
const { coalesce, recogCache, negCache } = require('../core/cache');

const base = () => config.shazamApi;
const WORKER = path.join(__dirname, 'fingerprint_worker.js');
let workerPool = [];
const POOL = 2;

class ServiceError extends Error {
  constructor(code, message, status) { super(message || code); this.code = code; this.status = status || 0; }
}

function getWorker() {
  for (const w of workerPool) if (!w.busy) { w.busy = true; return w; }
  if (workerPool.length < POOL) {
    const w = { worker: null, busy: true };
    workerPool.push(w);
    return w;
  }
  return null; // caller queues
}

async function fingerprintPcm(pcm /* Int16Array */, maxSeconds = 12, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const slot = getWorker();
    if (!slot) return reject(new ServiceError('BUSY', 'fingerprint workers busy'));
    const release = () => { slot.busy = false; };
    try {
      const w = new Worker(WORKER, { workerData: { pcm: Array.from(pcm), maxSeconds } });
      slot.worker = w;
      const to = setTimeout(() => { w.terminate(); release(); reject(new ServiceError('TIMEOUT', 'fingerprint timeout')); }, timeout);
      w.once('message', (m) => { clearTimeout(to); release(); w.terminate(); m.ok ? resolve(m) : reject(new ServiceError('FP_FAIL', m.error)); });
      w.once('error', (e) => { clearTimeout(to); release(); reject(new ServiceError('FP_ERR', e.message)); });
    } catch (e) { release(); reject(new ServiceError('FP_ERR', e.message)); }
  });
}

// Stable content hash for a PCM buffer — used to dedupe repeated uploads of the
// same voice/video/audio clip.
function pcmHash(pcm) {
  const h = crypto.createHash('sha256');
  h.update(Buffer.from(pcm.buffer, pcm.byteOffset, Math.min(pcm.byteLength, 64 * 1024)));
  h.update(String(pcm.length));
  return h.digest('hex').slice(0, 24);
}

async function recognizeBySignature(pcm, { lyrics = true } = {}) {
  const key = 'fp:' + pcmHash(pcm);
  const cached = recogCache.get(key);
  if (cached) return cached;
  if (negCache.get(key)) throw new ServiceError('E_NO_MATCH', 'no match (cached)', 404);

  return coalesce(key, async () => {
    // Compute fingerprint locally, POST signature; fallback to raw PCM.
    let uri, samplems;
    try {
      ({ uri, samplems } = await fingerprintPcm(pcm));
    } catch (_) {
      uri = null;
    }
    if (uri) {
      const d = await postJson(base() + '/api/v1/recognize', { signature: uri, samplems, lyrics }, { timeout: 20000 });
      if (d.ok && d.data) {
        recogCache.set(key, d.data);
        return d.data;
      }
      if (d.error && d.error.code === 'E_NO_MATCH') {
        negCache.set(key, true);
        throw new ServiceError('E_NO_MATCH', 'no match', 404);
      }
      // fall through to PCM on other errors
    }
    const pcmB64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
    const d = await postJson(base() + '/api/v1/recognize', { pcm: pcmB64, lyrics }, { timeout: 30000 });
    if (d.ok && d.data) {
      recogCache.set(key, d.data);
      return d.data;
    }
    const code = d.error && d.error.code || 'E_UPSTREAM';
    if (code === 'E_NO_MATCH') negCache.set(key, true);
    throw new ServiceError(code, 'recognize failed', d.status);
  });
}

async function recognizeWav(wavBuf, { lyrics = true } = {}) {
  const key = 'wav:' + crypto.createHash('sha256').update(wavBuf).digest('hex').slice(0, 24);
  const cached = recogCache.get(key);
  if (cached) return cached;
  if (negCache.get(key)) throw new ServiceError('E_NO_MATCH', 'no match (cached)', 404);

  return coalesce(key, async () => {
    const res = await require('../core/http').request(base() + '/api/v1/recognize', {
      method: 'POST', headers: { 'Content-Type': 'audio/wav', Accept: 'application/json' },
      body: wavBuf, timeout: 30000,
    });
    const d = res.json();
    if (d.ok && d.data) {
      recogCache.set(key, d.data);
      return d.data;
    }
    const code = d.error && d.error.code || 'E_UPSTREAM';
    if (code === 'E_NO_MATCH') negCache.set(key, true);
    throw new ServiceError(code, 'recognize failed', d.status);
  });
}

async function searchText(query, limit = 6, lyrics = false) {
  const key = `shq:${query.toLowerCase()}`;
  return coalesce(key, async () => {
    const d = await postJson(base() + '/api/v1/search', { query, limit, lyrics }, { timeout: 12000 });
    if (!d.ok) throw new ServiceError(d.error && d.error.code || 'SEARCH_FAIL', 'search failed');
    return d.data;
  });
}

async function lyrics(artist, title) {
  const key = `lyr:${String(artist).toLowerCase()}:${String(title).toLowerCase()}`;
  return coalesce(key, async () => {
    try {
      const d = await getJson(base() + '/api/v1/lyrics?' + new URLSearchParams({ artist, title }), { timeout: 12000 });
      if (d.ok && d.data && d.data.available) return d.data;
      return null;
    } catch (_) { return null; }
  });
}

async function health() {
  const t0 = Date.now();
  try { const d = await getJson(base() + '/health', { timeout: 8000, retries: 1 }); return { ok: !!d.ok, ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: e.code || e.message }; }
}

module.exports = { recognizeBySignature, recognizeWav, searchText, lyrics, fingerprintPcm, health, ServiceError };
