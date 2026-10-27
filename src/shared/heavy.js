'use strict';
// Heavy-work facade: runs CPU/IO-heavy tasks (ffmpeg decode, fingerprint)
// behind a single interface. Today it executes locally; on Cloudflare Workers
// (no child_process) it will POST to a HEAVY_URL endpoint signed with HMAC,
// keeping the call sites unchanged.
const crypto = require('node:crypto');
const config = require('../config');

async function runRemote(task, payload) {
  const url = config.heavyAudioUrl; // HEAVY_URL
  if (!url) { const e = new Error('no HEAVY_URL'); e.code = 'NO_HEAVY'; throw e; }
  const body = JSON.stringify({ task, payload });
  const sig = crypto.createHmac('sha256', config.inlineSignSecret || 'x').update(body).digest('hex');
  const { request } = require('../core/http');
  const res = await request(url, {
    method: 'POST', timeout: 40000, retries: 1,
    headers: { 'content-type': 'application/json', 'x-heavy-sig': sig },
    body, maxBytes: 8 * 1024 * 1024,
  });
  return res.json();
}

// task registry: name -> local implementation (async fn)
const local = {};
function registerLocal(name, fn) { local[name] = fn; }

// heavy.run(task, payload): prefer remote when HEAVY_URL is set (worker mode),
// otherwise run the registered local implementation.
async function run(task, payload = {}) {
  if (config.isWorker || config.heavyAudioUrl) return runRemote(task, payload);
  const fn = local[task];
  if (!fn) { const e = new Error('unknown heavy task ' + task); e.code = 'NO_TASK'; throw e; }
  return fn(payload);
}

module.exports = { run, registerLocal };
