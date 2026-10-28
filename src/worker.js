'use strict';
// Music Bot — single-file Cloudflare Worker (ES module).
// Feature parity with the cPanel grammY bot, incl. *colored* inline buttons
// (Telegram Bot API 9.x `style`: success|primary|danger). If the Bot API
// deployment rejects `style`, each call retries once without it.
//
// Routes:
//   GET  /            -> landing page
//   GET  /activate    -> (re)point webhook to this worker + notify owner
//   GET  /health      -> { ok, webhook info }
//   POST /wh/<hash>   -> Telegram webhook (secret-token verified)
//   Cron              -> keep-alive / pending jobs (optional KV)

const FB = {
  SOUNDCLOUD_API_URL: 'https://soundcloud-worker.alighost5920.workers.dev',
  SHAZAM_API_URL: 'https://shazam-worker.alighost5920.workers.dev',
  INSTA_API_URL: 'https://insta-worker.alighost5920.workers.dev',
  WEBHOOK_SECRET: 'MUSIC_AUTO_FALLBACK_2026_X9fK82vTq',
  BOT_USERNAME: 'SearcherMusiic_Bot',
  CHANNEL: 'MusicMsvD',
  OWNER_USERNAME: 'AliMsvD',
};

import { FpSignatureGenerator, fpEncodeSignature, fpBase64 } from './services/fingerprint.js';
import { remux as remuxMp4 } from './lib/mp4remux.js';

