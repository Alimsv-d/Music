'use strict';
// Shazam acoustic fingerprint engine (ported from the live worker's
// /static/fingerprint.js). Runs inside a worker_threads Worker to keep the
// main event loop free. Input: 16 kHz mono PCM (Int16Array), <= 12 s.
function fpHanningWindow() {
  const size = 2048;
  const out = new Float64Array(size);
  const denom = 2049;
  for (let n = 1; n <= size; n++) out[n - 1] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / denom);
  return out;
}
function fpFftTables(n) {
  const levels = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let x = i, r = 0; for (let j = 0; j < levels; j++) { r = r << 1 | x & 1; x >>= 1; } rev[i] = r >>> 0; }
  const stages = [];
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1; const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const cr = new Float64Array(half), ci = new Float64Array(half);
    let a = 1, b = 0;
    for (let j = 0; j < half; j++) { cr[j] = a; ci[j] = b; const na = a * wr - b * wi; b = a * wi + b * wr; a = na; }
    stages.push({ len, half, cr, ci });
  }
  return { n, levels, rev, stages };
}
function fpFft(re, im) {
  const n = re.length;
  let tables = fpFft._tables;
  if (!tables || tables.n !== n) tables = fpFft._tables = fpFftTables(n);
  const rev = tables.rev;
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t2 = re[i]; re[i] = re[j]; re[j] = t2; t2 = im[i]; im[i] = im[j]; im[j] = t2; } }
  const stages = tables.stages;
  for (let s = 0; s < stages.length; s++) {
    const st = stages[s], half = st.half, cr = st.cr, ci = st.ci;
    for (let i = 0; i < n; i += st.len) {
      for (let j = 0; j < half; j++) {
        const wr = cr[j], wi = ci[j], p = i + j, q = p + half;
        const vr = re[q] * wr - im[q] * wi, vi = re[q] * wi + im[q] * wr;
        const ur = re[p], ui = im[p];
        re[q] = ur - vr; im[q] = ui - vi; re[p] = ur + vr; im[p] = ui + vi;
      }
    }
  }
}
function fpCrc32(bytes) {
  let table = fpCrc32._table;
  if (!table) {
    table = fpCrc32._table = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1; table[n] = c; }
  }
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) crc = crc >>> 8 ^ table[(crc ^ bytes[i]) & 255];
  return (crc ^ -1) >>> 0;
}
function fpBase64(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = ''; const len = bytes.length; let i = 0;
  for (; i + 2 < len; i += 3) { const n = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2]; out += chars[n >> 18 & 63] + chars[n >> 12 & 63] + chars[n >> 6 & 63] + chars[n & 63]; }
  const rest = len - i;
  if (rest === 1) { const n = bytes[i] << 16; out += chars[n >> 18 & 63] + chars[n >> 12 & 63] + '=='; }
  else if (rest === 2) { const n = bytes[i] << 16 | bytes[i + 1] << 8; out += chars[n >> 18 & 63] + chars[n >> 12 & 63] + chars[n & 63] + '='; }
  return out;
}
class FpSignatureGenerator {
  constructor(options) {
    const opt = options || {};
    this.sampleRate = opt.sampleRate || 16e3;
    this.maxTimeSeconds = opt.maxTimeSeconds || 12;
    this.maxPeaks = opt.maxPeaks || 255;
    this.fftSize = 2048; this.binCount = 1025; this.hopSize = 128;
    this.input = new Float64Array(65536); this.inputLength = 0; this.samplesProcessed = 0;
    this.ring = new Float64Array(this.fftSize); this.ringPos = 0;
    this.re = new Float64Array(this.fftSize); this.im = new Float64Array(this.fftSize);
    this.window = fpHanningWindow();
    this.fftOut = new Array(256); for (let i = 0; i < 256; i++) this.fftOut[i] = new Float64Array(this.binCount);
    this.fftPos = 0; this.fftWritten = 0;
    this.spread = new Array(256); for (let i = 0; i < 256; i++) this.spread[i] = new Float64Array(this.binCount);
    this.spreadPos = 0; this.spreadWritten = 0;
    this.scratch1 = new Float64Array(this.binCount); this.scratch2 = new Float64Array(this.binCount);
    this.scratch3 = new Float64Array(this.binCount); this.scratch4 = new Float64Array(this.binCount);
    this.next = { sampleRate: this.sampleRate, numberSamples: 0, bands: new Map() };
  }
  feed(samples) {
    let arr;
    if (samples instanceof Float64Array) arr = samples;
    else if (samples instanceof Int16Array) { arr = new Float64Array(samples.length); for (let i = 0; i < samples.length; i++) arr[i] = samples[i]; }
    else if (samples instanceof Float32Array) { arr = new Float64Array(samples.length); for (let i = 0; i < samples.length; i++) arr[i] = samples[i]; }
    else arr = Float64Array.from(samples);
    const need = this.inputLength + arr.length;
    if (need > this.input.length) { let cap = this.input.length * 2; while (cap < need) cap *= 2; const nx = new Float64Array(cap); nx.set(this.input.subarray(0, this.inputLength)); this.input = nx; }
    this.input.set(arr, this.inputLength); this.inputLength += arr.length;
    return this;
  }
  skipSamples(count) { this.samplesProcessed = Math.min(this.inputLength, this.samplesProcessed + count); return this; }
  peakCount() { let t = 0; for (const a of this.next.bands.values()) t += a.length; return t; }
  doFft(offset, length) {
    const size = this.fftSize, start = this.ringPos;
    for (let i = 0; i < length; i++) this.ring[(start + i) % size] = this.input[offset + i];
    this.ringPos = (start + length) % size;
    const re = this.re, im = this.im, ring = this.ring, win = this.window, rp = this.ringPos;
    for (let i = 0; i < size; i++) { re[i] = ring[(rp + i) % size] * win[i]; im[i] = 0; }
    fpFft(re, im);
    const out = this.fftOut[this.fftPos];
    for (let i = 0; i < this.binCount; i++) { let v = (re[i] * re[i] + im[i] * im[i]) / 131072; if (v < 1e-10) v = 1e-10; out[i] = v; }
    this.fftPos = this.fftPos + 1 & 255; this.fftWritten++;
  }
  doPeakSpreading() {
    const bins = this.binCount, origin = this.fftOut[this.fftPos - 1 + 256 & 255], s4 = this.scratch4;
    for (let i = 0; i < bins; i++) { const a = origin[i], b = origin[(i + 1) % bins], c = origin[(i + 2) % bins]; s4[i] = a > b ? (a > c ? a : c) : (b > c ? b : c); }
    const spreadOrigin = this.scratch3;
    for (let i = 0; i < bins - 3; i++) spreadOrigin[i] = s4[i];
    for (let i = bins - 3; i < bins; i++) spreadOrigin[i] = origin[i];
    const i1 = this.spreadPos + 255 & 255, i2 = this.spreadPos + 253 & 255, i3 = this.spreadPos + 250 & 255;
    const r1 = this.scratch1, r2 = this.scratch2, r3 = this.scratch4;
    const b1 = this.spread[i1], b2 = this.spread[i2], b3 = this.spread[i3];
    for (let i = 0; i < bins; i++) { const v = spreadOrigin[i]; r1[i] = v > b1[i] ? v : b1[i]; }
    for (let i = 0; i < bins; i++) { const v = r1[i]; r2[i] = v > b2[i] ? v : b2[i]; }
    for (let i = 0; i < bins; i++) { const v = r2[i]; r3[i] = v > b3[i] ? v : b3[i]; }
    this.spread[i1].set(r1); this.spread[i2].set(r2); this.spread[i3].set(r3);
    this.spread[this.spreadPos].set(spreadOrigin);
    this.spreadPos = this.spreadPos + 1 & 255; this.spreadWritten++;
  }
  doPeakRecognition() {
    const bins = this.binCount;
    const f46 = this.fftOut[this.fftPos - 46 + 256 & 255];
    const f49 = this.spread[this.spreadPos - 49 + 256 & 255];
    const fftNumber = this.spreadWritten - 46;
    const NEIGH = [-10, -7, -4, -3, 1, 2, 5, 8];
    const OTHER = [-53, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249];
    for (let bin = 10; bin < 1015; bin++) {
      const v = f46[bin];
      if (!(v >= 1 / 64 && v >= f49[bin - 1])) continue;
      let maxN = 0;
      for (const k of NEIGH) { const nv = f49[bin + k]; if (nv > maxN) maxN = nv; }
      if (!(v > maxN)) continue;
      let maxO = maxN;
      for (const k of OTHER) { const nv = this.spread[this.spreadPos + k + 512 & 255][bin - 1]; if (nv > maxO) maxO = nv; }
      if (!(v > maxO)) continue;
      const peakMag = Math.log(v > 1 / 64 ? v : 1 / 64) * 1477.3 + 6144;
      const before = f46[bin - 1] > 1 / 64 ? f46[bin - 1] : 1 / 64;
      const after = f46[bin + 1] > 1 / 64 ? f46[bin + 1] : 1 / 64;
      const peakBefore = Math.log(before) * 1477.3 + 6144;
      const peakAfter = Math.log(after) * 1477.3 + 6144;
      const v1 = peakMag * 2 - peakBefore - peakAfter;
      if (v1 <= 0) continue;
      const v2 = (peakAfter - peakBefore) * 32 / v1;
      const corrected = bin * 64 + v2;
      const hz = corrected * (16e3 / 2 / 1024 / 64);
      let band;
      if (hz > 250 && hz < 520) band = 0;
      else if (hz > 520 && hz < 1450) band = 1;
      else if (hz > 1450 && hz < 3500) band = 2;
      else if (hz > 5500 && hz <= 5500) band = 3;
      else continue;
      let peaks = this.next.bands.get(band);
      if (!peaks) { peaks = []; this.next.bands.set(band, peaks); }
      peaks.push({ fftPassNumber: fftNumber, peakMagnitude: Math.trunc(peakMag), correctedPeakFrequencyBin: Math.trunc(corrected), sampleRateHz: 16e3 });
    }
  }
  getNextSignature() {
    const hop = this.hopSize;
    while (this.inputLength - this.samplesProcessed >= hop && (this.next.numberSamples / this.next.sampleRate < this.maxTimeSeconds || this.peakCount() < this.maxPeaks)) {
      this.next.numberSamples += hop;
      this.doFft(this.samplesProcessed, hop);
      this.doPeakSpreading();
      if (this.spreadWritten >= 46) this.doPeakRecognition();
      this.samplesProcessed += hop;
    }
    return this.next;
  }
}
function fpEncodeSignature(signature) {
  const bandIds = Array.from(signature.bands.keys()).sort((a, b) => a - b);
  const chunks = []; let contentsLength = 0;
  for (const band of bandIds) {
    const peaks = signature.bands.get(band);
    const payload = new Uint8Array(peaks.length * 5);
    let off = 0, fftPass = 0;
    for (const p of peaks) {
      if (p.fftPassNumber - fftPass >= 255) {
        payload[off++] = 255; payload[off++] = p.fftPassNumber & 255; payload[off++] = p.fftPassNumber >>> 8 & 255; payload[off++] = p.fftPassNumber >>> 16 & 255; payload[off++] = p.fftPassNumber >>> 24 & 255;
        fftPass = p.fftPassNumber;
      }
      payload[off++] = p.fftPassNumber - fftPass;
      payload[off++] = p.peakMagnitude & 255; payload[off++] = p.peakMagnitude >>> 8 & 255;
      payload[off++] = p.correctedPeakFrequencyBin & 255; payload[off++] = p.correctedPeakFrequencyBin >>> 8 & 255;
      fftPass = p.fftPassNumber;
    }
    const head = new Uint8Array(8); const bandId = 1610809408 + band;
    head[0] = bandId & 255; head[1] = bandId >>> 8 & 255; head[2] = bandId >>> 16 & 255; head[3] = bandId >>> 24 & 255;
    head[4] = payload.length & 255; head[5] = payload.length >>> 8 & 255; head[6] = payload.length >>> 16 & 255; head[7] = payload.length >>> 24 & 255;
    const padding = (4 - payload.length % 4) % 4;
    chunks.push(head, payload, new Uint8Array(padding));
    contentsLength += 8 + payload.length + padding;
  }
  const total = 48 + contentsLength + 8;
  const out = new Uint8Array(total); const view = new DataView(out.buffer);
  view.setUint32(0, 3405653376, true); view.setUint32(4, 0, true); view.setUint32(8, contentsLength + 8, true);
  view.setUint32(12, 2484182016, true); view.setUint32(28, 3 << 27 >>> 0, true);
  view.setUint32(40, Math.trunc(signature.numberSamples + signature.sampleRate * 0.24), true);
  view.setUint32(44, (15 << 19) + 262144 >>> 0, true); view.setUint32(48, 1073741824, true); view.setUint32(52, contentsLength + 8, true);
  let pos = 56;
  for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length; }
  const crc = fpCrc32(out.subarray(8));
  view.setUint32(4, crc, true);
  return out;
}
module.exports = { fpHanningWindow, fpFftTables, fpFft, fpCrc32, fpBase64, FpSignatureGenerator, fpEncodeSignature };
