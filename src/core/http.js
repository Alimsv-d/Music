'use strict';
// Generic HTTP client: keep-alive, timeout, limited retry w/ backoff, per-host circuit breaker.
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const agentHttp = new http.Agent({ keepAlive: true, maxSockets: 64 });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 64 });

function validatePublicServiceUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || !['soundcloud-worker.alighost5920.workers.dev', 'shazam-worker.alighost5920.workers.dev', 'insta-worker.alighost5920.workers.dev'].includes(u.hostname)) {
    throw new HttpError('URL host not allowed', { code: 'URL_NOT_ALLOWED' });
  }
  return u;
}

const breakers = new Map(); // host -> {fails, openUntil}
const BREAKER_THRESHOLD = 4;
const BREAKER_COOLDOWN = 30000;

function breakerFor(host) {
  let b = breakers.get(host);
  if (!b) { b = { fails: 0, openUntil: 0 }; breakers.set(host, b); }
  return b;
}

class HttpError extends Error {
  constructor(msg, { status, code, body } = {}) {
    super(msg);
    this.status = status || 0;
    this.code = code || 'HTTP_ERROR';
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(urlStr, opts = {}) {
  const {
    method = 'GET', headers = {}, body = null, timeout = 15000,
    retries = 2, backoff = 400, maxBytes = Infinity, stream = null,
  } = opts;
  const u = new URL(urlStr);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new HttpError('invalid URL', { code: 'URL_NOT_ALLOWED' });
  const mod = u.protocol === 'http:' ? http : https;
  const agent = u.protocol === 'http:' ? agentHttp : agentHttps;
  const br = breakerFor(u.host);
  if (Date.now() < br.openUntil) throw new HttpError('circuit open', { code: 'CIRCUIT_OPEN' });

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoff * attempt + Math.random() * 100);
    try {
      const res = await doRequest(mod, u, agent, { method, headers, body, timeout, maxBytes, stream });
      br.fails = 0;
      return res;
    } catch (e) {
      lastErr = e;
      const retriable = e.status === 0 || e.status >= 500 || e.status === 429;
      if (!retriable || attempt === retries) break;
    }
  }
  br.fails++;
  if (br.fails >= BREAKER_THRESHOLD) { br.openUntil = Date.now() + BREAKER_COOLDOWN; br.fails = 0; }
  throw lastErr;
}

function doRequest(mod, u, agent, { method, headers, body, timeout, maxBytes, stream }) {
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, agent, headers: { 'User-Agent': 'MusicBot/1.0', ...headers } }, (res) => {
      const chunks = [];
      let size = 0;
      let out = stream;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new HttpError('payload too large', { code: 'PAYLOAD_TOO_LARGE', status: res.statusCode })); return; }
        if (out) out.write(c); else chunks.push(c);
      });
      res.on('end', () => {
        if (out) { out.end(); resolve({ status: res.statusCode, headers: res.headers, stream: out }); return; }
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf, text: () => buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) });
      });
      res.on('error', reject);
      if (res.statusCode >= 400 && !stream) {
        // consume then reject below via 'end'
      }
    });
    req.on('error', (e) => reject(e instanceof HttpError ? e : new HttpError(e.message, { status: 0, code: 'NETWORK' })));
    req.setTimeout(timeout, () => req.destroy(new HttpError('timeout', { status: 0, code: 'TIMEOUT' })));
    if (body) req.write(body);
    req.end();
  }).then((res) => {
    if (!stream && res.status >= 400) {
      let code = 'HTTP_' + res.status;
      try { const j = res.json(); if (j && j.error && j.error.code) code = j.error.code; } catch (_) {}
      throw new HttpError(`HTTP ${res.status}`, { status: res.status, code, body: res.text() });
    }
    return res;
  });
}

async function getJson(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  return res.json();
}

async function postJson(url, obj, opts = {}) {
  const res = await request(url, {
    ...opts, method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(obj),
  });
  return res.json();
}

async function downloadTo(url, filePath, opts = {}) {
  const fs = require('node:fs');
  const ws = fs.createWriteStream(filePath);
  try {
    const res = await request(url, { ...opts, stream: ws, retries: opts.retries ?? 1 });
    // request() resolves on response end, but the file stream may still have
    // buffered writes. Wait for the actual finish before stat/read/rename.
    await new Promise((resolve, reject) => {
      if (ws.writableFinished) return resolve();
      ws.once('finish', resolve);
      ws.once('error', reject);
      ws.once('close', () => ws.writableFinished ? resolve() : reject(new HttpError('file stream closed early', { code: 'SHORT_WRITE' })));
    });
    if (res.status >= 400) throw new HttpError(`HTTP ${res.status}`, { status: res.status, code: 'HTTP_' + res.status });
    const ct = String(res.headers['content-type'] || '').toLowerCase();
    if (ct.includes('application/json') || ct.includes('mpegurl') || ct.includes('text/plain')) {
      throw new HttpError('download endpoint returned manifest/json, not media', { code: 'NOT_MEDIA', status: res.status });
    }
    return res;
  } catch (e) {
    try { ws.destroy(); } catch (_) {}
    try { fs.unlinkSync(filePath); } catch (_) {}
    throw e;
  }
}

module.exports = { request, getJson, postJson, downloadTo, HttpError, sleep, validatePublicServiceUrl };
