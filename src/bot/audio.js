'use strict';
// Decode Telegram media to 16 kHz mono PCM s16le and recognize via shazam.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const config = require('../config');
const { request } = require('../core/http');
const sh = require('../services/shazam');
const log = require('../core/log');

const TG_FILE = (filePath) => `https://api.telegram.org/file/bot${config.botToken}/${filePath}`;
const MAX = 20 * 1024 * 1024;

function hasFfmpeg() {
  return new Promise((res) => execFile('ffmpeg', ['-version'], (e) => res(!e)));
}

async function fetchTgFile(fileId) {
  const metaRes = await request(`https://api.telegram.org/bot${config.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`, { timeout: 10000, retries: 2, maxBytes: 65536 });
  const meta = metaRes.json();
  if (!meta.ok || !meta.result.file_path) throw new Error('getFile failed');
  if (meta.result.file_size && meta.result.file_size > MAX) { const e = new Error('too large'); e.code = 'PAYLOAD_TOO_LARGE'; throw e; }
  const res = await request(TG_FILE(meta.result.file_path), { timeout: 60000, maxBytes: MAX });
  return { buf: res.body, path: meta.result.file_path };
}

function wavToPcm(buf) {
  // parse minimal WAV: find fmt + data
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { audioFormat: buf.readUInt16LE(off + 8), ch: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') { data = buf.subarray(off + 8, off + 8 + sz); break; }
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || !data || fmt.audioFormat !== 1 || fmt.bits !== 16) return null;
  const n = Math.floor(data.length / 2);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = data.readInt16LE(i * 2);
  return { pcm, rate: fmt.rate, ch: fmt.ch };
}

function resampleTo16kMono(pcm, rate, ch) {
  // downmix to mono then linear resample to 16000
  let mono = pcm;
  if (ch > 1) {
    mono = new Int16Array(Math.floor(pcm.length / ch));
    for (let i = 0; i < mono.length; i++) {
      let s = 0; for (let c = 0; c < ch; c++) s += pcm[i * ch + c];
      mono[i] = Math.round(s / ch);
    }
  }
  if (rate === 16000) return mono;
  const ratio = 16000 / rate;
  const outLen = Math.floor(mono.length * ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src), i1 = Math.min(i0 + 1, mono.length - 1);
    const frac = src - i0;
    out[i] = Math.round(mono[i0] * (1 - frac) + mono[i1] * frac);
  }
  return out;
}

const { spawn } = require('node:child_process');

// Decode media bytes to 16kHz mono PCM via ffmpeg pipes — NO disk writes.
// Reads buf from stdin, writes s16le to stdout. Runs niced, single instance.
let ffActive = 0;
async function decodeWithFfmpegPipe(buf, { seconds = 40, timeout = 30000 } = {}) {
  if (ffActive >= 1) { const e = new Error('ffmpeg busy'); e.code = 'FFMPEG_BUSY'; throw e; }
  ffActive++;
  try {
    return await new Promise((resolve, reject) => {
      const args = ['-v', 'error', '-i', 'pipe:0', '-t', String(seconds), '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'];
      const p = spawn('nice', ['-n', '10', 'ffmpeg', ...args], { stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks = [];
      const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} ; reject(new Error('ffmpeg timeout')); }, timeout);
      p.stdout.on('data', (c) => chunks.push(c));
      p.on('error', (e) => { clearTimeout(to); reject(e); });
      p.on('close', (code) => {
        clearTimeout(to);
        if (code !== 0) return reject(new Error('ffmpeg exit ' + code));
        const raw = Buffer.concat(chunks);
        const n = Math.floor(raw.length / 2);
        const pcm = new Int16Array(n);
        for (let i = 0; i < n; i++) pcm[i] = raw.readInt16LE(i * 2);
        resolve(pcm);
      });
      p.stdin.on('error', () => {});
      p.stdin.write(buf); p.stdin.end();
    });
  } finally { ffActive--; }
}

// Back-compat name — now purely in-memory (pipe), no disk.
async function decodeWithFfmpeg(buf, ext) {
  return decodeWithFfmpegPipe(buf);
}

// register with the heavy-work facade so worker-mode deployments route here
// via HEAVY_URL instead of local ffmpeg.
try {
  require('../shared/heavy').registerLocal('decodePcm', async ({ data }) => {
    const pcm = await decodeWithFfmpegPipe(Buffer.from(data, 'base64'));
    return { pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') };
  });
} catch (_) {}

// fileRef: {file_id, mime, name}
async function processAudio(ctx, fileRef, lang) {
  const { buf, path: fp } = await fetchTgFile(fileRef.file_id);
  const ext = (fp.split('.').pop() || '').toLowerCase();
  const mime = (fileRef.mime || '').toLowerCase();

  // native WAV
  if (ext === 'wav' || mime.includes('wav')) {
    const w = wavToPcm(buf);
    if (w) {
      const pcm = resampleTo16kMono(w.pcm, w.rate, w.ch);
      return sh.recognizeBySignature(pcm, { lyrics: true });
    }
    // non-PCM wav -> ffmpeg
  }
  // Try ffmpeg for everything else (ogg/opus voice, mp3, m4a, mp4)
  if (await hasFfmpeg()) {
    try {
      const pcm = await decodeWithFfmpeg(buf, ext || 'bin');
      if (pcm && pcm.length > 16000) return sh.recognizeBySignature(pcm, { lyrics: true });
    } catch (e) { log.warn('ffmpeg decode fail', e.message); }
  } else {
    // without ffmpeg only wav is supported client-side
    const e = new Error('unsupported'); e.code = 'UNSUPPORTED'; throw e;
  }
  const e = new Error('no decode'); e.code = 'UNSUPPORTED'; throw e;
}

module.exports = { processAudio, fetchTgFile, wavToPcm, resampleTo16kMono, decodeWithFfmpeg, decodeWithFfmpegPipe };
