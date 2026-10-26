'use strict';
// Lightweight perf instrumentation: per-stage timings, event-loop delay
// monitoring, and p50/p95 rollups for the owner /perf command.
const { monitorEventLoopDelay } = require('node:perf_hooks');

const eld = monitorEventLoopDelay({ resolution: 20 });
eld.enable();
let eldWarnedAt = 0;

// ring buffers per metric name -> recent ms samples (max 300)
const samples = new Map();
function record(name, ms) {
  let a = samples.get(name);
  if (!a) { a = []; samples.set(name, a); }
  a.push(ms);
  if (a.length > 300) a.shift();
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}

function stats(name) {
  const a = samples.get(name) || [];
  return { n: a.length, p50: pct(a, 50), p95: pct(a, 95), max: a.length ? Math.round(Math.max(...a)) : 0 };
}

function report() {
  const out = {};
  for (const k of samples.keys()) out[k] = stats(k);
  out.eventLoop = { p50: Math.round(eld.percentile(50) / 1e6), p95: Math.round(eld.percentile(95) / 1e6), max: Math.round(eld.max / 1e6) };
  out.rss = Math.round(process.memoryUsage().rss / 1e6);
  return out;
}

function checkLoop(log) {
  const p95 = eld.percentile(95) / 1e6;
  if (p95 > 200 && Date.now() - eldWarnedAt > 60000) {
    eldWarnedAt = Date.now();
    log.warn('event-loop delay high', { p95: Math.round(p95) });
  }
  eld.reset();
}

module.exports = { record, stats, report, checkLoop };