const enc = new TextEncoder();
const v = (e, k, d) => (e && e[k] != null && String(e[k]).trim() !== '' ? String(e[k]).trim() : d);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sid = (t) => String((t && (t.sid || t.id)) || '').replace(/^sc_/, '');
const kb = (rows) => ({ inline_keyboard: (rows || []).filter((r) => r && r.length) });
const btn = (text, callback_data, style = 'primary') => ({ text, callback_data, style });
const G = (t, c) => btn(t, c, 'success');
const B = (t, c) => btn(t, c, 'primary');
const R = (t, c) => btn(t, c, 'danger');
const URLB = (t, u, style = 'primary') => ({ text: t, url: u, style });

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(String(s)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const b64url = (buf) => {
  const bytes = new Uint8Array(buf), parts = [];
  for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(parts.join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s) => {
  const raw = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

class TG {
  constructor(token) { this.b = `https://api.telegram.org/bot${token}`; }
  async call(method, payload, _retried) {
    try {
      const r = await fetch(`${this.b}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
      });
      const j = await r.json().catch(() => ({ ok: false }));
      if (!j.ok && !_retried && /style/i.test(String(j.description || '')) && /bad request/i.test(String(j.description || ''))) {
        const clone = JSON.parse(JSON.stringify(payload || {}));
        let removed = false;
        const strip = (mk) => {
          for (const row of (mk && mk.inline_keyboard) || [])
            for (const b of row) if ('style' in b) { delete b.style; removed = true; }
        };
        strip(clone.reply_markup);
        if (removed) return this.call(method, clone, true);
      }
      return j;
    } catch (e) { return { ok: false, error: String(e) }; }
  }
  sendMessage(c, t, ex = {}) { return this.call('sendMessage', { chat_id: c, text: t, parse_mode: 'HTML', disable_web_page_preview: true, ...ex }); }
  editMessageText(c, mid, t, ex = {}) { return this.call('editMessageText', { chat_id: c, message_id: mid, text: t, parse_mode: 'HTML', disable_web_page_preview: true, ...ex }); }
  answerCallbackQuery(id, ex = {}) { return this.call('answerCallbackQuery', { callback_query_id: id, ...ex }); }
  sendChatAction(c, a = 'typing') { return this.call('sendChatAction', { chat_id: c, action: a }); }
  sendAudio(c, audio, ex = {}) { return this.call('sendAudio', { chat_id: c, audio, ...ex }); }
  async sendAudioBytes(c, bytes, filename, ex = {}) {
    try {
      const form = new FormData();
      form.append('chat_id', String(c));
      form.append('audio', new Blob([bytes], { type: 'audio/mpeg' }), filename || 'track.mp3');
      for (const [k, val] of Object.entries(ex)) if (val !== undefined && val !== null) {
        if (k === 'reply_markup' && typeof val !== 'string') form.append(k, JSON.stringify(val));
        else form.append(k, String(val));
      }
      const r = await fetch(`${this.b}/sendAudio`, { method: 'POST', body: form });
      return await r.json().catch(() => ({ ok: false }));
    } catch (e) { return { ok: false, error: String(e) }; }
  }
  deleteMessage(c, mid) { return this.call('deleteMessage', { chat_id: c, message_id: mid }); }
  sendVideo(c, video, ex = {}) { return this.call('sendVideo', { chat_id: c, video, supports_streaming: true, ...ex }); }
  sendPhoto(c, photo, ex = {}) { return this.call('sendPhoto', { chat_id: c, photo, ...ex }); }
  sendVoice(c, voice, ex = {}) { return this.call('sendVoice', { chat_id: c, voice, ...ex }); }
  getFile(file_id) { return this.call('getFile', { file_id }); }
  setWebhook(url, ex = {}) { return this.call('setWebhook', { url, ...ex }); }
  deleteWebhook() { return this.call('deleteWebhook', { drop_pending_updates: true }); }
  getWebhookInfo() { return this.call('getWebhookInfo'); }
  getMe() { return this.call('getMe'); }
}

async function scCall(env, p, params) {
  const base = v(env, 'SOUNDCLOUD_API_URL', FB.SOUNDCLOUD_API_URL).replace(/\/$/, '');
  const url = base + p + (params && Object.keys(params).length ? '?' + new URLSearchParams(params) : '');
  try { const r = await fetch(url, { headers: { Accept: 'application/json' } }); return await r.json(); }
  catch (e) { return { ok: false }; }
}
async function shCall(env, p, body) {
  const base = v(env, 'SHAZAM_API_URL', FB.SHAZAM_API_URL).replace(/\/$/, '');
  try { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}) }); return await r.json(); }
  catch (e) { return { ok: false }; }
}
async function shMultipart(env, bytes, filename, mime) {
  const base = v(env, 'SHAZAM_API_URL', FB.SHAZAM_API_URL).replace(/\/$/, '');
  try {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime || 'application/octet-stream' }), filename || 'media.bin');
    form.append('lyrics', 'true');
    const r = await fetch(base + '/api/v1/recognize', { method: 'POST', headers: { Accept: 'application/json' }, body: form });
    return await r.json();
  } catch (e) { return { ok: false, error: { code: 'REQUEST_FAILED', message: String(e) } }; }
}
async function shRecognizeUrl(env, url) {
  const base = v(env, 'SHAZAM_API_URL', FB.SHAZAM_API_URL).replace(/\/$/, '');
  try { const r = await fetch(base + '/api/v1/recognize/url', { method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ url }) }); return await r.json(); }
  catch (e) { return { ok: false }; }
}
// Decode arbitrary media bytes to 16 kHz mono PCM (Int16Array).
// Path order: native WAV (pure JS) -> optional BACKEND /decode service -> null.
async function mediaToPcm(env, bytes, filename, mime) {
  const w = wavToPcmAndRate(bytes);
  if (w) return resampleTo16kMono(w.pcm, w.rate, w.channels);
  const backend = v(env, 'BACKEND_URL', '') || v(env, 'SHAZAM_BACKEND_URL', '') || v(env, 'HEAVY_AUDIO_URL', '');
  if (backend) {
    const base = backend.replace(/\/$/, '');
    for (const ep of ['/decode', '/api/v1/decode', '/decodeMedia']) {
      try {
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: mime || 'application/octet-stream' }), filename || 'media.bin');
        const r = await fetch(base + ep, { method: 'POST', body: form });
        if (!r.ok) continue;
        const j = await r.json().catch(() => null);
        if (!j) continue;
        const rawPcm = j.pcm ? fromB64url(j.pcm) : null;
        const wavBytes = j.wav ? fromB64url(j.wav) : null;
        if (rawPcm) return new Int16Array(rawPcm.buffer, rawPcm.byteOffset, Math.floor(rawPcm.byteLength / 2));
        if (wavBytes) { const w2 = wavToPcmAndRate(wavBytes); if (w2) return resampleTo16kMono(w2.pcm, w2.rate, w2.channels); }
        if (j.pcm_b64) return new Int16Array(fromB64url(j.pcm_b64).buffer);
      } catch (_) { /* next endpoint */ }
    }
  }
  return null;
}

// Build a Shazam signature data-URI from 16 kHz mono PCM (client-side, no ffmpeg).
function fingerprintPcm(pcmInt16) {
  const gen = new FpSignatureGenerator({ maxTimeSeconds: 12 });
  const arr = pcmInt16 instanceof Int16Array ? pcmInt16 : new Int16Array(pcmInt16);
  gen.feed(arr);
  const dur = arr.length / 16000;
  if (dur > 36) gen.skipSamples(16000 * (Math.floor(dur / 2) - 6));
  const sig = gen.getNextSignature();
  if (!sig || !sig.bands || sig.bands.size === 0) return null;
  const bytes = fpEncodeSignature(sig);
  return { uri: 'data:audio/vnd.shazam.sig;base64,' + fpBase64(bytes), samplems: Math.trunc((sig.numberSamples / sig.sampleRate) * 1000) };
}

async function shRecognizePcm(env, pcm) {
  const slice = pcm.length > 16000 * 12 ? pcm.subarray(0, 16000 * 12) : pcm;
  // Prefer signature (small, worker-side); fall back to raw PCM.
  const fp = fingerprintPcm(slice);
  if (fp) {
    const r = await shCall(env, '/api/v1/recognize', { signature: fp.uri, samplems: fp.samplems, lyrics: true });
    if (r && (r.ok || (r.error && !/E_INVALID_SIGNATURE|E_MISSING_INPUT|E_INVALID_INPUT/.test(r.error.code || '')))) return r;
  }
  const pcmBytes = new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength);
  return shCall(env, '/api/v1/recognize', { pcm: b64url(pcmBytes), lyrics: true });
}

async function fetchBounded(url, maxBytes = 20 * 1024 * 1024) {
  const r = await fetch(url, { headers: { Accept: '*/*' } });
  if (!r.ok) throw new Error(`media fetch failed: ${r.status}`);
  const length = Number(r.headers.get('content-length') || 0);
  if (length > maxBytes) throw new Error('media too large');
  if (!r.body) {
    const b = new Uint8Array(await r.arrayBuffer());
    if (b.byteLength > maxBytes) throw new Error('media too large');
    return b;
  }
  const reader = r.body.getReader(), chunks = [], total = 0;
  let n = total;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      n += part.value.byteLength;
      if (n > maxBytes) { await reader.cancel(); throw new Error('media too large'); }
      chunks.push(part.value);
    }
  } finally { try { reader.releaseLock(); } catch (_) {} }
  const out = new Uint8Array(n); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}
function sniffExt(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'wav';            // RIFF
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'ogg';            // OggS
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3';                             // ID3
  if ((b[0] === 0xff) && ((b[1] & 0xe0) === 0xe0)) return 'mp3';                                  // MP3 frame sync
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'mp4';            // ftyp
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';           // EBML
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return 'flac';           // fLaC
  return null;
}
function mediaExt(path, mime, fallback = 'bin', bytes = null) {
  const sniffed = sniffExt(bytes);
  if (sniffed) return sniffed;
  const m = String(mime || '').toLowerCase();
  if (m.includes('ogg')) return 'ogg'; if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4')) return 'mp4'; if (m.includes('webm')) return 'webm'; if (m.includes('wav')) return 'wav';
  if (m.includes('flac')) return 'flac'; if (m.includes('aac') || m.includes('x-m4a')) return 'm4a';
  const x = String(path || '').split('?')[0].split('.').pop();
  return /^[a-z0-9]{2,5}$/i.test(x || '') ? x.toLowerCase() : fallback;
}
function pcmToWav(pcmBytes, rate = 16000, channels = 1, bits = 16) {
  const dataSize = pcmBytes.byteLength;
  const out = new Uint8Array(44 + dataSize), dv = new DataView(out.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); str(8, 'WAVEfmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, channels, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * channels * bits / 8, true); dv.setUint16(32, channels * bits / 8, true);
  dv.setUint16(34, bits, true); str(36, 'data'); dv.setUint32(40, dataSize, true); out.set(pcmBytes, 44);
  return out;
}
function wavToPcmAndRate(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length < 44 || String.fromCharCode(...b.subarray(0, 4)) !== 'RIFF') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = String.fromCharCode(...b.subarray(off, off + 4));
    const sz = dv.getUint32(off + 4, true);
    if (id === 'fmt ') fmt = { format: dv.getUint16(off + 8, true), channels: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
    if (id === 'data') { data = b.subarray(off + 8, off + 8 + sz); break; }
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16) return null;
  return { pcm: new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2)), rate: fmt.rate, channels: fmt.channels };
}
function resampleTo16kMono(pcm, rate, channels) {
  let mono = pcm;
  if (channels > 1) {
    mono = new Int16Array(Math.floor(pcm.length / channels));
    for (let i = 0; i < mono.length; i++) { let s = 0; for (let c = 0; c < channels; c++) s += pcm[i * channels + c]; mono[i] = Math.round(s / channels); }
  }
  if (rate === 16000) return mono;
  const ratio = 16000 / rate, out = new Int16Array(Math.floor(mono.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const src = i / ratio, i0 = Math.floor(src), i1 = Math.min(i0 + 1, mono.length - 1), frac = src - i0;
    out[i] = Math.round(mono[i0] * (1 - frac) + mono[i1] * frac);
  }
  return out;
}
async function recognizeBytes(env, bytes, filename, mime, remoteUrl) {
  // 1) WAV fast-path: decode locally, fingerprint, recognize.
  const pcm = await mediaToPcm(env, bytes, filename, mime);
  if (pcm && pcm.length > 1600) {
    const rec = await shRecognizePcm(env, pcm);
    if (rec && (rec.ok || (rec.error && rec.error.code !== 'E_NO_MATCH'))) return rec;
    if (rec && rec.error && rec.error.code === 'E_NO_MATCH') return rec; // definitive no-match
  }
  // 2) WAV bytes can also go directly through multipart (worker decodes WAV).
  if (wavToPcmAndRate(bytes)) {
    const rec = await shMultipart(env, bytes, filename, 'audio/wav');
    if (rec && rec.ok) return rec;
  }
  // 3) Optional remote URL recognition (only when a backend exists).
  if (remoteUrl) {
    const rec = await shRecognizeUrl(env, remoteUrl);
    if (rec && (rec.ok || (rec.error && rec.error.code !== 'E_BACKEND_REQUIRED'))) return rec;
  }
  // 4) Last resort: raw upload (WAV accepted; others return a clear format error).
  return shMultipart(env, bytes, filename, mime);
}
function recognitionData(result) {
  const d = result && result.data ? result.data : result;
  if (!d || d.found !== true) return null;
  const t = d.track || d;
  const artist = t.artist || d.artist || t.subtitle || '';
  const title = t.title || d.title || t.name || '';
  return artist || title ? { ...d, artist, title } : null;
}
function recognitionFailure(result) {
  const code = result && result.error && result.error.code;
  if (code === 'E_BACKEND_REQUIRED') return '⚠️ سرویس تشخیص ویدیو هنوز به بک‌اند پردازش صدا متصل نیست. مدیر ربات باید BACKEND_URL را برای سرویس Shzm تنظیم کند.';
  if (code === 'E_PAYLOAD_TOO_LARGE') return '❌ حجم فایل برای تشخیص بیش از حد مجاز است.';
  if (code === 'E_RATE_LIMITED') return '⏳ درخواست‌های تشخیص زیاد است؛ کمی بعد دوباره امتحان کن.';
  if (code === 'E_UNSUPPORTED_FORMAT') return '❌ فرمت این فایل پشتیبانی نمی‌شود؛ فایل WAV یا فایل صوتی کوتاه‌تری بفرست.';
  return '❌ آهنگی در این فایل شناسایی نشد.';
}


async function igCall(env, p, params) {
  const base = v(env, 'INSTA_API_URL', FB.INSTA_API_URL).replace(/\/$/, '');
  const url = base + p + (params ? '?' + new URLSearchParams(params) : '');
  try { const r = await fetch(url, { headers: { Accept: 'application/json' } }); return await r.json(); }
  catch (e) { return { ok: false }; }
}

const welcomeText = (env, name) =>
  `🎧 <b>Music</b> | دستیار موزیک و دانلود\n\nسلام ${esc(name)} 👋 فقط کافیه چیزی بفرستی؛ بقیه‌اش با من 👇\n\n` +
  `🔎 <b>اسم خواننده یا آهنگ</b> ← فایل موزیک\n🎼 <b>یک خط از ترانه</b> ← پیدا کردن آهنگ\n` +
  `🎤 <b>ویس، ویدیو یا فایل صوتی</b> ← شناسایی آهنگ\n📸 <b>لینک اینستاگرام</b> ← ویدیو + موزیکش\n\n` +
  `💡 در هر چتی نام آهنگ را برای inline جستجو کن.\n@${v(env, 'BOT_USERNAME', FB.BOT_USERNAME)} اسم آهنگ`;

function menu(env, isOwner) {
  const user = v(env, 'BOT_USERNAME', FB.BOT_USERNAME);
  const chan = v(env, 'CHANNEL', FB.CHANNEL).replace('@', '');
  const rows = [
    [URLB('➕ افزودن به گروه', `https://t.me/${user}?startgroup=true&admin=delete_messages+pin_messages`, 'success')],
    [URLB('📢 کانال اصلی', `https://t.me/${chan}`, 'primary'), B('🌐 زبان', 'm:lang')],
    [B('👥 دعوت دوستان', 'm:invite'), B('ℹ️ راهنما', 'm:help'), B('📞 پشتیبانی', 'm:support')],
  ];
  if (isOwner) rows.push([R('🛠 پنل مدیریت', 'a:panel')]);
  return kb(rows);
}

const isMp4 = (b) => b && b.length > 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70; // 'ftyp'

async function fetchTrackBytes(env, sidValue, maxBytes = 48 * 1024 * 1024) {
  const base = v(env, 'SOUNDCLOUD_API_URL', FB.SOUNDCLOUD_API_URL).replace(/\/$/, '');
  for (const ep of ['/api/v1/stream', '/api/v1/download']) {
    try {
      const bytes = await fetchBounded(`${base}${ep}?id=${encodeURIComponent(sidValue)}`, maxBytes);
      // Reject JSON-mode bodies (browser/HLS manifests) — they aren't media.
      if (bytes && bytes.length && !(bytes[0] === 0x7b || (bytes[0] === 0xef && bytes[1] === 0xbb))) return bytes;
    } catch (_) {}
  }
  return null;
}

// Remux a fragmented MP4 (SoundCloud HLS) to progressive MP4 in memory so the
// Telegram player reads the full timeline instead of truncating at ~12s.
function normalizeMp4(bytes, { title, artist } = {}) {
  if (!isMp4(bytes)) return bytes;
  try {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = remuxMp4(buf, { title, artist });
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch (_) { return bytes; }
}

async function sendTrack(env, tg, cid, tr) {
  const sv = sid(tr), sb = v(env, 'SOUNDCLOUD_API_URL', FB.SOUNDCLOUD_API_URL).replace(/\/$/, '');
  const title = tr.title || '', perf = tr.artist || '', dur = Math.round((tr.duration_ms || 0) / 1000) || undefined;
  const cap = `🎵 <b>${esc(title)}</b>\n👤 <b>${esc(perf)}</b>`;
  // 1) URL-send the worker's assembled file. If Telegram accepts an `audio`
  //    object we're done — no bytes pass through us.
  for (const ep of ['/api/v1/stream', '/api/v1/download']) {
    const r = await tg.sendAudio(cid, `${sb}${ep}?id=${encodeURIComponent(sv)}`, { title, performer: perf, duration: dur, caption: cap });
    if (r && r.ok && r.result && r.result.audio) return true;
    if (r && r.ok && r.result && !r.result.audio) { try { await tg.deleteMessage(cid, r.result.message_id); } catch (_) {} }
  }
  // 2) Fetch + remux fragmented MP4 to progressive, then upload as a real audio.
  const bytes = await fetchTrackBytes(env, sv);
  if (bytes && bytes.byteLength) {
    const prog = normalizeMp4(bytes, { title, artist: perf });
    const fname = (`${perf ? perf + ' - ' : ''}${title}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || 'track') + '.mp3';
    const r = await tg.sendAudioBytes(cid, prog, fname, { title, performer: perf, duration: dur, caption: cap });
    if (r && r.ok && r.result && r.result.audio) return true;
    if (r && r.ok && r.result) { try { await tg.deleteMessage(cid, r.result.message_id); } catch (_) {} }
  }
  return false;
}

const igButtons = (text) => {
  const q = b64url(enc.encode(text));
  return kb([[G('🎬 دریافت فایل(ها)', `igf:${q}`)], [G('🎤 شناسایی موزیک ویدیو', `igr:${q}`)]]);
};

const cleanUrl = (u) => String(u || '').replace(/[?&](igsh|igshid|utm_[a-z_]+|dlrf)=[^&]*/gi, '').replace(/[?&]$/, '');
const igErr = (r) => (r && r.error && (r.error.message_fa || r.error.message)) || '❌ پردازش این لینک ممکن نشد';

async function igFetch(env, tg, cid, urlb) {
  const url = cleanUrl(new TextDecoder().decode(fromB64url(urlb)));
  const r = await igCall(env, '/api/v1/resolve', { url });
  if (!r || !r.ok) return tg.sendMessage(cid, igErr(r));
  const items = (r.data && r.data.items) || r.items || [];
  let sent = 0;
  for (const it of items) {
    const variants = it.variants || [];
    const vit = variants.find((x) => x && x.url && (/video/i.test(x.mime || '') || it.type === 'video')) || variants.find((x) => x && x.url);
    if (!vit) continue;
    const isVid = it.type === 'video' || /video/i.test(vit.mime || '');
    const r2 = isVid ? await tg.sendVideo(cid, vit.url, { caption: '🎬 Instagram' })
                     : await tg.sendPhoto(cid, vit.url, { caption: '🖼 Instagram' });
    if (r2 && r2.ok) sent++;
  }
  if (!sent) await tg.sendMessage(cid, '❌ چیزی برای ارسال پیدا نشد');
}

async function igRecognize(env, tg, cid, urlb) {
  const url = cleanUrl(new TextDecoder().decode(fromB64url(urlb)));
  const r = await igCall(env, '/api/v1/resolve', { url });
  if (!r || !r.ok) return tg.sendMessage(cid, igErr(r));
  const items = (r.data && r.data.items) || r.items || [];
  const it = items.find((x) => x.type === 'video' || (x.variants || []).some((vv) => /video/i.test(vv.mime || '')));
  if (!it) return tg.sendMessage(cid, '❌ ویدیو پیدا نشد');
  const variants = it.variants || [];
  const vit = variants.find((x) => x.url && /video/i.test(x.mime || '') && x.has_audio !== false)
    || variants.find((x) => x.url && /video/i.test(x.mime || ''))
    || variants.find((x) => x.url);
  if (!vit) return tg.sendMessage(cid, '❌ فایل ویدیو پیدا نشد');
  const media = await fetchBounded(vit.url);
  const filename = `instagram.${mediaExt(vit.url, vit.mime, 'mp4')}`;
  const rec = await recognizeBytes(env, media, filename, vit.mime || 'video/mp4', vit.url);
  const d2 = recognitionData(rec);
  if (!d2) return tg.sendMessage(cid, recognitionFailure(rec));
  const q2 = `${d2.artist} ${d2.title}`.trim();
  const sr = await scCall(env, '/api/v1/search', { q: q2 });
  const tr2 = (sr && sr.ok && sr.results || [])[0];
  if (tr2) {
    const sent = await sendTrack(env, tg, cid, tr2);
    if (sent) return tg.sendMessage(cid, `🎤 <b>شناسایی شد و ارسال شد</b>\n🎵 ${esc(tr2.title)}\n👤 ${esc(tr2.artist)}`);
    return tg.sendMessage(cid, `🎤 شناسایی شد، اما ارسال آهنگ ناموفق بود.\n🎵 ${esc(d2.title)}\n👤 ${esc(d2.artist)}`);
  }
  return tg.sendMessage(cid, `🎤 شناسایی شد؛ در SoundCloud پیدا نشد.\n🎵 <b>${esc(d2.title)}</b>\n👤 ${esc(d2.artist)}`);
}

async function recognizeMedia(env, tg, cid, token, f) {
  const gf = await tg.getFile(f.file_id);
  if (!gf || !gf.ok || !gf.result || !gf.result.file_path) return tg.sendMessage(cid, '❌ خطا در دریافت فایل از تلگرام');
  if (gf.result.file_size && gf.result.file_size > 20 * 1024 * 1024)
    return tg.sendMessage(cid, '❌ حجم فایل بیش از حد مجاز است (حداکثر ۲۰ مگابایت).');
  const fileUrl = `https://api.telegram.org/file/bot${token}/${gf.result.file_path}`;
  const media = await fetchBounded(fileUrl).catch((e) => {
    if (String(e.message || '').includes('too large')) return null;
    throw e;
  });
  if (!media) return tg.sendMessage(cid, '❌ حجم فایل بیش از حد مجاز است (حداکثر ۲۰ مگابایت).');
  const ext = mediaExt(gf.result.file_path, f.mime_type, 'bin', media);
  const mime = f.mime_type || (f.kind === 'voice' || f.kind === 'audio' ? (ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg') : (ext === 'mp4' ? 'video/mp4' : `audio/${ext}`));
  const filename = `telegram.${ext}`;
  const rec = await recognizeBytes(env, media, filename, mime, fileUrl);
  const d2 = recognitionData(rec);
  if (!d2) return tg.sendMessage(cid, recognitionFailure(rec));
  const q2 = `${d2.artist} ${d2.title}`.trim();
  const sr = await scCall(env, '/api/v1/search', { q: q2 });
  const tr3 = (sr && sr.ok && sr.results || [])[0];
  if (tr3) {
    const sent = await sendTrack(env, tg, cid, tr3);
    if (sent) return tg.sendMessage(cid, `🎤 <b>شناسایی شد و ارسال شد</b>\n🎵 ${esc(tr3.title)}\n👤 ${esc(tr3.artist)}`);
    return tg.sendMessage(cid, `🎤 شناسایی شد، اما ارسال آهنگ ناموفق بود.\n🎵 ${esc(d2.title)}\n👤 ${esc(d2.artist)}`);
  }
  return tg.sendMessage(cid, `🎤 شناسایی شد؛ در SoundCloud پیدا نشد.\n🎵 <b>${esc(d2.title)}</b>\n👤 ${esc(d2.artist)}`);
}

async function searchAndList(env, tg, cid, q) {
  const sr = await scCall(env, '/api/v1/search', { q });
  const res = (sr && sr.ok && sr.results) || [];
  if (!res.length) return tg.sendMessage(cid, '❌ چیزی پیدا نشد');
  const rows = res.slice(0, 10).map((tr) =>
    [G(`${(tr.artist || '')} — ${tr.title || ''}`.slice(0, 60), `dl:${sid(tr)}`)]);
  return tg.sendMessage(cid, `🔎 نتایج «${esc(q)}»\nروی موزیک کلیک کن تا مستقیم ارسال شه:`, { reply_markup: kb(rows) });
}

async function handle(env, u) {
  const token = v(env, 'BOT_TOKEN', '');
  if (!token) return;
  const tg = new TG(token);
  const owner = Number(v(env, 'OWNER_ID', '0'));

  if (u.callback_query) {
    const cq = u.callback_query, cid = cq.message.chat.id, mid = cq.message.message_id;
    const from = cq.from || {}, data = cq.data || '';
    const ans = (t, a) => tg.answerCallbackQuery(cq.id, { text: t, show_alert: !!a });

    if (data.startsWith('dl:')) {
      await ans('⏳ در حال ارسال...');
      const tr = await scCall(env, '/api/v1/track', { id: data.slice(3) }).then((d) => d && d.ok && d.track);
      if (!tr) return ans('خطا', true);
      await sendTrack(env, tg, cid, tr);
      return;
    }
    if (data.startsWith('igf:')) { await ans('⏳'); await igFetch(env, tg, cid, data.slice(4)).catch(() => ans('خطا', true)); return; }
    if (data.startsWith('igr:')) { await ans('🎤 شناسایی...'); await igRecognize(env, tg, cid, data.slice(4)).catch(() => ans('خطا', true)); return; }

    if (data === 'm:home' || data === 'nav:back')
      return tg.editMessageText(cid, mid, welcomeText(env, from.first_name || ''), { reply_markup: menu(env, from.id === owner) });
    if (data === 'm:lang')
      return tg.editMessageText(cid, mid, '🌐 زبان را انتخاب کن:', { reply_markup: kb([[G('فارسی', 'lang:fa'), B('English', 'lang:en')], [R('🔙 بازگشت', 'm:home')]]) });
    if (data === 'lang:fa' || data === 'lang:en')
      return tg.editMessageText(cid, mid, welcomeText(env, from.first_name || ''), { reply_markup: menu(env, from.id === owner) });
    if (data === 'm:invite') {
      const link = `https://t.me/${v(env, 'BOT_USERNAME', FB.BOT_USERNAME)}?start=ref_${from.id}`;
      const share = `https://t.me/share/url?url=${encodeURIComponent(link)}`;
      return tg.editMessageText(cid, mid, `👥 <b>دعوت دوستان</b>\n\n<code>${esc(link)}</code>`,
        { reply_markup: kb([[URLB('📤 اشتراک لینک', share, 'success')], [R('🔙 بازگشت', 'm:home')]]) });
    }
    if (data === 'm:support')
      return tg.editMessageText(cid, mid, `💬 <b>پشتیبانی</b>\n\n@${v(env, 'OWNER_USERNAME', FB.OWNER_USERNAME)}`, { reply_markup: kb([[R('🔙 بازگشت', 'm:home')]]) });
    if (data === 'm:help')
      return tg.editMessageText(cid, mid, 'ℹ️ <b>راهنما</b>\n\n🔎 اسم آهنگ بفرست\n🎤 ویس/ویدیو بفرست تا شناسایی و ارسال شه\n📸 لینک اینستاگرام بفرست و فایل یا شناسایی رو انتخاب کن', { reply_markup: kb([[R('🔙 بازگشت', 'm:home')]]) });
    if (data === 'a:panel' && from.id === owner)
      return tg.editMessageText(cid, mid, '🛠 <b>پنل مدیریت</b>\n\nربات روی Cloudflare فعال است.', { reply_markup: kb([[R('🔙 بازگشت', 'm:home')]]) });
    return ans();
  }

  const m = u.message || {};
  if (!m.chat) return;
  const cid = m.chat.id, from = m.from || {};
  const text = String(m.text || m.caption || '').trim();

  if (text.startsWith('/start'))
    return tg.sendMessage(cid, welcomeText(env, from.first_name || ''), { reply_markup: menu(env, from.id === owner) });

  if (/instagram\.com|instagr\.am/i.test(text))
    return tg.sendMessage(cid, '📸 لینک اینستاگرام\n\nانتخاب کن:', { reply_markup: igButtons(text) });

  if (text) {
    if (m.voice || m.audio || m.video || m.video_note || m.document) {
      const f = m.voice || m.audio || m.video || m.video_note || m.document;
      if (f.file_id) {
        await tg.sendChatAction(cid, 'typing');
        return recognizeMedia(env, tg, cid, token, { ...f, kind: m.voice ? 'voice' : m.audio ? 'audio' : (m.video || m.video_note) ? 'video' : 'document' });
      }
    }
    await tg.sendChatAction(cid, 'typing');
    return searchAndList(env, tg, cid, text);
  }

  if (m.voice || m.audio || m.video || m.video_note || m.document) {
    const f = m.voice || m.audio || m.video || m.video_note || m.document;
    if (!f.file_id) return tg.sendMessage(cid, '❌ فایل پیوست‌شده قابل دریافت نیست.');
    await tg.sendChatAction(cid, 'typing');
    return recognizeMedia(env, tg, cid, token, { ...f, kind: m.voice ? 'voice' : m.audio ? 'audio' : (m.video || m.video_note) ? 'video' : 'document' });
  }
}

async function activate(env, origin) {
  const token = v(env, 'BOT_TOKEN', '');
  if (!token) return { ok: false, error: 'BOT_TOKEN missing' };
  const tg = new TG(token);
  const secret = v(env, 'WEBHOOK_SECRET', FB.WEBHOOK_SECRET);
  const whp = '/wh/' + (await sha256Hex(secret)).slice(0, 24);
  const wh = origin.replace(/\/$/, '') + whp;
  try { await tg.deleteWebhook(); } catch (e) {}
  const res = await tg.setWebhook(wh, { secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
  const owner = Number(v(env, 'OWNER_ID', '0'));
  if (owner) try { await tg.sendMessage(owner, `✅ فعال شد\n${wh}`); } catch (e) {}
  return { ok: !!res.ok, wh, result: res };
}

const INDEX_HTML = `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Music Bot</title><body style="font-family:system-ui,Tahoma;text-align:center;margin-top:12%;background:#0d1117;color:#e6edf3"><h2>🎧 Music Bot</h2><p>Telegram music bot on Cloudflare Workers.</p><p><a style="color:#58a6ff" href="/activate">فعال‌سازی وب‌هوک /activate</a> · <a style="color:#58a6ff" href="/health">/health</a></p></body></html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let p = url.pathname.replace(/\/+$/, ''); if (p === '') p = '/';
    const token = v(env, 'BOT_TOKEN', '');
    const secret = v(env, 'WEBHOOK_SECRET', FB.WEBHOOK_SECRET);
    const whp = '/wh/' + (await sha256Hex(secret)).slice(0, 24);

    if (p === '/activate' || p === '/init' || p === '/setup')
      return new Response(JSON.stringify(await activate(env, url.origin), null, 2), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

    if (p === '/health') {
      if (!token) return new Response(JSON.stringify({ ok: false, token: false, error: 'BOT_TOKEN missing' }), { status: 503, headers: { 'content-type': 'application/json' } });
      try {
        const tg = new TG(token);
        const wi = await tg.getWebhookInfo();
        const me = await tg.getMe();
        return new Response(JSON.stringify({ ok: true, token: !!token, me: me.result || null, webhook: wi.result || wi }), { headers: { 'content-type': 'application/json' } });
      } catch (e) { return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { 'content-type': 'application/json' } }); }
    }

    if (p === '/')
      return new Response(INDEX_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });

    if (p === whp) {
      if (request.method === 'GET') return new Response('ok', { status: 200 });
      if (request.method !== 'POST') return new Response('method', { status: 405 });
      const tok = request.headers.get('x-telegram-bot-api-secret-token') || '';
      if (tok !== secret) return new Response('forbidden', { status: 403 });
      try {
        const u = await request.json();
        ctx.waitUntil(handle(env, u).catch(() => {}));
        return new Response('ok', { status: 200 });
      } catch (e) { return new Response('bad', { status: 400 }); }
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // Keep-alive: re-assert webhook if it drifted (cheap getWebhookInfo).
    try {
      const token = v(env, 'BOT_TOKEN', '');
      if (!token) return;
      const tg = new TG(token);
      const wi = await tg.getWebhookInfo();
      const secret = v(env, 'WEBHOOK_SECRET', FB.WEBHOOK_SECRET);
      const want = '/wh/' + (await sha256Hex(secret)).slice(0, 24);
      const pub = v(env, 'PUBLIC_URL', '');
      if (pub && wi && wi.result && !String(wi.result.url || '').includes(want))
        await activate(env, pub);
    } catch (e) {}
  },
};
