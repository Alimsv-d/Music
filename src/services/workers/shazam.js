/**
 * =============================================================================
 *  Shzm · Shazam Music Recognition Worker  (Cloudflare Workers · single file)
 * =============================================================================
 *  Author / Maintainer : Ali Mousavi  ·  Telegram : @AliMsvD
 *  License             : MIT
 *
 *  A production-grade, dependency-free music recognition service:
 *    • fingerprinting (Shazam signature algorithm, byte-compatible with
 *      the reference Python implementation used by the original service)
 *    • recognition from a pre-computed fingerprint, raw PCM, or WAV upload
 *    • recognition from a video URL (delegated to an optional Python backend)
 *    • text / lyrics based search across iTunes, Deezer, MusicBrainz, lyrics.ovh
 *    • bilingual (fa/en) JSON API under /api/v1 with stable error codes
 *    • a full bilingual web UI (microphone, upload, URL, text search) with
 *      light/dark themes, animations and inline API documentation
 *
 *  Everything lives in this single file on purpose: the project can be
 *  deployed by copying one file, and the Cloudflare "Deploy to Cloudflare"
 *  button works without any build step.
 * =============================================================================
 */

/* ---------------------------------------------------------------------------
 * 1 · Service identity & runtime configuration
 * ------------------------------------------------------------------------- */

const CREATOR = Object.freeze({
  name: 'Ali Mousavi',
  id: '@AliMsvD',
  telegram: '@AliMsvD',
  handle: 'AliMsvD',
  role: 'Developer & Maintainer',
});

const APP_INFO = Object.freeze({
  name: 'Shzm',
  name_fa: 'شزم',
  title: 'Shzm Music Recognition API',
  title_fa: 'وب‌سرویس تشخیص هوشمند موزیک',
  version: '3.0.0',
  license: 'MIT',
  description:
    'Professional music recognition service: identify songs from audio, ' +
    'voice recordings, video files and lyrics/text, with rich metadata.',
  description_fa:
    'سرویس حرفه‌ای تشخیص موزیک: شناسایی آهنگ از روی صدا، ضبط ویس، ' +
    'فایل ویدیویی و متن/ترانه، همراه با جزئیات کامل و سرعت بالا.',
});

/** Hard limits (kept identical in spirit to the Python service). */
const LIMITS = Object.freeze({
  /** Maximum accepted request body for the recognition endpoint. */
  maxUploadBytes: 25 * 1024 * 1024,
  /** Maximum length (seconds) of audio that is fingerprinted. */
  maxAudioSeconds: 12,
  /** Absolute maximum number of PCM samples accepted (16 kHz mono). */
  maxPcmSamples: 16000 * 60,
  /** Maximum length of the search query. */
  maxQueryLength: 300,
  /** Maximum number of search results. */
  maxResults: 25,
  /** Cache lifetime for recognition results (seconds). */
  cacheTtlSeconds: 60 * 60 * 24,
  /** Cache lifetime for text searches (seconds). */
  searchCacheTtlSeconds: 60 * 60 * 6,
  /** Maximum size (bytes) of a lyrics payload we keep. */
  maxLyricsBytes: 96 * 1024,
  /** Maximum size (bytes) of a media file fetched from a remote video URL. */
  maxRemoteBytes: 25 * 1024 * 1024,
});

/** Content types accepted by the (optional) raw-media path. */
const ALLOWED_AUDIO_MIME = Object.freeze([
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
  'audio/l16',
  'audio/pcm',
  'audio/L16',
]);

/** Signature magic prefix used by the Shazam binary format. */
const SIGNATURE_URI_PREFIX = 'data:audio/vnd.shazam.sig;base64,';

/** User agent used for every outgoing request made by this Worker. */
const USER_AGENT =
  `Shzm/${APP_INFO.version} (+https://github.com/AliMsvD/Shazam; developer:${CREATOR.id})`;

/** Shazam discovery endpoint (unofficial, key free). */
const SHAZAM_DISCOVERY = 'https://amp.shazam.com/discovery/v5/en/US/{device}/-/tag/{u1}/{u2}'
  + '?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3'
  + '&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3';

/** Shazam track endpoint (used to enrich a match by id). */
const SHAZAM_TRACK = 'https://www.shazam.com/discovery/v5/en/US/web/-/track/{id}'
  + '?shazamapiversion=v3&video=v3';

/** Rotating device identifiers accepted by the Shazam discovery API. */
const SHAZAM_DEVICES = ['iphone', 'android', 'web'];

/** Mobile-ish user agents (the Shazam API rejects obvious bots). */
const SHAZAM_USER_AGENTS = [
  'Dalvik/2.1.0 (Linux; U; Android 13; SM-S918B Build/TP1A.220624.014)',
  'Dalvik/2.1.0 (Linux; U; Android 12; SM-G991B Build/SP1A.210812.016)',
  'Dalvik/2.1.0 (Linux; U; Android 11; Pixel 5 Build/RQ3A.210805.001.A1)',
];

/** Country used for the metadata look-ups (iTunes / Deezer / MusicBrainz). */
const ITUNES_COUNTRY = 'US';

/* ---------------------------------------------------------------------------
 * 2 · Bilingual message catalogue
 * ------------------------------------------------------------------------- */

/**
 * Every user facing string exists in Persian and English.
 * `message` is always English, `message_fa` is always Persian, so a client can
 * pick the field it needs without parsing the `lang` parameter.
 */
const I18N = Object.freeze({
  // generic
  bad_request: ['The request could not be understood.', 'درخواست قابل درک نبود.'],
  missing_input: [
    'No audio, fingerprint or query was supplied.',
    'هیچ فایل صوتی، اثر انگشت یا عبارتی ارسال نشد.',
  ],
  invalid_input: ['Invalid input.', 'ورودی نامعتبر است.'],
  invalid_signature: [
    'The supplied fingerprint is malformed.',
    'اثر انگشت ارسالی نامعتبر یا ناقص است.',
  ],
  unsupported_format: [
    'Unsupported media format. The Worker can only decode WAV natively; ' +
      'send a pre-computed fingerprint or configure BACKEND_URL.',
    'فرمت رسانه پشتیبانی نمی‌شود. Worker فقط WAV را به‌صورت بومی رمزگشایی می‌کند؛ ' +
      'اثر انگشت آماده بفرستید یا BACKEND_URL را تنظیم کنید.',
  ],
  payload_too_large: [
    'The uploaded payload is larger than the allowed maximum.',
    'حجم داده ارسالی بیش از حد مجاز است.',
  ],
  not_found: ['The requested endpoint does not exist.', 'مسیر درخواستی یافت نشد.'],
  no_match: [
    'No matching song was found for this input.',
    'آهنگی با این ورودی پیدا نشد. نمونهٔ واضح‌تری امتحان کنید.',
  ],
  rate_limited: [
    'Too many requests. Please slow down and try again shortly.',
    'تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.',
  ],
  backend_required: [
    'This feature requires BACKEND_URL to be configured on the Worker.',
    'این قابلیت به متغیر محیطی BACKEND_URL نیاز دارد.',
  ],
  backend_error: [
    'The optional backend could not complete the request.',
    'بک‌اند اختیاری نتوانست درخواست را تکمیل کند.',
  ],
  upstream_error: [
    'An upstream provider failed to answer.',
    'یکی از سرویس‌های بیرونی پاسخ نداد.',
  ],
  internal_error: [
    'An unexpected error occurred while processing the request.',
    'خطای غیرمنتظره هنگام پردازش درخواست رخ داد.',
  ],
  signature_required: [
    'Raw audio needs server-side fingerprinting. Send a fingerprint, raw PCM ' +
      'or a WAV file, or set SIGNATURE_MODE=worker on a plan with enough CPU time.',
    'پردازش صدای خام نیازمند اثرانگشت‌گذاری سمت سرور است. اثر انگشت، PCM خام یا ' +
      'فایل WAV بفرستید، یا روی پلنی با CPU کافی SIGNATURE_MODE=worker را تنظیم کنید.',
  ],
  url_not_allowed: [
    'The supplied URL is not allowed (private, local or non-HTTP target).',
    'آدرس ارسالی مجاز نیست (خصوصی، محلی یا غیر HTTP).',
  ],
  url_invalid: ['The supplied URL is not a valid absolute http(s) URL.', 'آدرس ارسالی معتبر نیست.'],
  ok: ['Request completed.', 'درخواست با موفقیت انجام شد.'],
});

/**
 * Maps the public error codes to their catalogue entries.
 */
const ERROR_I18N_KEYS = Object.freeze({
  E_BAD_REQUEST: 'bad_request',
  E_INVALID_INPUT: 'invalid_input',
  E_MISSING_INPUT: 'missing_input',
  E_INVALID_SIGNATURE: 'invalid_signature',
  E_UNSUPPORTED_FORMAT: 'unsupported_format',
  E_PAYLOAD_TOO_LARGE: 'payload_too_large',
  E_NOT_FOUND: 'not_found',
  E_NO_MATCH: 'no_match',
  E_RATE_LIMITED: 'rate_limited',
  E_URL_INVALID: 'url_invalid',
  E_URL_NOT_ALLOWED: 'url_not_allowed',
  E_BACKEND_REQUIRED: 'backend_required',
  E_BACKEND_ERROR: 'backend_error',
  E_UPSTREAM_ERROR: 'upstream_error',
  E_INTERNAL: 'internal_error',
});

/**
 * Resolve a catalogue entry.
 * @param {string} key   catalogue key or public error code
 * @param {string} lang  'fa' | 'en'
 */
function t(key, lang) {
  const entry = I18N[ERROR_I18N_KEYS[key] || key] || I18N.internal_error;
  return lang === 'fa' ? entry[1] : entry[0];
}

/** Both languages of a catalogue entry, for API responses. */
function tPair(key, lang) {
  const entry = I18N[ERROR_I18N_KEYS[key] || key] || I18N.internal_error;
  const wanted = lang === 'fa' ? entry[1] : entry[0];
  return { message: wanted, message_fa: entry[1] };
}

/* ---------------------------------------------------------------------------
 * 3 · Low level helpers
 * ------------------------------------------------------------------------- */

/** RFC4122 v4 UUID built on crypto.getRandomValues (works in Workers & browsers). */
function uuid4() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [];
  for (let i = 0; i < 16; i++) hex.push(b[i].toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
    hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' +
    hex.slice(10, 16).join('')
  );
}

/** SHA-256 hex digest of a string or byte buffer. */
async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/** Lowercase hex SHA-256 of a UTF-8 string (used for cache keys). */
async function hashKey(input) {
  return (await sha256Hex(input)).slice(0, 40);
}

/** UTF-8 safe JSON.stringify. */
function jsonStringify(value) {
  return JSON.stringify(value);
}

/** Clamp a number into a range. */
function clamp(n, min, max) {
  return n < min ? min : n > max ? max : n;
}

/** Safe JSON parse. */
function safeParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Fetch with a timeout; returns null on any failure. */
async function fetchJson(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) return null;
    const text = await res.text();
    return safeParse(text, null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch text (non JSON) with a timeout; returns null on failure. */
async function fetchText(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Promise.allSettled with a timeout guard – used for parallel provider calls. */
async function settleAll(promises) {
  const results = await Promise.allSettled(promises);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : null));
}

/** Format milliseconds as m:ss. */
function formatDuration(ms) {
  if (!ms || ms <= 0) return null;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Normalise a value to a trimmed string or null. */
function str(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

/** Extract the year from any of the date formats the providers return. */
function extractYear(value) {
  const s = str(value);
  if (!s) return null;
  const m = s.match(/(\d{4})/);
  return m ? m[1] : null;
}

/** Extract a full ISO-ish date (YYYY-MM-DD) when the provider exposes one. */
function extractDate(value) {
  const s = str(value);
  if (!s) return null;
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const y = s.match(/(\d{4})/);
  return y ? y[1] : null;
}

/* ---------------------------------------------------------------------------
 * 4 · Shazam fingerprinting engine  (shared between Worker and browser)
 * -------------------------------------------------------------------------
 * The block below is the *single source of truth* for the fingerprint
 * algorithm. It is written as a set of self-contained functions so that the
 * exact same source can be shipped to the browser as an ES module (see
 * `buildBrowserFingerprintModule`) without duplicating a single line.
 *
 * The implementation is byte-for-byte compatible with the reference Python
 * implementation (numpy `rfft`, Hanning window, Shazam peak spreading).
 * ------------------------------------------------------------------------- */

/** Hanning window used by the reference implementation (numpy hanning(2050)[1:-1]). */
function fpHanningWindow() {
  const size = 2048;
  const out = new Float64Array(size);
  const denom = 2049;
  for (let n = 1; n <= size; n++) {
    out[n - 1] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / denom);
  }
  return out;
}

/**
 * Pre-computed tables for the iterative radix-2 FFT.
 * The twiddle factors are built with exactly the same recurrence as the
 * reference implementation, so the results are bit-identical.
 */
function fpFftTables(n) {
  const levels = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let j = 0; j < levels; j++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r >>> 0;
  }
  const stages = [];
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const cr = new Float64Array(half);
    const ci = new Float64Array(half);
    let a = 1;
    let b = 0;
    for (let j = 0; j < half; j++) {
      cr[j] = a;
      ci[j] = b;
      const na = a * wr - b * wi;
      b = a * wi + b * wr;
      a = na;
    }
    stages.push({ len, half, cr, ci });
  }
  return { n, levels, rev, stages };
}

/** In-place iterative radix-2 FFT (forward, e^{-2πi kn/N}). */
function fpFft(re, im) {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new Error('fpFft: length must be a power of two');
  }
  let tables = fpFft._tables;
  if (!tables || tables.n !== n) {
    tables = fpFft._tables = fpFftTables(n);
  }
  const rev = tables.rev;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const stages = tables.stages;
  for (let s = 0; s < stages.length; s++) {
    const stage = stages[s];
    const half = stage.half;
    const cr = stage.cr;
    const ci = stage.ci;
    for (let i = 0; i < n; i += stage.len) {
      for (let j = 0; j < half; j++) {
        const wr = cr[j];
        const wi = ci[j];
        const p = i + j;
        const q = p + half;
        const vr = re[q] * wr - im[q] * wi;
        const vi = re[q] * wi + im[q] * wr;
        const ur = re[p];
        const ui = im[p];
        re[q] = ur - vr;
        im[q] = ui - vi;
        re[p] = ur + vr;
        im[p] = ui + vi;
      }
    }
  }
}

/** CRC-32 (zlib polynomial) over a byte buffer. */
function fpCrc32(bytes) {
  let table = fpCrc32._table;
  if (!table) {
    table = fpCrc32._table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** Dependency-free base64 encoder (works in Workers and in the browser). */
function fpBase64(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + chars[(n >> 6) & 63] + chars[n & 63];
  }
  const rest = len - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + chars[(n >> 6) & 63] + '=';
  }
  return out;
}

/**
 * Generates a Shazam fingerprint from 16 kHz mono PCM samples.
 * `feed()` accepts Int16Array / Float32Array / Float64Array / number[].
 */
class FpSignatureGenerator {
  constructor(options) {
    const opt = options || {};
    this.sampleRate = opt.sampleRate || 16000;
    this.maxTimeSeconds = opt.maxTimeSeconds || 12;
    this.maxPeaks = opt.maxPeaks || 255;
    this.fftSize = 2048;
    this.binCount = 1025;
    this.hopSize = 128;

    this.input = new Float64Array(65536);
    this.inputLength = 0;
    this.samplesProcessed = 0;

    this.ring = new Float64Array(this.fftSize);
    this.ringPos = 0;

    this.re = new Float64Array(this.fftSize);
    this.im = new Float64Array(this.fftSize);
    this.window = fpHanningWindow();

    this.fftOut = new Array(256);
    for (let i = 0; i < 256; i++) this.fftOut[i] = new Float64Array(this.binCount);
    this.fftPos = 0;
    this.fftWritten = 0;

    this.spread = new Array(256);
    for (let i = 0; i < 256; i++) this.spread[i] = new Float64Array(this.binCount);
    this.spreadPos = 0;
    this.spreadWritten = 0;

    this.scratch1 = new Float64Array(this.binCount);
    this.scratch2 = new Float64Array(this.binCount);
    this.scratch3 = new Float64Array(this.binCount);
    this.scratch4 = new Float64Array(this.binCount);

    this.next = { sampleRate: this.sampleRate, numberSamples: 0, bands: new Map() };
  }

  /** Append samples to the pending input buffer. */
  feed(samples) {
    let arr;
    if (samples instanceof Float64Array) {
      arr = samples;
    } else if (samples instanceof Int16Array) {
      arr = new Float64Array(samples.length);
      for (let i = 0; i < samples.length; i++) arr[i] = samples[i];
    } else if (samples instanceof Float32Array) {
      arr = new Float64Array(samples.length);
      for (let i = 0; i < samples.length; i++) arr[i] = samples[i];
    } else {
      arr = Float64Array.from(samples);
    }
    const need = this.inputLength + arr.length;
    if (need > this.input.length) {
      let cap = this.input.length * 2;
      while (cap < need) cap *= 2;
      const next = new Float64Array(cap);
      next.set(this.input.subarray(0, this.inputLength));
      this.input = next;
    }
    this.input.set(arr, this.inputLength);
    this.inputLength += arr.length;
    return this;
  }

  /**
   * Skip the beginning of the pending input (used for long recordings where
   * the first seconds are usually silence / intro noise).
   */
  skipSamples(count) {
    this.samplesProcessed = Math.min(this.inputLength, this.samplesProcessed + count);
    return this;
  }

  /** Total number of peaks collected so far. */
  peakCount() {
    let total = 0;
    for (const arr of this.next.bands.values()) total += arr.length;
    return total;
  }

  doFft(offset, length) {
    const size = this.fftSize;
    const start = this.ringPos;
    for (let i = 0; i < length; i++) {
      this.ring[(start + i) % size] = this.input[offset + i];
    }
    this.ringPos = (start + length) % size;

    const re = this.re;
    const im = this.im;
    const ring = this.ring;
    const win = this.window;
    const rp = this.ringPos;
    for (let i = 0; i < size; i++) {
      re[i] = ring[(rp + i) % size] * win[i];
      im[i] = 0;
    }
    fpFft(re, im);

    const out = this.fftOut[this.fftPos];
    for (let i = 0; i < this.binCount; i++) {
      let v = (re[i] * re[i] + im[i] * im[i]) / 131072;
      if (v < 1e-10) v = 1e-10;
      out[i] = v;
    }
    this.fftPos = (this.fftPos + 1) & 255;
    this.fftWritten++;
  }

  doPeakSpreading() {
    const bins = this.binCount;
    const origin = this.fftOut[(this.fftPos - 1 + 256) & 255];
    const s4 = this.scratch4;
    for (let i = 0; i < bins; i++) {
      const a = origin[i];
      const b = origin[(i + 1) % bins];
      const c = origin[(i + 2) % bins];
      s4[i] = a > b ? (a > c ? a : c) : b > c ? b : c;
    }
    const spreadOrigin = this.scratch3;
    for (let i = 0; i < bins - 3; i++) spreadOrigin[i] = s4[i];
    for (let i = bins - 3; i < bins; i++) spreadOrigin[i] = origin[i];

    const i1 = (this.spreadPos + 255) & 255;
    const i2 = (this.spreadPos + 253) & 255;
    const i3 = (this.spreadPos + 250) & 255;

    const r1 = this.scratch1;
    const r2 = this.scratch2;
    const r3 = this.scratch4;
    const b1 = this.spread[i1];
    const b2 = this.spread[i2];
    const b3 = this.spread[i3];
    for (let i = 0; i < bins; i++) {
      const v = spreadOrigin[i];
      r1[i] = v > b1[i] ? v : b1[i];
    }
    for (let i = 0; i < bins; i++) {
      const v = r1[i];
      r2[i] = v > b2[i] ? v : b2[i];
    }
    for (let i = 0; i < bins; i++) {
      const v = r2[i];
      r3[i] = v > b3[i] ? v : b3[i];
    }
    this.spread[i1].set(r1);
    this.spread[i2].set(r2);
    this.spread[i3].set(r3);
    this.spread[this.spreadPos].set(spreadOrigin);
    this.spreadPos = (this.spreadPos + 1) & 255;
    this.spreadWritten++;
  }

  doPeakRecognition() {
    const bins = this.binCount;
    const f46 = this.fftOut[(this.fftPos - 46 + 256) & 255];
    const f49 = this.spread[(this.spreadPos - 49 + 256) & 255];
    const fftNumber = this.spreadWritten - 46;
    const NEIGH = [-10, -7, -4, -3, 1, 2, 5, 8];
    const OTHER = [-53, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249];

    for (let bin = 10; bin < 1015; bin++) {
      const v = f46[bin];
      if (!(v >= 1 / 64 && v >= f49[bin - 1])) continue;
      let maxN = 0;
      for (let k = 0; k < NEIGH.length; k++) {
        const nv = f49[bin + NEIGH[k]];
        if (nv > maxN) maxN = nv;
      }
      if (!(v > maxN)) continue;
      let maxO = maxN;
      for (let k = 0; k < OTHER.length; k++) {
        const nv = this.spread[(this.spreadPos + OTHER[k] + 512) & 255][bin - 1];
        if (nv > maxO) maxO = nv;
      }
      if (!(v > maxO)) continue;

      const peakMag = Math.log(v > 1 / 64 ? v : 1 / 64) * 1477.3 + 6144;
      const before = f46[bin - 1] > 1 / 64 ? f46[bin - 1] : 1 / 64;
      const after = f46[bin + 1] > 1 / 64 ? f46[bin + 1] : 1 / 64;
      const peakBefore = Math.log(before) * 1477.3 + 6144;
      const peakAfter = Math.log(after) * 1477.3 + 6144;
      const v1 = peakMag * 2 - peakBefore - peakAfter;
      if (v1 <= 0) continue;
      const v2 = ((peakAfter - peakBefore) * 32) / v1;
      const corrected = bin * 64 + v2;
      const hz = corrected * (16000 / 2 / 1024 / 64);
      let band;
      if (hz > 250 && hz < 520) band = 0;
      else if (hz > 520 && hz < 1450) band = 1;
      else if (hz > 1450 && hz < 3500) band = 2;
      else if (hz > 5500 && hz <= 5500) band = 3;
      else continue;

      let peaks = this.next.bands.get(band);
      if (!peaks) {
        peaks = [];
        this.next.bands.set(band, peaks);
      }
      peaks.push({
        fftPassNumber: fftNumber,
        peakMagnitude: Math.trunc(peakMag),
        correctedPeakFrequencyBin: Math.trunc(corrected),
        sampleRateHz: 16000,
      });
    }
  }

  /** Consume the pending input and produce the next fingerprint. */
  getNextSignature() {
    const hop = this.hopSize;
    while (
      this.inputLength - this.samplesProcessed >= hop &&
      (this.next.numberSamples / this.next.sampleRate < this.maxTimeSeconds ||
        this.peakCount() < this.maxPeaks)
    ) {
      this.next.numberSamples += hop;
      this.doFft(this.samplesProcessed, hop);
      this.doPeakSpreading();
      if (this.spreadWritten >= 46) this.doPeakRecognition();
      this.samplesProcessed += hop;
    }
    return this.next;
  }
}

/**
 * Serialise a fingerprint into the binary Shazam format.
 * @param {{numberSamples:number,sampleRate:number,bands:Map}} signature
 * @returns {Uint8Array}
 */
function fpEncodeSignature(signature) {
  const bandIds = Array.from(signature.bands.keys()).sort((a, b) => a - b);
  const chunks = [];
  let contentsLength = 0;

  for (const band of bandIds) {
    const peaks = signature.bands.get(band);
    const payload = new Uint8Array(peaks.length * 5);
    let off = 0;
    let fftPass = 0;
    for (const p of peaks) {
      if (p.fftPassNumber - fftPass >= 255) {
        payload[off++] = 0xff;
        payload[off++] = p.fftPassNumber & 0xff;
        payload[off++] = (p.fftPassNumber >>> 8) & 0xff;
        payload[off++] = (p.fftPassNumber >>> 16) & 0xff;
        payload[off++] = (p.fftPassNumber >>> 24) & 0xff;
        fftPass = p.fftPassNumber;
      }
      payload[off++] = p.fftPassNumber - fftPass;
      payload[off++] = p.peakMagnitude & 0xff;
      payload[off++] = (p.peakMagnitude >>> 8) & 0xff;
      payload[off++] = p.correctedPeakFrequencyBin & 0xff;
      payload[off++] = (p.correctedPeakFrequencyBin >>> 8) & 0xff;
      fftPass = p.fftPassNumber;
    }
    const head = new Uint8Array(8);
    const bandId = 0x60030040 + band;
    head[0] = bandId & 0xff;
    head[1] = (bandId >>> 8) & 0xff;
    head[2] = (bandId >>> 16) & 0xff;
    head[3] = (bandId >>> 24) & 0xff;
    head[4] = payload.length & 0xff;
    head[5] = (payload.length >>> 8) & 0xff;
    head[6] = (payload.length >>> 16) & 0xff;
    head[7] = (payload.length >>> 24) & 0xff;
    const padding = (4 - (payload.length % 4)) % 4;
    chunks.push(head, payload, new Uint8Array(padding));
    contentsLength += 8 + payload.length + padding;
  }

  const total = 48 + contentsLength + 8;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  // Raw signature header (48 bytes) – layout verified against the Python
  // ctypes structure used by the reference implementation.
  view.setUint32(0, 0xcafe2580, true); // magic1
  view.setUint32(4, 0, true); // crc32 placeholder
  view.setUint32(8, contentsLength + 8, true); // size_minus_header
  view.setUint32(12, 0x94119c00, true); // magic2
  // void1 [16..28)
  view.setUint32(28, (3 << 27) >>> 0, true); // shifted_sample_rate_id (16000 Hz)
  // void2 [32..40)
  view.setUint32(40, Math.trunc(signature.numberSamples + signature.sampleRate * 0.24), true);
  view.setUint32(44, ((15 << 19) + 0x40000) >>> 0, true); // fixed_value

  view.setUint32(48, 0x40000000, true);
  view.setUint32(52, contentsLength + 8, true);

  let pos = 56;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }

  const crc = fpCrc32(out.subarray(8));
  view.setUint32(4, crc, true);
  return out;
}

/**
 * Build the browser-side ES module from the shared functions above.
 * The generated module is served at `/static/fingerprint.js` so the web UI
 * can compute a fingerprint locally (which keeps the Worker inside the CPU
 * limits of every Cloudflare plan, including the free one).
 */
function buildBrowserFingerprintModule() {
  const sources = [
    fpHanningWindow,
    fpFftTables,
    fpFft,
    fpCrc32,
    fpBase64,
    FpSignatureGenerator,
    fpEncodeSignature,
  ];
  const body = sources.map((fn) => fn.toString()).join('\n\n');
  return (
    '/* Shzm fingerprint engine — auto-generated from worker.js (do not edit). */\n' +
    body +
    '\n\nexport { fpHanningWindow, fpFftTables, fpFft, fpCrc32, fpBase64, ' +
    'FpSignatureGenerator, fpEncodeSignature };\n'
  );
}

/**
 * Convenience wrapper: PCM samples → { uri, samplems, bytes }.
 * @param {Float64Array|Int16Array|number[]} samples 16 kHz mono samples
 */
function fpBuildSignatureUri(samples, options) {
  const opt = options || {};
  const generator = new FpSignatureGenerator(opt);
  generator.feed(samples);
  const duration = generator.inputLength / generator.sampleRate;
  if (duration > generator.maxTimeSeconds * 3) {
    generator.skipSamples(16000 * (Math.floor(duration / 2) - 6));
  }
  const signature = generator.getNextSignature();
  const bytes = fpEncodeSignature(signature);
  return {
    uri: SIGNATURE_URI_PREFIX + fpBase64(bytes),
    bytes,
    samplems: Math.trunc((signature.numberSamples / signature.sampleRate) * 1000),
    peaks: signature.bands.size
      ? Array.from(signature.bands.values()).reduce((a, b) => a + b.length, 0)
      : 0,
    numberSamples: signature.numberSamples,
  };
}

/* ---------------------------------------------------------------------------
 * 5 · Media helpers (WAV decoding, resampling, PCM utilities)
 * ------------------------------------------------------------------------- */

/** Convert bytes → base64 without blowing the argument limit. */
function bytesToBase64(bytes) {
  return fpBase64(bytes);
}

/** Convert base64 (optionally a data URI) → Uint8Array. */
function base64ToBytes(input) {
  let b64 = String(input || '').trim();
  const comma = b64.indexOf(',');
  if (b64.startsWith('data:') && comma !== -1) b64 = b64.slice(comma + 1);
  b64 = b64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error('invalid base64');
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const size = Math.floor((b64.length * 3) / 4) - padding;
  const out = new Uint8Array(size);
  let p = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i);
    let v;
    if (c >= 65 && c <= 90) v = c - 65;
    else if (c >= 97 && c <= 122) v = c - 71;
    else if (c >= 48 && c <= 57) v = c + 4;
    else if (c === 43) v = 62;
    else if (c === 47) v = 63;
    else if (c === 61) break;
    else continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, p);
}

/**
 * Decode a RIFF/WAVE buffer into { sampleRate, channels, bitsPerSample, samples }.
 * Only uncompressed PCM (format 1) and IEEE float (format 3) are supported,
 * which is exactly what a browser or `ffmpeg -f wav` produces.
 */
/**
 * Check that a fingerprint really is a Shazam signature (magic bytes + length).
 * Returns false for anything that could never be understood by the upstream.
 */
function isValidSignatureUri(signatureUri) {
  try {
    const raw = String(signatureUri || '');
    const comma = raw.indexOf(',');
    let payload = comma >= 0 ? raw.slice(comma + 1) : raw;
    payload = payload.replace(/\s+/g, '');
    if (!payload) return false;
    const bytes = base64ToBytes(payload);
    if (bytes.length < 56) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0xcafe2580) return false;
    if (view.getUint32(12, true) !== 0x94119c00) return false;
    return true;
  } catch {
    return false;
  }
}

function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset) =>
    String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );

  const fail = (reason, code) => Object.assign(new Error(reason), { code });
  if (bytes.length < 44) throw fail('wav_too_short', 'E_INVALID_INPUT');
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw fail('wav_not_riff', 'E_UNSUPPORTED_FORMAT');

  let pos = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;

  while (pos + 8 <= bytes.length) {
    const chunkId = tag(pos);
    const chunkSize = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (chunkId === 'data') {
      dataOffset = body;
      dataLength = Math.min(chunkSize, bytes.length - body);
    }
    pos = body + chunkSize + (chunkSize % 2);
  }

  if (!fmt) throw fail('wav_no_fmt', 'E_UNSUPPORTED_FORMAT');
  if (dataOffset < 0) throw fail('wav_no_data', 'E_UNSUPPORTED_FORMAT');
  if (!fmt.channels || !fmt.sampleRate) throw fail('wav_bad_fmt', 'E_UNSUPPORTED_FORMAT');
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3) {
    throw fail('wav_unsupported_codec', 'E_UNSUPPORTED_FORMAT');
  }

  const bytesPerSample = Math.max(1, Math.floor(fmt.bitsPerSample / 8));
  const frameCount = Math.floor(dataLength / (bytesPerSample * fmt.channels));
  const samples = new Float64Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const offset = dataOffset + (i * fmt.channels + c) * bytesPerSample;
      let value;
      if (fmt.audioFormat === 3) {
        if (fmt.bitsPerSample === 32) value = view.getFloat32(offset, true);
        else if (fmt.bitsPerSample === 64) value = view.getFloat64(offset, true);
        else throw fail('wav_unsupported_codec', 'E_UNSUPPORTED_FORMAT');
      } else if (fmt.bitsPerSample === 8) {
        value = (bytes[offset] - 128) / 128;
      } else if (fmt.bitsPerSample === 16) {
        value = view.getInt16(offset, true) / 32768;
      } else if (fmt.bitsPerSample === 24) {
        const b0 = bytes[offset];
        const b1 = bytes[offset + 1];
        const b2 = bytes[offset + 2];
        let v = (b2 << 16) | (b1 << 8) | b0;
        if (v & 0x800000) v -= 0x1000000;
        value = v / 8388608;
      } else if (fmt.bitsPerSample === 32) {
        value = view.getInt32(offset, true) / 2147483648;
      } else {
        throw fail('wav_unsupported_codec', 'E_UNSUPPORTED_FORMAT');
      }
      acc += value;
    }
    samples[i] = acc / fmt.channels;
  }

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    samples,
    durationMs: Math.round((frameCount / fmt.sampleRate) * 1000),
  };
}

/** Convert float samples in [-1,1] to Int16Array. */
function floatToInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let v = Math.round(samples[i] * 32767);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    out[i] = v;
  }
  return out;
}

/**
 * High quality resampler (windowed sinc, 16 taps per phase) with linear
 * fallback for upsampling. Used to bring arbitrary audio down to 16 kHz mono.
 */
function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = toRate / fromRate;
  if (ratio > 1) {
    // Upsampling: linear interpolation is enough (no aliasing to remove).
    const outLength = Math.floor(samples.length * ratio);
    const out = new Float64Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const src = i / ratio;
      const i0 = Math.floor(src);
      const frac = src - i0;
      const a = samples[Math.min(i0, samples.length - 1)];
      const b = samples[Math.min(i0 + 1, samples.length - 1)];
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  const TAPS = 16;
  const outLength = Math.floor(samples.length * ratio);
  const out = new Float64Array(outLength);
  const cutoff = Math.min(1, ratio) * 0.92;
  for (let i = 0; i < outLength; i++) {
    const center = i / ratio;
    const i0 = Math.floor(center);
    let acc = 0;
    let norm = 0;
    for (let k = -TAPS / 2 + 1; k <= TAPS / 2; k++) {
      const idx = i0 + k;
      if (idx < 0 || idx >= samples.length) continue;
      const x = center - idx;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x * cutoff) / (Math.PI * x);
      const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * (k + TAPS / 2 - 1)) / (TAPS - 1));
      const w = sinc * window;
      acc += samples[idx] * w;
      norm += w;
    }
    out[i] = norm !== 0 ? acc / norm : 0;
  }
  return out;
}

/**
 * Prepare arbitrary PCM for fingerprinting: mono + 16 kHz.
 * `scale` converts the incoming amplitude range into the signed 16 bit
 * range that the Shazam algorithm is calibrated for.
 */
function preparePcm(samples, sampleRate, scale) {
  const factor = scale === undefined ? 1 : scale;
  let source = samples;
  if (factor !== 1) {
    source = new Float64Array(samples.length);
    for (let i = 0; i < samples.length; i++) source[i] = samples[i] * factor;
  }
  const trimmed =
    source.length > sampleRate * 40 ? source.subarray(0, sampleRate * 40) : source;
  const resampled = resample(trimmed, sampleRate, 16000);
  return new Float64Array(resampled);
}

/* ---------------------------------------------------------------------------
 * 6 · External providers
 * ------------------------------------------------------------------------- */

/**
 * Send a fingerprint to the Shazam discovery endpoint.
 * @param {string} signatureUri  data URI with the binary signature
 * @param {number} samplems      analysed duration in milliseconds
 */
async function shazamRecognize(signatureUri, samplems) {
  const device = SHAZAM_DEVICES[Math.floor(Math.random() * SHAZAM_DEVICES.length)];
  const url = SHAZAM_DISCOVERY.replace('{device}', device)
    .replace('{u1}', uuid4().toUpperCase())
    .replace('{u2}', uuid4().toUpperCase());
  const payload = {
    timezone: 'Asia/Tehran',
    signature: { uri: signatureUri, samplems },
    timestamp: Date.now(),
    context: {},
    geolocation: {},
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shazam-Platform': 'IPHONE',
        'X-Shazam-AppVersion': '14.1.0',
        'X-Shazam-Device-Type': 'IPHONE',
        Accept: '*/*',
        'Accept-Language': 'en-US',
        'User-Agent': SHAZAM_USER_AGENTS[Math.floor(Math.random() * SHAZAM_USER_AGENTS.length)],
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    return safeParse(text, null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch a full Shazam track by id (used to enrich a match). */
async function shazamTrackById(id) {
  if (!id) return null;
  const url = SHAZAM_TRACK.replace('{id}', encodeURIComponent(id));
  const data = await fetchJson(url, {
    headers: {
      Accept: '*/*',
      'Accept-Language': 'en-US',
      'User-Agent': SHAZAM_USER_AGENTS[0],
      'X-Shazam-Platform': 'IPHONE',
      'X-Shazam-AppVersion': '14.1.0',
    },
  });
  return data && data.track ? data.track : data;
}

/** iTunes search. */
async function itunesSearch(term, limit, country) {
  const url =
    'https://itunes.apple.com/search?term=' +
    encodeURIComponent(term) +
    '&entity=song&limit=' +
    limit +
    '&country=' +
    (country || ITUNES_COUNTRY);
  const data = await fetchJson(url, { headers: { 'User-Agent': USER_AGENT } });
  return (data && data.results) || [];
}

/** iTunes lookup by ISRC. */
async function itunesLookupIsrc(isrc, country) {
  if (!isrc) return null;
  const url =
    'https://itunes.apple.com/lookup?isrc=' +
    encodeURIComponent(isrc) +
    '&entity=song&limit=5&country=' +
    (country || ITUNES_COUNTRY);
  const data = await fetchJson(url, { headers: { 'User-Agent': USER_AGENT } });
  const results = (data && data.results) || [];
  return results.length ? results[0] : null;
}

/** Best-effort iTunes match for a title/artist pair. */
async function itunesMatch(title, artist, country) {
  if (!title) return null;
  const term = (title + ' ' + (artist || '')).trim();
  const results = await itunesSearch(term, 5, country);
  const titleL = title.toLowerCase();
  const artistL = (artist || '').toLowerCase();
  for (const item of results) {
    if (titleL.indexOf(String(item.trackName || '').toLowerCase()) !== -1) {
      if (!artistL || String(item.artistName || '').toLowerCase().indexOf(artistL.split(/\s+/)[0]) !== -1) {
        return item;
      }
    }
  }
  return results.length ? results[0] : null;
}

/** Deezer search. */
async function deezerSearch(term, limit) {
  const url = 'https://api.deezer.com/search?q=' + encodeURIComponent(term) + '&limit=' + limit;
  const data = await fetchJson(url, { headers: { 'User-Agent': USER_AGENT } });
  return (data && data.data) || [];
}

/** Best-effort Deezer match for a title/artist pair. */
async function deezerMatch(title, artist) {
  if (!title) return null;
  const term = (title + ' ' + (artist || '')).trim();
  const results = await deezerSearch(term, 5);
  const titleL = title.toLowerCase();
  const artistL = (artist || '').toLowerCase();
  for (const item of results) {
    if (String(item.title || '').toLowerCase().indexOf(titleL) !== -1) {
      const name = String((item.artist && item.artist.name) || '').toLowerCase();
      if (!artistL || name.indexOf(artistL.split(/\s+/)[0]) !== -1) return item;
    }
  }
  return results.length ? results[0] : null;
}

/** MusicBrainz recording search. */
async function musicbrainzSearch(term, limit) {
  const url =
    'https://musicbrainz.org/ws/2/recording?query=' +
    encodeURIComponent(term) +
    '&fmt=json&limit=' +
    limit;
  const data = await fetchJson(
    url,
    {
      headers: {
        'User-Agent': USER_AGENT + ' ( https://github.com/AliMsvD/Shazam )',
        Accept: 'application/json',
      },
    },
    10000
  );
  return (data && data.recordings) || [];
}

/** lyrics.ovh suggestion list. */
async function lyricsOvhSuggest(term, limit) {
  const url = 'https://api.lyrics.ovh/suggest/' + encodeURIComponent(term);
  const data = await fetchJson(url, { headers: { 'User-Agent': USER_AGENT } }, 8000);
  const items = (data && data.data) || [];
  return items.slice(0, limit);
}

/** lyrics.ovh plain lyrics. */
async function lyricsOvhGet(artist, title) {
  if (!artist || !title) return null;
  const url =
    'https://api.lyrics.ovh/v1/' + encodeURIComponent(artist) + '/' + encodeURIComponent(title);
  const data = await fetchJson(url, { headers: { 'User-Agent': USER_AGENT } }, 8000);
  if (!data) return null;
  const lyrics = String(data.lyrics || '').trim();
  return lyrics || null;
}

/** LRCLIB plain lyrics (key free, requires a descriptive User-Agent). */
async function lrclibGet(artist, title) {
  if (!title) return null;
  const url =
    'https://lrclib.net/api/search?track_name=' +
    encodeURIComponent(title) +
    '&artist_name=' +
    encodeURIComponent(artist || '');
  const items = await fetchJson(
    url,
    { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } },
    8000
  );
  if (!Array.isArray(items) || !items.length) return null;
  const titleL = String(title).toLowerCase().trim();
  let best = null;
  for (const it of items) {
    if (it.instrumental) continue;
    if (String(it.trackName || '').toLowerCase().trim() === titleL) {
      best = it;
      break;
    }
    if (!best) best = it;
  }
  if (!best) return null;
  const text = String(best.plainLyrics || '').trim();
  return text || null;
}

/**
 * Fetch lyrics, trying lyrics.ovh first and LRCLIB second.
 * @returns {Promise<{text:string, source:string}|null>}
 */
async function getLyrics(artist, title) {
  if (!title) return null;
  let lyrics = await lyricsOvhGet(artist, title);
  let source = 'lyrics.ovh';
  if (!lyrics) {
    lyrics = await lrclibGet(artist, title);
    source = 'lrclib';
  }
  if (!lyrics && artist && /feat|,|&/i.test(artist)) {
    const short = artist.split(/feat|,|&/i)[0].trim();
    if (short && short.toLowerCase() !== artist.toLowerCase()) {
      lyrics = await lyricsOvhGet(short, title);
      source = 'lyrics.ovh';
      if (!lyrics) {
        lyrics = await lrclibGet(short, title);
        source = 'lrclib';
      }
    }
  }
  return lyrics ? { text: lyrics, source } : null;
}

/* ---------------------------------------------------------------------------
 * 7 · Normalisation helpers (port of the Python `recognizer/engine.py`)
 * ------------------------------------------------------------------------- */

/** Extract the `SONG` metadata block of a Shazam track. */
function shazamSections(track) {
  const meta = {};
  const sections = (track && track.sections) || [];
  for (const section of sections) {
    if (!section || section.type !== 'SONG') continue;
    for (const item of section.metadata || []) {
      const title = String(item.title || '').trim().toLowerCase();
      if (title) meta[title] = String(item.text || '').trim();
    }
  }
  return meta;
}

/** Pick the best cover art available. */
function bestArtwork(itunesItem, shazamTrack) {
  if (itunesItem && itunesItem.artworkUrl100) {
    return String(itunesItem.artworkUrl100).replace('100x100', '600x600');
  }
  if (shazamTrack && shazamTrack.images) {
    return shazamTrack.images.coverarthq || shazamTrack.images.coverart || null;
  }
  if (itunesItem) return itunesItem.artworkUrl100 || null;
  return null;
}

/** Build the platform links for a track. */
function buildLinks(title, artist, itunesItem, deezerItem, shazamTrack, extra) {
  const q = encodeURIComponent(((title || '') + ' ' + (artist || '')).trim());
  const links = {
    shazam: (shazamTrack && shazamTrack.url) || null,
    apple_music: null,
    spotify: 'https://open.spotify.com/search/' + q,
    youtube: 'https://www.youtube.com/results?search_query=' + q,
    youtube_music: 'https://music.youtube.com/search?q=' + q,
    deezer: null,
    google: 'https://www.google.com/search?q=' + q,
  };
  if (itunesItem) {
    links.apple_music = itunesItem.trackViewUrl || itunesItem.collectionViewUrl || null;
  }
  if (deezerItem) links.deezer = deezerItem.link || null;
  if (extra) {
    for (const key of Object.keys(extra)) {
      if (extra[key]) links[key] = extra[key];
    }
  }
  const out = {};
  for (const key of Object.keys(links)) {
    if (links[key]) out[key] = links[key];
  }
  return out;
}

/** Confidence heuristic (identical weights to the Python service). */
function confidenceScore(source, itunesItem, deezerItem, matchesCount) {
  let score = 55;
  if (source === 'shazam') {
    score += 20;
    score += Math.min(15, (matchesCount || 0) * 3);
  } else if (source === 'audd' || source === 'acrcloud') {
    // kept for parity with the legacy Python service (optional backends)
    score += 30;
  }
  if (itunesItem) score += 10;
  if (deezerItem) score += 5;
  return Math.min(99, Math.round(score));
}

/** Assemble the normalised `track` object. */
function buildTrackObject(data) {
  const d = data || {};
  const durationMs = d.durationMs || null;
  const links = buildLinks(
    d.title,
    d.artist,
    d.itunesItem,
    d.deezerItem,
    d.shazamTrack,
    d.linksExtra
  );
  const genres = d.genres || [];
  return {
    title: d.title || null,
    artist: d.artist || null,
    artists: d.artists && d.artists.length ? d.artists : d.artist ? [d.artist] : [],
    album: d.album || null,
    release_date: d.releaseDate || null,
    genre: genres.length ? genres[0] : null,
    genres,
    label: d.label || null,
    isrc: d.isrc || null,
    duration_ms: durationMs,
    duration: durationMs ? Math.round((durationMs / 1000) * 10) / 10 : null,
    duration_text: formatDuration(durationMs),
    artwork: d.artwork || null,
    artwork_hq: d.artworkHq || null,
    preview_url: d.preview || null,
    explicit: Boolean(d.explicit),
    bpm: d.bpm || null,
    rank: d.rank || null,
    shazam_id: (d.shazamTrack && d.shazamTrack.key) || null,
    apple_id: (d.itunesItem && d.itunesItem.trackId) || null,
    links,
  };
}

/* ---------------------------------------------------------------------------
 * 8 · Text / lyrics search engine (port of `search_text` in engine.py)
 * ------------------------------------------------------------------------- */

const TEXT_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'feat',
  'ft', 'with', 'by', 'official', 'video', 'lyrics', 'lyric', 'music',
  'song', 'audio', 'remix', 'version', 'از', 'به', 'و', 'در', 'با', 'که',
  'این', 'را', 'برای', 'یک',
]);

const VARIANT_WORDS = [
  'cover', 'remix', 'instrumental', 'karaoke', 'tribute', 'made famous',
  'originally performed', 'in the style of', 'acoustic', 'version', 'edit',
  'remaster', 'slowed', 'sped up', 'speed up', 'nightcore', 'mashup', '8d',
  'bass boost', 'reverb', 'demo', 'reprise', 're-recorded', 'radio edit',
  'bootleg', 'lofi', 'lo-fi', 'backing track', 'playback', 'ringtone',
  'concert', 'festival', 'unplugged', 'guitar', 'piano', 'live', 'live version',
  'نسخه', 'ریمیکس', 'کاور', 'بی‌کلام', 'بیکلام', 'زنده',
];

const POS0_WEIGHT = {
  itunes: 0.3,
  deezer: 0.18,
  'lyrics.ovh': 0.15,
  musicbrainz: 0.05,
};

const SPAM_ARTIST_WORDS = [
  'various artists', 'karaoke', 'tribute', 'hit crew', 'ameritz', 'cover',
  'made famous', 'originally performed', 'party tyme', 'studio musicians',
  'the karaoke channel', '8-bit', '8 bit', 'cover crew', 'cover nation',
  'playback', 'backing track', 'instrumental',
];

/** Lower-case, punctuation free text. */
function normText(value) {
  let s = String(value || '').toLowerCase().replace(/’/g, "'");
  s = s.replace(/n't\b/g, ' not');
  s = s.replace(/'ve\b/g, ' have');
  s = s.replace(/'re\b/g, ' are');
  s = s.replace(/'ll\b/g, ' will');
  s = s.replace(/'m\b/g, ' am');
  s = s.replace(/'d\b/g, ' would');
  s = s.replace(/[^\w\u0600-\u06FF']+/g, ' ');
  return s.split(/\s+/).filter(Boolean).join(' ').trim();
}

/** Significant tokens of a text (stop-words removed). */
function tokenize(text) {
  const normalised = normText(text);
  const words = normalised.match(/[\w\u0600-\u06FF]+/g) || [];
  const out = new Set();
  for (const w of words) {
    if (TEXT_STOPWORDS.has(w)) continue;
    if (w.length > 1) out.add(w);
  }
  return out;
}

/** Fraction of the query tokens present in the candidate text. */
function similarity(query, candidateText) {
  const q = tokenize(query);
  if (!q.size) return 0;
  const c = tokenize(candidateText);
  if (!c.size) return 0;
  let inter = 0;
  for (const token of q) if (c.has(token)) inter++;
  return inter / q.size;
}

/** Normalised "title::artist" identity key. */
function normKey(title, artist) {
  const t = String(title || '').toLowerCase().replace(/[^\w\u0600-\u06FF]+/g, '');
  const a = String(artist || '').toLowerCase().replace(/[^\w\u0600-\u06FF]+/g, '');
  return t + '::' + a;
}

/** Title without parentheses/brackets and dash suffixes. */
function canonicalTitle(title) {
  let t = String(title || '').toLowerCase();
  t = t.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  t = t.replace(/\s[-–—]\s.*$/, '');
  t = t.replace(/[^\w\u0600-\u06FF]+/g, ' ');
  return t.split(/\s+/).filter(Boolean).join(' ').trim();
}

/** Word-boundary aware "contains". */
function containsWord(text, word) {
  const t = String(text || '').toLowerCase();
  const w = String(word || '').toLowerCase();
  if (!w) return false;
  if (w.indexOf(' ') !== -1 || !/^[\x00-\x7F]+$/.test(w)) return t.indexOf(w) !== -1;
  let idx = t.indexOf(w);
  while (idx !== -1) {
    const before = idx > 0 ? t[idx - 1] : '';
    const after = idx + w.length < t.length ? t[idx + w.length] : '';
    const badBefore = before !== '' && /[a-z0-9]/.test(before);
    const badAfter = after !== '' && /[a-z0-9]/.test(after);
    if (!badBefore && !badAfter) return true;
    idx = t.indexOf(w, idx + 1);
  }
  return false;
}

/** Penalty for variant / remix / karaoke titles that the query did not ask for. */
function variantPenalty(title, query) {
  const tl = String(title || '').toLowerCase();
  const ql = String(query || '').toLowerCase();
  let penalty = 0;
  for (const word of VARIANT_WORDS) {
    if (containsWord(tl, word) && !containsWord(ql, word)) penalty += 0.5;
  }
  return Math.min(penalty, 0.7);
}

/** Penalty for low quality "cover band" artists. */
function spamPenalty(artist) {
  const al = String(artist || '').toLowerCase();
  for (const word of SPAM_ARTIST_WORDS) {
    if (al.indexOf(word) !== -1) return 0.6;
  }
  return 0;
}

/** How strongly a lyric body contains the query phrase. */
function phraseMatch(lyrics, query) {
  if (!lyrics) return 0;
  const lyr = normText(lyrics);
  const q = normText(query);
  if (!q) return 0;
  if (lyr.indexOf(q) !== -1) return 1;
  const qt = tokenize(q);
  const lt = tokenize(lyrics);
  if (!qt.size) return 0;
  let inter = 0;
  for (const token of qt) if (lt.has(token)) inter++;
  return inter / qt.size;
}

/**
 * Search for a song by free text (title, artist or lyric line).
 * @param {string} query
 * @param {{limit?:number, wantLyrics?:boolean, country?:string, debug?:boolean}} options
 */
async function searchText(query, options) {
  const opt = options || {};
  const limit = clamp(opt.limit || 8, 1, LIMITS.maxResults);
  const wantLyrics = Boolean(opt.wantLyrics);
  const country = opt.country || ITUNES_COUNTRY;
  const debug = Boolean(opt.debug);
  const started = Date.now();

  const q = String(query || '').trim();
  if (!q) {
    return {
      found: false,
      source: 'text-search',
      query: q,
      message: 'The search query is empty.',
      message_fa: 'متن/عبارت جستجو خالی است.',
      processing_ms: Date.now() - started,
      results: [],
    };
  }

  const qTokens = tokenize(q);
  const isLyric = qTokens.size >= 4;
  const fetchN = Math.max(limit * 2, 12);

  const [itunesRaw, deezerRaw, lyricsRaw, mbRaw] = await settleAll([
    itunesSearch(q, fetchN, country),
    deezerSearch(q, fetchN),
    lyricsOvhSuggest(q, fetchN),
    musicbrainzSearch(q, Math.max(5, Math.floor(fetchN / 2))),
  ]);
  const rawItunes = itunesRaw || [];
  const rawDeezer = deezerRaw || [];
  const rawLyrics = lyricsRaw || [];
  const rawMb = mbRaw || [];

  const candidates = new Map();

  const addCandidate = (title, artist, artwork, source, idx, total, deezerRank, extra) => {
    const t = String(title || '').trim();
    const a = String(artist || '').trim();
    if (!t || !a) return;
    const key = normKey(t, a);
    const posScore = 1 - idx / Math.max(1, total);
    let item = candidates.get(key);
    if (!item) {
      item = {
        title: t,
        artist: a,
        artwork: artwork || null,
        sources: [],
        pos0: new Set(),
        sim: Math.max(similarity(q, t), similarity(q, t + ' ' + a)),
        bestPos: posScore,
        deezerRank: deezerRank || 0,
        hits: 0,
        extra: {},
      };
      candidates.set(key, item);
    }
    item.hits += 1;
    item.bestPos = Math.max(item.bestPos, posScore);
    if (idx === 0) item.pos0.add(source);
    if (deezerRank) item.deezerRank = Math.max(item.deezerRank, deezerRank);
    if (artwork && !item.artwork) item.artwork = artwork;
    if (item.sources.indexOf(source) === -1) item.sources.push(source);
    if (extra) {
      for (const key2 of Object.keys(extra)) {
        if (extra[key2] && !item.extra[key2]) item.extra[key2] = extra[key2];
      }
    }
  };

  rawItunes.forEach((it, i) => {
    addCandidate(
      it.trackName,
      it.artistName,
      String(it.artworkUrl100 || '').replace('100x100', '300x300') || null,
      'itunes',
      i,
      rawItunes.length,
      0,
      { preview: it.previewUrl, release_date: it.releaseDate }
    );
  });
  rawDeezer.forEach((it, i) => {
    addCandidate(
      it.title,
      (it.artist && it.artist.name) || null,
      (it.album && it.album.cover_medium) || null,
      'deezer',
      i,
      rawDeezer.length,
      it.rank || 0,
      { preview: it.preview }
    );
  });
  rawLyrics.forEach((it, i) => {
    addCandidate(
      it.title,
      (it.artist && it.artist.name) || null,
      (it.album && it.album.cover_medium) || null,
      'lyrics.ovh',
      i,
      rawLyrics.length,
      0,
      { preview: it.preview }
    );
  });
  rawMb.forEach((it, i) => {
    let artist = '';
    if (Array.isArray(it['artist-credit'])) {
      artist = it['artist-credit']
        .map((c) => c.name || (c.artist && c.artist.name) || '')
        .join(' & ')
        .replace(/^[\s&]+|[\s&]+$/g, '');
    }
    addCandidate(it.title, artist, null, 'musicbrainz', i, rawMb.length * 3, 0, null);
  });

  if (!candidates.size) {
    return {
      found: false,
      source: 'text-search',
      query: q,
      message: 'No result was found for this query.',
      message_fa: 'نتیجه‌ای برای این متن/عبارت پیدا نشد؛ عبارت دیگری امتحان کنید.',
      processing_ms: Date.now() - started,
      results: [],
    };
  }

  const baseParts = (item) => {
    let pos0Bonus = 0;
    for (const source of item.pos0) pos0Bonus += POS0_WEIGHT[source] || 0;
    return (
      0.42 * item.sim +
      0.14 * item.bestPos +
      0.12 * (item.sources.length - 1) +
      pos0Bonus +
      Math.min(0.15, 0.02 * item.hits) -
      variantPenalty(item.title, q) -
      spamPenalty(item.artist)
    );
  };

  // Popularity lookup (Deezer rank) separates the original hit from covers.
  const prelim = Array.from(candidates.values())
    .sort((a, b) => baseParts(b) - baseParts(a))
    .slice(0, 8);
  const popResults = await settleAll(
    prelim.map((item) => deezerMatch(item.title, item.artist))
  );
  prelim.forEach((item, i) => {
    const d = popResults[i];
    if (d && d.rank) item.deezerRank = Math.max(item.deezerRank || 0, d.rank);
  });

  for (const item of candidates.values()) {
    const pop = Math.min(1, (item.deezerRank || 0) / 1000000);
    item.score = Math.max(0, baseParts(item) + 0.55 * pop);
  }

  // Lyrics verification for lyric-like queries.
  if (isLyric) {
    const shortlist = Array.from(candidates.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    const lyricResults = await settleAll(
      shortlist.map((item) => getLyrics(item.artist, item.title))
    );
    shortlist.forEach((item, i) => {
      const found = lyricResults[i];
      const text = found ? found.text : null;
      const lm = phraseMatch(text, q);
      item.lyricMatch = lm;
      if (text) item.lyricsText = text;
      if (lm > 0) item.score += 0.95 * lm;
      else if (text) item.score -= 0.25;
    });
  }

  let ranked = Array.from(candidates.values()).sort((a, b) => b.score - a.score);
  ranked = ranked.filter((x) => spamPenalty(x.artist) < 0.6);

  const result = {
    found: false,
    source: 'text-search',
    query: q,
    results: [],
  };

  if (debug) {
    result._debug = ranked.slice(0, 15).map((x) => ({
      title: x.title,
      artist: x.artist,
      score: Math.round(x.score * 1000) / 1000,
      sim: Math.round(x.sim * 1000) / 1000,
      pos: Math.round(x.bestPos * 1000) / 1000,
      hits: x.hits,
      sources: x.sources,
      pos0: Array.from(x.pos0),
      lyric_match: Math.round((x.lyricMatch || 0) * 1000) / 1000,
      variant_pen: Math.round(variantPenalty(x.title, q) * 1000) / 1000,
    }));
  }

  if (!ranked.length) {
    result.message = 'No result was found for this query.';
    result.message_fa = 'نتیجه‌ای برای این متن/عبارت پیدا نشد؛ عبارت دیگری امتحان کنید.';
    result.processing_ms = Date.now() - started;
    return result;
  }

  const best = ranked[0];
  const bestCanon = canonicalTitle(best.title);
  const bestArtistKey = normText(best.artist);

  const clean = [{ artist: best.artist, title: best.title }];
  const seen = new Set([normKey(best.title, best.artist)]);
  for (const item of ranked.slice(1)) {
    const canon = canonicalTitle(item.title);
    const sameSong = canon === bestCanon;
    const sameArtist = normText(item.artist) === bestArtistKey;
    if (sameSong && sameArtist) continue;
    if (sameSong && !sameArtist) continue;
    const key = normKey(item.title, item.artist);
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ artist: item.artist, title: item.title });
    if (clean.length >= Math.max(1, limit)) break;
  }

  let conf = Math.min(99, Math.round(55 + best.score * 40));
  if ((best.lyricMatch || 0) >= 0.999) conf = Math.max(conf, 97);

  result.found = true;
  result.count = clean.length;
  result.artist = best.artist;
  result.title = best.title;
  result.artwork = best.artwork || null;
  result.preview_url = best.extra.preview || null;
  result.confidence = conf;
  result.results = clean;

  if (wantLyrics) {
    let lyrics = best.lyricsText || null;
    if (!lyrics) {
      const found = await getLyrics(best.artist, best.title);
      if (found) lyrics = found.text;
    }
    result.lyrics = lyrics
      ? { available: true, text: lyrics, for: { title: best.title, artist: best.artist } }
      : { available: false };
  }

  result.processing_ms = Date.now() - started;
  return result;
}

/* ---------------------------------------------------------------------------
 * 9 · Storage layer (KV cache · D1 logs · R2 blobs) + rate limiting
 * ------------------------------------------------------------------------- */

/** Module level promise so the schema is only migrated once per isolate. */
let migrationPromise = null;

/** Create the D1 schema (idempotent, runs automatically on first use). */
async function ensureSchema(env) {
  if (!env.DB || typeof env.DB.prepare !== 'function') return false;
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const statements = [
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY,
           applied_at TEXT NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS requests_log (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           request_id TEXT,
           created_at TEXT NOT NULL,
           ip TEXT,
           country TEXT,
           endpoint TEXT,
           method TEXT,
           action TEXT,
           found INTEGER,
           confidence INTEGER,
           processing_ms INTEGER,
           cached INTEGER,
           status INTEGER,
           ua TEXT,
           lang TEXT
         )`,
        `CREATE TABLE IF NOT EXISTS daily_stats (
           day TEXT NOT NULL,
           endpoint TEXT NOT NULL,
           hits INTEGER NOT NULL DEFAULT 0,
           misses INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (day, endpoint)
         )`,
      ];
      for (const sql of statements) {
        try {
          await env.DB.prepare(sql).run();
        } catch (err) {
          // A partially provisioned database must not break the service.
          migrationPromise = null;
          throw err;
        }
      }
      try {
        await env.DB.prepare(
          'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)'
        )
          .bind(3, new Date().toISOString())
          .run();
      } catch {
        /* the table already exists – nothing to do */
      }
      return true;
    })().catch(() => false);
  }
  return migrationPromise;
}

/**
 * True when the optional R2 binding is present and actually usable.
 *
 * R2 is optional: the `[[r2_buckets]]` block in wrangler.toml is commented
 * out by default, so `env.MEDIA` is simply `undefined` on a stock
 * deployment. The service must work fine without it (KV/D1 are enough for
 * caching, rate limiting and logging).
 */
function hasR2(env) {
  return Boolean(
    env && env.MEDIA && typeof env.MEDIA.get === 'function' && typeof env.MEDIA.put === 'function',
  );
}

/** Read a cached JSON payload (KV first, then R2 for large blobs). */
async function cacheGet(env, key) {
  if (env.CACHE) {
    try {
      const raw = await env.CACHE.get(key, 'text');
      if (raw) return safeParse(raw, null);
    } catch {
      /* ignore */
    }
  }
  if (hasR2(env)) {
    try {
      const object = await env.MEDIA.get(key);
      if (object) {
        const text = await object.text();
        return safeParse(text, null);
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Store a JSON payload. Small payloads go to KV, large ones to R2
 * (KV has a 25 MB value limit but is much cheaper to read).
 */
async function cachePut(env, key, value, ttlSeconds) {
  const text = jsonStringify(value);
  if (env.CACHE && text.length <= 64 * 1024) {
    try {
      await env.CACHE.put(key, text, { expirationTtl: ttlSeconds });
      return true;
    } catch {
      /* ignore */
    }
  }
  if (hasR2(env)) {
    try {
      await env.MEDIA.put(key, text, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { cachedAt: new Date().toISOString() },
      });
      return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/** Fire-and-forget request logging (never blocks the response). */
function logRequest(env, entry) {
  if (!env.DB || typeof env.DB.prepare !== 'function') return;
  const row = {
    request_id: entry.request_id || null,
    created_at: new Date().toISOString(),
    ip: entry.ip || null,
    country: entry.country || null,
    endpoint: entry.endpoint || null,
    method: entry.method || null,
    action: entry.action || null,
    found: entry.found === undefined ? null : entry.found ? 1 : 0,
    confidence: entry.confidence || null,
    processing_ms: entry.processing_ms || null,
    cached: entry.cached ? 1 : 0,
    status: entry.status || null,
    ua: entry.ua ? String(entry.ua).slice(0, 240) : null,
    lang: entry.lang || null,
  };
  ensureSchema(env)
    .then((ok) => {
      if (!ok) return;
      return env.DB.prepare(
        `INSERT INTO requests_log
          (request_id, created_at, ip, country, endpoint, method, action, found,
           confidence, processing_ms, cached, status, ua, lang)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
        .bind(
          row.request_id,
          row.created_at,
          row.ip,
          row.country,
          row.endpoint,
          row.method,
          row.action,
          row.found,
          row.confidence,
          row.processing_ms,
          row.cached,
          row.status,
          row.ua,
          row.lang
        )
        .run();
    })
    .catch(() => {});
}

/** Increment the daily counters. */
function bumpStats(env, endpoint, found) {
  if (!env.DB || typeof env.DB.prepare !== 'function') return;
  const day = new Date().toISOString().slice(0, 10);
  ensureSchema(env)
    .then((ok) => {
      if (!ok) return;
      return env.DB.prepare(
        `INSERT INTO daily_stats (day, endpoint, hits, misses) VALUES (?,?,?,?)
         ON CONFLICT(day, endpoint) DO UPDATE SET
           hits = hits + excluded.hits,
           misses = misses + excluded.misses`
      )
        .bind(day, endpoint, found ? 1 : 0, found ? 0 : 1)
        .run();
    })
    .catch(() => {});
}

/** In-isolate fallback limiter (used when KV is not available). */
const memoryLimiter = new Map();

/**
 * Fixed-window rate limiter.
 * @returns {Promise<{allowed:boolean, remaining:number, retryAfter:number}>}
 */
async function checkRateLimit(env, ip, limit, windowSeconds) {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:${ip}:${bucket}`;
  if (env.CACHE) {
    try {
      const current = Number((await env.CACHE.get(key)) || 0);
      if (current >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfter: windowSeconds - Math.floor(Date.now() / 1000) % windowSeconds,
        };
      }
      await env.CACHE.put(key, String(current + 1), {
        expirationTtl: windowSeconds * 2,
      });
      return { allowed: true, remaining: limit - current - 1, retryAfter: 0 };
    } catch {
      /* fall through to the in-memory limiter */
    }
  }
  const now = Date.now();
  const entry = memoryLimiter.get(key);
  if (!entry || now > entry.reset) {
    memoryLimiter.set(key, { count: 1, reset: now + windowSeconds * 1000 });
    return { allowed: true, remaining: limit - 1, retryAfter: 0 };
  }
  if (entry.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil((entry.reset - now) / 1000),
    };
  }
  entry.count += 1;
  return { allowed: true, remaining: limit - entry.count, retryAfter: 0 };
}

/* ---------------------------------------------------------------------------
 * 10 · Recognition orchestration
 * ------------------------------------------------------------------------- */

/**
 * Turn a raw Shazam discovery payload into the normalised API answer.
 * @param {object} discovery raw discovery response
 * @param {number} matchesCount
 */
async function buildShazamResult(discovery, matchesCount, wantLyrics) {
  const track = discovery && discovery.track;
  if (!track) return null;

  const sections = shazamSections(track);
  const title = str(track.title);
  const artists = (track.artists || [])
    .map((a) => str(a && a.name))
    .filter(Boolean);
  const artist = str(track.subtitle) || artists[0] || null;
  const genreObject = track.genres || {};
  const genres = Array.isArray(genreObject)
    ? genreObject.slice()
    : Object.keys(genreObject).map((k) => genreObject[k]).filter(Boolean);
  const isrc = str(track.isrc);
  const images = track.images || {};

  let album = str(sections.album);
  let label = str(sections.label);
  let releaseDate = str(sections.released);
  let artwork = str(images.coverart);
  let artworkHq = str(images.coverarthq);
  let durationMs = null;
  let preview = null;
  let explicit = false;
  let bpm = null;
  let rank = null;
  let extraLinks = {};

  // Apple Music preview straight from the Shazam hub actions.
  const hubActions = (track.hub && track.hub.actions) || [];
  for (const action of hubActions) {
    if (action && action.name === 'uri' && /mzaf_|preview|audio/i.test(action.uri || '')) {
      preview = str(action.uri);
      break;
    }
  }

  const [itunesByIsrc, deezer] = await settleAll([
    isrc ? itunesLookupIsrc(isrc) : Promise.resolve(null),
    deezerMatch(title, artist),
  ]);
  let itunes = itunesByIsrc;
  if (!itunes) itunes = await itunesMatch(title, artist);

  if (itunes) {
    artworkHq = bestArtwork(itunes, track) || artworkHq;
    artwork = str(itunes.artworkUrl100) || artwork;
    releaseDate = str(itunes.releaseDate) || releaseDate;
    album = album || str(itunes.collectionName);
    if (itunes.primaryGenreName) {
      const extra = String(itunes.primaryGenreName);
      if (genres.indexOf(extra) === -1) genres.push(extra);
    }
    durationMs = itunes.trackTimeMillis || durationMs;
    preview = str(itunes.previewUrl) || preview;
    explicit = itunes.contentAdvisoryRating === 'Explicit';
  }
  if (deezer) {
    const deezerAlbum = deezer.album || {};
    if (!artworkHq) artworkHq = str(deezerAlbum.cover_xl) || str(deezerAlbum.cover_big);
    bpm = deezer.bpm || bpm;
    rank = deezer.rank || rank;
    durationMs = durationMs || (deezer.duration ? deezer.duration * 1000 : null);
    preview = preview || str(deezer.preview);
    if (deezer.release_date) releaseDate = releaseDate || str(deezer.release_date);
  }

  const trackObject = buildTrackObject({
    title,
    artist,
    artists,
    album,
    releaseDate,
    genres,
    label,
    isrc,
    durationMs,
    artwork,
    artworkHq,
    preview,
    explicit,
    bpm,
    rank,
    shazamTrack: track,
    itunesItem: itunes,
    deezerItem: deezer,
    linksExtra: extraLinks,
  });

  const result = {
    found: true,
    source: 'shazam',
    confidence: confidenceScore('shazam', itunes, deezer, matchesCount),
    track: trackObject,
    artist: trackObject.artist,
    title: trackObject.title,
    artwork: trackObject.artwork_hq || trackObject.artwork,
    matches: matchesCount,
  };

  if (wantLyrics && title) {
    const lyrics = await getLyrics(trackObject.artist, trackObject.title);
    result.lyrics = lyrics
      ? { available: true, source: lyrics.source, text: lyrics.text }
      : { available: false };
  }

  return result;
}

/**
 * Recognise a song from a pre-computed fingerprint.
 * @param {string} signatureUri data URI with the binary signature
 * @param {number} samplems
 * @param {{wantLyrics?:boolean}} options
 */
async function recognizeFromSignature(signatureUri, samplems, options) {
  const opt = options || {};
  const discovery = await shazamRecognize(signatureUri, samplems);
  if (!discovery) {
    return { found: false, source: null, upstreamError: true };
  }
  const matches = Array.isArray(discovery.matches) ? discovery.matches : [];
  let track = discovery.track;
  if (!track && matches.length && matches[0].id) {
    track = await shazamTrackById(matches[0].id);
  }
  if (!track) {
    return { found: false, source: null };
  }
  const result = await buildShazamResult({ track, matches }, matches.length, opt.wantLyrics);
  if (!result) return { found: false, source: null };
  result.matches = matches.length;
  return result;
}

/**
 * Recognise a song from raw PCM samples (16 kHz mono expected, other rates are
 * resampled automatically).
 */
async function recognizeFromPcm(samples, sampleRate, options) {
  const opt = options || {};
  // Int16 input is already in the amplitude range the algorithm expects;
  // float input (e.g. decoded WAV) is scaled by the caller.
  let source = samples;
  if (samples instanceof Int16Array) {
    source = new Float64Array(samples.length);
    for (let i = 0; i < samples.length; i++) source[i] = samples[i];
  }
  const prepared = preparePcm(source, sampleRate || 16000, opt.inputScale);
  const signature = fpBuildSignatureUri(prepared, { maxTimeSeconds: LIMITS.maxAudioSeconds });
  const result = await recognizeFromSignature(signature.uri, signature.samplems, opt);
  if (result) result.signature = { samplems: signature.samplems, peaks: signature.peaks };
  return result;
}

/** Recognise a song from a WAV buffer. */
async function recognizeFromWav(bytes, options) {
  const decoded = decodeWav(bytes);
  // decodeWav returns normalised floats; scale them back to the signed
  // 16 bit range so the fingerprint is identical to the reference encoder.
  const result = await recognizeFromPcm(decoded.samples, decoded.sampleRate, {
    ...options,
    inputScale: 32768,
  });
  if (result) {
    result.input = {
      type: 'audio',
      duration_ms: decoded.durationMs,
      sample_rate: decoded.sampleRate,
      channels: decoded.channels,
    };
  }
  return result;
}

/* ---------------------------------------------------------------------------
 * 11 · Remote URL handling (SSRF protection)
 * ------------------------------------------------------------------------- */

const PRIVATE_IPV4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^192\.0\.0\./,
  /^192\.0\.2\./,
  /^198\.18\./,
  /^198\.51\.100\./,
  /^203\.0\.113\./,
  /^224\./,
  /^240\./,
];

/** Reject obviously local / private / non-HTTP targets. */
function isUrlAllowed(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === 'metadata.google.internal') return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (PRIVATE_IPV4.some((re) => re.test(host))) return false;
  }
  if (host.includes(':')) {
    // IPv6 literal
    if (host === '::1' || host === '::') return false;
    if (/^f[cd]/.test(host)) return false;
    if (host.startsWith('fe80')) return false;
  }
  return true;
}

/* ---------------------------------------------------------------------------
 * 12 · HTTP layer: envelopes, CORS, rate limiting, router
 * ------------------------------------------------------------------------- */

/** The identity block returned by every endpoint (legacy + v1). */
function identityBlock() {
  return {
    creator: CREATOR.name,
    developer: CREATOR.id,
    developer_id: CREATOR.id,
    service: {
      name: APP_INFO.name,
      name_fa: APP_INFO.name_fa,
      title: APP_INFO.title,
      title_fa: APP_INFO.title_fa,
      version: APP_INFO.version,
      license: APP_INFO.license,
    },
  };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Accept, Accept-Language, X-Requested-With, X-Debug, X-Client-Id, Authorization',
  'Access-Control-Expose-Headers': 'X-Request-Id, X-Developer, X-RateLimit-Remaining, X-Cache',
  'Access-Control-Max-Age': '86400',
  'X-Developer': `${CREATOR.name} (${CREATOR.id})`,
  'X-Powered-By': `${APP_INFO.name} ${APP_INFO.version} · Cloudflare Workers`,
};

/**
 * Build a JSON response.
 * @param {object} payload body
 * @param {number} status HTTP status
 * @param {object} extra additional headers
 */
function jsonResponse(payload, status, extra) {
  const headers = Object.assign(
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    CORS_HEADERS,
    extra || {}
  );
  return new Response(jsonStringify(payload), { status, headers });
}

/** Build the standard v1 error response. */
function errorResponse(code, status, lang, requestId, extraHeaders) {
  const messages = tPair(code, lang);
  const payload = {
    ok: false,
    status,
    error: {
      code,
      message: messages.message,
      message_fa: messages.message_fa,
    },
    message: messages.message,
    message_fa: messages.message_fa,
    lang: lang === 'fa' ? 'fa' : 'en',
    request_id: requestId,
    ...identityBlock(),
  };
  if (extraHeaders && extraHeaders.payload) Object.assign(payload, extraHeaders.payload);
  return jsonResponse(payload, status, extraHeaders && extraHeaders.headers);
}

/** Wrap a payload into the standard v1 success envelope. */
function successEnvelope(data, lang, requestId, extra) {
  return {
    ok: true,
    status: 200,
    lang: lang === 'fa' ? 'fa' : 'en',
    request_id: requestId,
    ...identityBlock(),
    data: data === undefined ? null : data,
    ...(extra || {}),
  };
}

/** Detect the preferred language (query param first, then Accept-Language). */
function detectLang(url, request) {
  const q = url.searchParams.get('lang');
  if (q) {
    const v = q.toLowerCase();
    if (v === 'fa' || v === 'fa-ir' || v === 'per' || v === 'persian' || v === 'فارسی') return 'fa';
    if (v === 'en' || v === 'en-us' || v === 'en-gb' || v === 'english') return 'en';
  }
  const header = request.headers.get('accept-language') || '';
  if (/^fa/i.test(header.trim()) || /,\s*fa\b/i.test(header)) return 'fa';
  return 'en';
}

/** Client IP (best effort, works on Cloudflare). */
function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    '0.0.0.0'
  ).split(',')[0].trim();
}

/** Read a JSON body with a size guard. */
async function readJsonBody(request, maxBytes) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length && length > maxBytes) {
    const err = new Error('payload_too_large');
    err.code = 'E_PAYLOAD_TOO_LARGE';
    throw err;
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    const err = new Error('payload_too_large');
    err.code = 'E_PAYLOAD_TOO_LARGE';
    throw err;
  }
  if (!text.trim()) return {};
  const parsed = safeParse(text, null);
  if (parsed === null) {
    const err = new Error('invalid_json');
    err.code = 'E_BAD_REQUEST';
    throw err;
  }
  return parsed;
}

/* ------------------------------- endpoints ------------------------------- */

/** GET /health and GET /api/v1/health */
async function handleHealth(env, request, lang, requestId) {
  const bindings = {
    kv: Boolean(env.CACHE),
    d1: Boolean(env.DB),
    r2: hasR2(env),
  };
  let database = 'unknown';
  if (env.DB && typeof env.DB.prepare === 'function') {
    try {
      await ensureSchema(env);
      const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM requests_log').first();
      database = row && row.c !== undefined ? 'ok' : 'ok';
    } catch {
      database = 'error';
    }
  } else {
    database = 'not_configured';
  }
  const payload = {
    status: 'healthy',
    ok: true,
    service: APP_INFO.name,
    version: APP_INFO.version,
    engine_version: APP_INFO.version,
    uptime_note: 'Cloudflare Workers are stateless; see platform status for uptime.',
    database,
    bindings,
    signature: {
      algorithm: 'shazam-signature-v1',
      sample_rate: 16000,
      max_seconds: LIMITS.maxAudioSeconds,
      modes: ['client', 'worker', 'auto'],
    },
    features: {
      audio_upload: true,
      fingerprint: true,
      video_url: Boolean(env.BACKEND_URL),
      lyrics: true,
      text_search: true,
      metadata: true,
    },
    backend_configured: Boolean(env.BACKEND_URL),
    time: new Date().toISOString(),
  };
  return jsonResponse(successEnvelope(payload, lang, requestId), 200, {
    'Cache-Control': 'no-store',
  });
}

/** GET /api/v1/info */
async function handleInfo(env, request, lang, requestId) {
  const payload = {
    name: APP_INFO.name,
    name_fa: APP_INFO.name_fa,
    title: APP_INFO.title,
    title_fa: APP_INFO.title_fa,
    description: APP_INFO.description,
    description_fa: APP_INFO.description_fa,
    version: APP_INFO.version,
    license: APP_INFO.license,
    documentation: '/#docs',
    api_base: '/api/v1',
    endpoints: [
      { method: 'GET', path: '/', description: 'Web UI (bilingual, fa/en)' },
      { method: 'GET', path: '/health', description: 'Health probe' },
      { method: 'GET', path: '/api/v1/health', description: 'Health probe (v1)' },
      { method: 'GET', path: '/api/v1/info', description: 'Service metadata' },
      { method: 'GET', path: '/api/v1/providers', description: 'Upstream providers' },
      { method: 'GET', path: '/api/v1/openapi.json', description: 'OpenAPI 3.1 description' },
      { method: 'POST', path: '/api/v1/recognize', description: 'Recognise audio / fingerprint' },
      { method: 'POST', path: '/api/v1/recognize/url', description: 'Recognise a remote video/audio URL' },
      { method: 'POST', path: '/api/v1/search', description: 'Search by title / artist / lyrics' },
      { method: 'GET', path: '/api/v1/lyrics', description: 'Fetch lyrics for artist + title' },
      { method: 'POST', path: '/api/recognize', description: 'Legacy compatibility route' },
      { method: 'POST', path: '/api/search', description: 'Legacy compatibility route' },
      { method: 'GET', path: '/api/lyrics', description: 'Legacy compatibility route' },
    ],
    error_codes: ERROR_CODES,
    limits: {
      max_upload_bytes: LIMITS.maxUploadBytes,
      max_audio_seconds: LIMITS.maxAudioSeconds,
      max_query_length: LIMITS.maxQueryLength,
      max_results: LIMITS.maxResults,
      rate_limit_per_minute: Number(env.RATE_LIMIT_PER_MINUTE || 60),
    },
    creator: CREATOR,
  };
  return jsonResponse(successEnvelope(payload, lang, requestId), 200, {
    'Cache-Control': 'public, max-age=300',
  });
}

/** GET /api/v1/providers */
async function handleProviders(env, request, lang, requestId) {
  const payload = {
    recognition: [
      {
        id: 'shazam',
        name: 'Shazam',
        key_required: false,
        note: 'Fingerprint matching against the public discovery endpoint.',
      },
    ],
    metadata: [
      { id: 'itunes', name: 'iTunes / Apple Music', key_required: false },
      { id: 'deezer', name: 'Deezer', key_required: false },
      { id: 'musicbrainz', name: 'MusicBrainz', key_required: false },
    ],
    lyrics: [
      { id: 'lyrics.ovh', name: 'lyrics.ovh', key_required: false },
      { id: 'lrclib', name: 'LRCLIB', key_required: false },
    ],
    optional_backends: [
      {
        id: 'backend',
        name: 'Python / ffmpeg backend',
        key_required: false,
        configured: Boolean(env.BACKEND_URL),
        note: 'Required for video URLs and non-WAV uploads when the Worker cannot decode them.',
      },
    ],
  };
  return jsonResponse(successEnvelope(payload, lang, requestId), 200, {
    'Cache-Control': 'public, max-age=300',
  });
}

/** GET /api/v1/openapi.json */
function handleOpenApi(env, lang, requestId) {
  const jsonBody = { type: 'object' };
  const document = {
    openapi: '3.1.0',
    info: {
      title: APP_INFO.title,
      description: APP_INFO.description,
      version: APP_INFO.version,
      license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
      contact: { name: CREATOR.name, url: `https://t.me/${CREATOR.handle}` },
    },
    servers: [{ url: '/api/v1' }],
    tags: [
      { name: 'recognition', description: 'Audio fingerprinting and recognition' },
      { name: 'metadata', description: 'Search, lyrics and service information' },
    ],
    paths: {
      '/health': {
        get: {
          tags: ['metadata'],
          summary: 'Health probe',
          responses: { '200': { description: 'Service is healthy' } },
        },
      },
      '/info': {
        get: {
          tags: ['metadata'],
          summary: 'Service metadata',
          responses: { '200': { description: 'Service information' } },
        },
      },
      '/providers': {
        get: {
          tags: ['metadata'],
          summary: 'Upstream providers',
          responses: { '200': { description: 'Provider list' } },
        },
      },
      '/recognize': {
        post: {
          tags: ['recognition'],
          summary: 'Recognise a song',
          description:
            'Send a Shazam fingerprint (base64 data URI), raw 16 kHz mono PCM (base64) ' +
            'or a WAV file (multipart / raw body).',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    signature: { type: 'string', description: 'Fingerprint data URI' },
                    pcm: { type: 'string', description: 'Base64 raw PCM (s16le, 16 kHz mono)' },
                    samplems: { type: 'integer' },
                    lyrics: { type: 'boolean', default: true },
                  },
                },
              },
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    file: { type: 'string', format: 'binary' },
                    lyrics: { type: 'boolean' },
                  },
                },
              },
              'audio/wav': { schema: { type: 'string', format: 'binary' } },
            },
          },
          responses: {
            '200': { description: 'Song recognised' },
            '400': { description: 'Invalid input' },
            '404': { description: 'No match' },
            '413': { description: 'Payload too large' },
            '429': { description: 'Rate limited' },
            '502': { description: 'Upstream failure' },
          },
        },
      },
      '/recognize/url': {
        post: {
          tags: ['recognition'],
          summary: 'Recognise a song from a remote media URL',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { url: { type: 'string', format: 'uri' } },
                  required: ['url'],
                },
              },
            },
          },
          responses: {
            '200': { description: 'Song recognised' },
            '400': { description: 'Invalid or blocked URL' },
            '501': { description: 'BACKEND_URL is not configured' },
          },
        },
      },
      '/search': {
        post: {
          tags: ['metadata'],
          summary: 'Search by title, artist or lyric line',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    query: { type: 'string' },
                    limit: { type: 'integer', default: 8 },
                    lyrics: { type: 'boolean', default: false },
                  },
                  required: ['query'],
                },
              },
            },
          },
          responses: { '200': { description: 'Search results' }, '400': { description: 'Empty query' } },
        },
      },
      '/lyrics': {
        get: {
          tags: ['metadata'],
          summary: 'Fetch lyrics',
          parameters: [
            { name: 'artist', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'title', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Lyrics' }, '404': { description: 'Not found' } },
        },
      },
    },
    components: {
      schemas: {
        Error: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', const: false },
            status: { type: 'integer' },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', enum: Object.keys(ERROR_CODES) },
                message: { type: 'string' },
                message_fa: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
  return jsonResponse(document, 200, { 'Cache-Control': 'public, max-age=300' });
}

/** POST /api/v1/recognize */
async function handleRecognize(env, request, lang, requestId) {
  const contentType = String(request.headers.get('content-type') || '').toLowerCase();
  const wantLyricsDefault = true;

  let signatureUri = null;
  let samplems = 0;
  let wantLyrics = wantLyricsDefault;
  let inputMeta = { type: 'audio' };
  let pcmBytes = null;
  let rawWav = null;

  if (contentType.indexOf('application/json') !== -1) {
    let body;
    try {
      body = await readJsonBody(request, LIMITS.maxUploadBytes);
    } catch (err) {
      const code = err.code === 'E_PAYLOAD_TOO_LARGE' ? 'E_PAYLOAD_TOO_LARGE' : 'E_BAD_REQUEST';
      return errorResponse(code, code === 'E_PAYLOAD_TOO_LARGE' ? 413 : 400, lang, requestId);
    }
    if (body.lyrics !== undefined) wantLyrics = Boolean(body.lyrics);
    if (body.samplems !== undefined) samplems = Number(body.samplems) || 0;
    if (body.signature) {
      signatureUri = String(body.signature);
      if (!signatureUri.startsWith('data:') && !signatureUri.startsWith(SIGNATURE_URI_PREFIX)) {
        signatureUri = SIGNATURE_URI_PREFIX + signatureUri.replace(/^data:[^,]+,/, '');
      }
      if (!isValidSignatureUri(signatureUri)) {
        return errorResponse('E_INVALID_SIGNATURE', 400, lang, requestId);
      }
    } else if (body.pcm || body.pcm_base64) {
      try {
        pcmBytes = base64ToBytes(body.pcm || body.pcm_base64);
      } catch {
        return errorResponse('E_INVALID_INPUT', 400, lang, requestId);
      }
      if (pcmBytes.length % 2 !== 0) {
        return errorResponse('E_INVALID_INPUT', 400, lang, requestId);
      }
      if (pcmBytes.length / 2 > LIMITS.maxPcmSamples) {
        return errorResponse('E_PAYLOAD_TOO_LARGE', 413, lang, requestId);
      }
    } else {
      return errorResponse('E_MISSING_INPUT', 400, lang, requestId);
    }
  } else if (contentType.indexOf('multipart/form-data') !== -1) {
    const length = Number(request.headers.get('content-length') || 0);
    if (length && length > LIMITS.maxUploadBytes) {
      return errorResponse('E_PAYLOAD_TOO_LARGE', 413, lang, requestId);
    }
    let form;
    try {
      form = await request.formData();
    } catch {
      return errorResponse('E_BAD_REQUEST', 400, lang, requestId);
    }
    const file = form.get('file') || form.get('audio') || form.get('media');
    if (form.get('lyrics') !== null && form.get('lyrics') !== undefined) {
      wantLyrics = String(form.get('lyrics')) !== 'false';
    }
    if (form.get('signature')) {
      signatureUri = String(form.get('signature'));
      if (!signatureUri.startsWith('data:')) {
        signatureUri = SIGNATURE_URI_PREFIX + signatureUri;
      }
      if (!isValidSignatureUri(signatureUri)) {
        return errorResponse('E_INVALID_SIGNATURE', 400, lang, requestId);
      }
    } else if (file && typeof file.arrayBuffer === 'function') {
      const buffer = await file.arrayBuffer();
      if (buffer.byteLength > LIMITS.maxUploadBytes) {
        return errorResponse('E_PAYLOAD_TOO_LARGE', 413, lang, requestId);
      }
      const mime = String(file.type || '').toLowerCase();
      const name = String(file.name || '').toLowerCase();
      const isWav = ALLOWED_AUDIO_MIME.indexOf(mime) !== -1 || name.endsWith('.wav');
      if (!isWav) {
        return errorResponse('E_UNSUPPORTED_FORMAT', 415, lang, requestId);
      }
      rawWav = new Uint8Array(buffer);
      inputMeta = { type: 'audio', filename: str(file.name), mime: str(file.type) };
    } else {
      return errorResponse('E_MISSING_INPUT', 400, lang, requestId);
    }
  } else if (contentType.indexOf('audio/') !== -1 || contentType.indexOf('application/octet-stream') !== -1) {
    const length = Number(request.headers.get('content-length') || 0);
    if (length && length > LIMITS.maxUploadBytes) {
      return errorResponse('E_PAYLOAD_TOO_LARGE', 413, lang, requestId);
    }
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > LIMITS.maxUploadBytes) {
      return errorResponse('E_PAYLOAD_TOO_LARGE', 413, lang, requestId);
    }
    rawWav = new Uint8Array(buffer);
    inputMeta = { type: 'audio', mime: str(contentType) };
  } else {
    return errorResponse('E_UNSUPPORTED_FORMAT', 415, lang, requestId);
  }

  const mode = String(env.SIGNATURE_MODE || 'auto').toLowerCase();
  const started = Date.now();

  // --- Cache lookup -------------------------------------------------------
  let cacheKey = null;
  if (signatureUri) {
    cacheKey = 'sig:' + (await hashKey(signatureUri));
  } else if (rawWav) {
    cacheKey = 'sig:' + (await hashKey(rawWav));
  } else if (pcmBytes) {
    cacheKey = 'sig:' + (await hashKey(pcmBytes));
  }

  if (cacheKey) {
    const cached = await cacheGet(env, cacheKey);
    if (cached && cached.found) {
      cached.cached = true;
      cached.processing_ms = Date.now() - started;
      cached.request_id = requestId;
      return jsonResponse(successEnvelope(cached, lang, requestId), 200, { 'X-Cache': 'HIT' });
    }
  }

  // --- Produce the fingerprint -------------------------------------------
  let result = null;
  try {
    if (signatureUri) {
      result = await recognizeFromSignature(signatureUri, samplems, { wantLyrics });
    } else if (rawWav) {
      result = await recognizeFromWav(rawWav, { wantLyrics });
    } else if (pcmBytes) {
      const samples = new Int16Array(
        pcmBytes.buffer,
        pcmBytes.byteOffset,
        Math.floor(pcmBytes.length / 2)
      );
      result = await recognizeFromPcm(samples, 16000, { wantLyrics });
    }
  } catch (err) {
    const code = err && err.code === 'E_UNSUPPORTED_FORMAT' ? 'E_UNSUPPORTED_FORMAT'
      : err && err.code === 'E_INVALID_INPUT' ? 'E_INVALID_INPUT'
        : 'E_INTERNAL';
    const status = code === 'E_UNSUPPORTED_FORMAT' ? 415 : code === 'E_INVALID_INPUT' ? 400 : 500;
    return errorResponse(code, status, lang, requestId);
  }

  if (!result || result.upstreamError) {
    const upstream = !!(result && result.upstreamError);
    return errorResponse(upstream ? 'E_UPSTREAM_ERROR' : 'E_NO_MATCH', upstream ? 502 : 404, lang, requestId, {
      payload: {
        found: false,
        data: {
          found: false,
          input: inputMeta,
          message: t('no_match', lang),
          message_fa: t('no_match', 'fa'),
        },
      },
    });
  }

  result.input = Object.assign({}, result.input || {}, inputMeta);
  result.processing_ms = Date.now() - started;
  result.request_id = requestId;
  result.engine = APP_INFO.name;
  result.engine_version = APP_INFO.version;
  result.created_at = new Date().toISOString();

  if (cacheKey) {
    await cachePut(env, cacheKey, result, LIMITS.cacheTtlSeconds);
  }

  logRequest(env, {
    request_id: requestId,
    ip: clientIp(request),
    endpoint: '/api/v1/recognize',
    method: 'POST',
    action: 'recognize',
    found: true,
    confidence: result.confidence,
    processing_ms: result.processing_ms,
    cached: false,
    status: 200,
    ua: request.headers.get('user-agent'),
    lang,
  });
  bumpStats(env, 'recognize', true);

  return jsonResponse(successEnvelope(result, lang, requestId), 200, { 'X-Cache': 'MISS' });
}

/** POST /api/v1/recognize/url */
async function handleRecognizeUrl(env, request, lang, requestId) {
  let body;
  try {
    body = await readJsonBody(request, 64 * 1024);
  } catch {
    return errorResponse('E_BAD_REQUEST', 400, lang, requestId);
  }
  const rawUrl = str(body.url || body.link);
  if (!rawUrl) return errorResponse('E_MISSING_INPUT', 400, lang, requestId);
  if (!isUrlAllowed(rawUrl)) {
    return errorResponse('E_URL_NOT_ALLOWED', 400, lang, requestId);
  }
  if (!env.BACKEND_URL) {
    return errorResponse('E_BACKEND_REQUIRED', 501, lang, requestId, {
      payload: {
        found: false,
        data: {
          found: false,
          input: { type: 'video', url: rawUrl },
          message: t('backend_required', lang),
          message_fa: t('backend_required', 'fa'),
        },
      },
    });
  }

  const headers = { 'Content-Type': 'application/json' };
  if (env.BACKEND_KEY) headers['X-Backend-Key'] = env.BACKEND_KEY;
  const payload = await fetchJson(
    env.BACKEND_URL.replace(/\/$/, '') + '/api/recognize-url',
    {
      method: 'POST',
      headers,
      body: jsonStringify({ url: rawUrl, lang }),
    },
    45000
  );
  if (!payload) {
    return errorResponse('E_BACKEND_ERROR', 502, lang, requestId);
  }
  const result = payload.data || payload;
  result.request_id = requestId;
  return jsonResponse(successEnvelope(result, lang, requestId), 200);
}

/** POST /api/v1/search */
async function handleSearch(env, request, lang, requestId) {
  let body;
  try {
    body = await readJsonBody(request, 64 * 1024);
  } catch {
    return errorResponse('E_BAD_REQUEST', 400, lang, requestId);
  }
  const query = str(body.query || body.q || body.text);
  if (!query) return errorResponse('E_MISSING_INPUT', 400, lang, requestId);
  if (query.length > LIMITS.maxQueryLength) {
    return errorResponse('E_INVALID_INPUT', 400, lang, requestId);
  }
  const limit = clamp(Number(body.limit) || 8, 1, LIMITS.maxResults);
  const wantLyrics = body.lyrics === undefined ? true : Boolean(body.lyrics);
  const started = Date.now();

  const cacheKey = 'q:' + (await hashKey(query + '|' + limit + '|' + (wantLyrics ? 1 : 0)));
  const cached = await cacheGet(env, cacheKey);
  if (cached) {
    cached.cached = true;
    cached.processing_ms = Date.now() - started;
    cached.request_id = requestId;
    return jsonResponse(successEnvelope(cached, lang, requestId), 200, { 'X-Cache': 'HIT' });
  }

  const result = await searchText(query, { limit, wantLyrics, debug: false });
  result.request_id = requestId;
  result.engine = APP_INFO.name;
  result.engine_version = APP_INFO.version;
  result.created_at = new Date().toISOString();
  if (result.found) {
    await cachePut(env, cacheKey, result, LIMITS.searchCacheTtlSeconds);
  }
  logRequest(env, {
    request_id: requestId,
    ip: clientIp(request),
    endpoint: '/api/v1/search',
    method: 'POST',
    action: 'search',
    found: result.found,
    confidence: result.confidence,
    processing_ms: result.processing_ms,
    cached: false,
    status: 200,
    ua: request.headers.get('user-agent'),
    lang,
  });
  bumpStats(env, 'search', result.found);
  return jsonResponse(successEnvelope(result, lang, requestId), 200, { 'X-Cache': 'MISS' });
}

/** GET /api/v1/lyrics */
async function handleLyrics(env, request, url, lang, requestId) {
  const artist = str(url.searchParams.get('artist'));
  const title = str(url.searchParams.get('title') || url.searchParams.get('track'));
  if (!title) return errorResponse('E_MISSING_INPUT', 400, lang, requestId);
  const lyrics = await getLyrics(artist, title);
  if (!lyrics) {
    return errorResponse('E_NOT_FOUND', 404, lang, requestId, {
      payload: {
        found: false,
        data: { available: false, artist, title },
      },
    });
  }
  const payload = {
    available: true,
    source: lyrics.source,
    text: lyrics.text,
    artist,
    title,
    for: { artist, title },
  };
  return jsonResponse(successEnvelope(payload, lang, requestId), 200, {
    'Cache-Control': 'public, max-age=3600',
  });
}

/* --------------------------- legacy routes ------------------------------- */

/** Legacy /api/recognize – keeps the flat response shape of the Python app. */
async function handleLegacyRecognize(env, request, requestId) {
  const contentType = String(request.headers.get('content-type') || '').toLowerCase();
  let signatureUri = null;
  let rawWav = null;
  if (contentType.indexOf('application/json') !== -1) {
    const body = await readJsonBody(request, LIMITS.maxUploadBytes).catch(() => ({}));
    if (body.signature) {
      signatureUri = String(body.signature);
      if (!signatureUri.startsWith('data:')) signatureUri = SIGNATURE_URI_PREFIX + signatureUri;
    }
  } else if (contentType.indexOf('multipart/form-data') !== -1) {
    const form = await request.formData().catch(() => null);
    const file = form && (form.get('file') || form.get('audio'));
    if (file && typeof file.arrayBuffer === 'function') {
      const buffer = await file.arrayBuffer();
      rawWav = new Uint8Array(buffer);
    }
  }
  if (!signatureUri && !rawWav) {
    return errorResponse('E_MISSING_INPUT', 400, 'en', requestId);
  }
  const result = signatureUri
    ? await recognizeFromSignature(signatureUri, 0, { wantLyrics: true })
    : await recognizeFromWav(rawWav, { wantLyrics: true });
  if (!result || !result.found) {
    return jsonResponse(
      {
        found: false,
        source: null,
        engine: APP_INFO.name,
        created_at: new Date().toISOString(),
        message: 'No match found.',
        message_fa: 'آهنگی با این صدا/ویدیو پیدا نشد. لطفاً نمونه واضح‌تری امتحان کنید.',
        ...identityBlock(),
      },
      200
    );
  }
  result.engine = APP_INFO.name;
  result.engine_version = APP_INFO.version;
  result.created_at = new Date().toISOString();
  result.request_id = requestId;
  return jsonResponse(Object.assign(result, identityBlock()), 200);
}

/** Legacy /api/search */
async function handleLegacySearch(env, request, requestId) {
  let body = {};
  const contentType = String(request.headers.get('content-type') || '').toLowerCase();
  if (contentType.indexOf('application/json') !== -1) {
    body = await readJsonBody(request, 64 * 1024).catch(() => ({}));
  } else {
    const url = new URL(request.url);
    body = {
      query: url.searchParams.get('q') || url.searchParams.get('query'),
      limit: url.searchParams.get('limit'),
    };
  }
  const query = str(body.query);
  if (!query) {
    return jsonResponse(
      {
        found: false,
        source: 'text-search',
        engine: APP_INFO.name,
        created_at: new Date().toISOString(),
        query: '',
        message_fa: 'متن/عبارت جستجو خالی است.',
        ...identityBlock(),
      },
      200
    );
  }
  const result = await searchText(query, {
    limit: clamp(Number(body.limit) || 8, 1, LIMITS.maxResults),
    wantLyrics: Boolean(body.lyrics),
  });
  result.engine = APP_INFO.name;
  result.engine_version = APP_INFO.version;
  result.created_at = new Date().toISOString();
  result.request_id = requestId;
  return jsonResponse(Object.assign(result, identityBlock()), 200);
}

/** Legacy /api/lyrics */
async function handleLegacyLyrics(env, request, url, requestId) {
  const artist = str(url.searchParams.get('artist'));
  const title = str(url.searchParams.get('title'));
  if (!title) return errorResponse('E_MISSING_INPUT', 400, 'en', requestId);
  const lyrics = await getLyrics(artist, title);
  return jsonResponse(
    {
      found: Boolean(lyrics),
      available: Boolean(lyrics),
      text: lyrics ? lyrics.text : null,
      source: lyrics ? lyrics.source : null,
      artist,
      title,
      ...identityBlock(),
    },
    200
  );
}

/* ---------------------------------------------------------------------------
 * 13 · Router
 * ------------------------------------------------------------------------- */

/** Every error code the API can return. */
const ERROR_CODES = Object.freeze({
  E_OK: { status: 200, en: 'Success', fa: 'موفق' },
  E_BAD_REQUEST: { status: 400, en: 'Malformed request', fa: 'درخواست نامعتبر' },
  E_INVALID_INPUT: { status: 400, en: 'Invalid input value', fa: 'مقدار ورودی نامعتبر' },
  E_MISSING_INPUT: { status: 400, en: 'Required input is missing', fa: 'ورودی الزامی ارسال نشده' },
  E_INVALID_SIGNATURE: { status: 400, en: 'Malformed fingerprint', fa: 'اثر انگشت نامعتبر' },
  E_UNSUPPORTED_FORMAT: { status: 415, en: 'Unsupported media format', fa: 'فرمت پشتیبانی‌نشده' },
  E_PAYLOAD_TOO_LARGE: { status: 413, en: 'Payload too large', fa: 'حجم داده بیش از حد' },
  E_NOT_FOUND: { status: 404, en: 'Resource not found', fa: 'یافت نشد' },
  E_NO_MATCH: { status: 404, en: 'No matching song', fa: 'آهنگی پیدا نشد' },
  E_RATE_LIMITED: { status: 429, en: 'Rate limit exceeded', fa: 'محدودیت نرخ درخواست' },
  E_URL_INVALID: { status: 400, en: 'Invalid URL', fa: 'آدرس نامعتبر' },
  E_URL_NOT_ALLOWED: { status: 400, en: 'URL target is not allowed', fa: 'آدرس مجاز نیست' },
  E_BACKEND_REQUIRED: { status: 501, en: 'BACKEND_URL is not configured', fa: 'بک‌اند تنظیم نشده' },
  E_BACKEND_ERROR: { status: 502, en: 'Backend failure', fa: 'خطای بک‌اند' },
  E_UPSTREAM_ERROR: { status: 502, en: 'Upstream provider failure', fa: 'خطای سرویس بیرونی' },
  E_INTERNAL: { status: 500, en: 'Internal error', fa: 'خطای داخلی' },
});

/**
 * Main request handler.
 * @param {Request} request
 * @param {object} env
 * @param {object} ctx
 */
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const requestId = uuid4();
  const lang = detectLang(url, request);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ---- Static assets -----------------------------------------------------
  if (path === '/static/fingerprint.js') {
    return new Response(buildBrowserFingerprintModule(), {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        ...CORS_HEADERS,
      },
    });
  }
  if (path === '/static/app.css') {
    return new Response(ASSET_CSS, {
      headers: {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        ...CORS_HEADERS,
      },
    });
  }
  if (path === '/static/app.js') {
    return new Response(ASSET_JS, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        ...CORS_HEADERS,
      },
    });
  }
  if (path === '/favicon.svg' || path === '/favicon.ico') {
    return new Response(ASSET_FAVICON, {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        ...CORS_HEADERS,
      },
    });
  }
  if (path === '/robots.txt') {
    return new Response('User-agent: *\nAllow: /\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  if (path === '/manifest.webmanifest') {
    return jsonResponse(
      {
        name: APP_INFO.title,
        short_name: APP_INFO.name,
        start_url: '/',
        display: 'standalone',
        background_color: '#070b16',
        theme_color: '#6c5ce7',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
      },
      200,
      { 'Cache-Control': 'public, max-age=86400' }
    );
  }

  // ---- Web UI ------------------------------------------------------------
  if (path === '/' && request.method === 'GET') {
    return new Response(ASSET_HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=600',
        ...CORS_HEADERS,
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' " +
          "https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; img-src * data: blob:; " +
          "connect-src 'self' https:; media-src * blob:;",
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  // ---- API ---------------------------------------------------------------
  const isRecognize = path === '/api/v1/recognize';
  const isUrl = path === '/api/v1/recognize/url';
  const isSearch = path === '/api/v1/search';
  const isLyrics = path === '/api/v1/lyrics';
  const isHealth = path === '/health' || path === '/api/v1/health';
  const isInfo = path === '/api/v1/info';
  const isProviders = path === '/api/v1/providers';
  const isOpenApi = path === '/api/v1/openapi.json';
  const legacyRecognize = path === '/api/recognize';
  const legacySearch = path === '/api/search';
  const legacyLyrics = path === '/api/lyrics';
  const legacyInfo = path === '/api/info';
  const legacyHealth = path === '/api/health';
  const legacyProviders = path === '/api/providers';

  const needsPost = isRecognize || isUrl || isSearch || legacyRecognize || legacySearch;
  if (needsPost && request.method !== 'POST') {
    return errorResponse('E_BAD_REQUEST', 405, lang, requestId, {
      headers: { Allow: 'POST, OPTIONS' },
    });
  }

  // ---- Rate limiting -----------------------------------------------------
  const ip = clientIp(request);
  const limitPerMinute = Number(env.RATE_LIMIT_PER_MINUTE || 60);
  const limit = needsPost
    ? Number(env.RATE_LIMIT_RECOGNIZE_PER_MINUTE || Math.max(10, Math.floor(limitPerMinute / 2)))
    : limitPerMinute;
  const rate = await checkRateLimit(env, ip, limit, 60);
  if (!rate.allowed) {
    return errorResponse('E_RATE_LIMITED', 429, lang, requestId, {
      headers: { 'Retry-After': String(rate.retryAfter || 60) },
    });
  }
  const rateHeaders = { 'X-RateLimit-Remaining': String(Math.max(0, rate.remaining)) };

  try {
    if (isHealth) {
      const res = await handleHealth(env, request, lang, requestId);
      return res;
    }
    if (isInfo) {
      return await handleInfo(env, request, lang, requestId);
    }
    if (isProviders) {
      return await handleProviders(env, request, lang, requestId);
    }
    if (isOpenApi) {
      return handleOpenApi(env, lang, requestId);
    }
    if (isRecognize) {
      const res = await handleRecognize(env, request, lang, requestId);
      return res;
    }
    if (isUrl) {
      return await handleRecognizeUrl(env, request, lang, requestId);
    }
    if (isSearch) {
      return await handleSearch(env, request, lang, requestId);
    }
    if (isLyrics) {
      return await handleLyrics(env, request, url, lang, requestId);
    }
    if (legacyRecognize) {
      return await handleLegacyRecognize(env, request, requestId);
    }
    if (legacySearch) {
      return await handleLegacySearch(env, request, requestId);
    }
    if (legacyLyrics) {
      return await handleLegacyLyrics(env, request, url, requestId);
    }
    if (legacyInfo) {
      return await handleInfo(env, request, lang, requestId);
    }
    if (legacyHealth) {
      return await handleHealth(env, request, lang, requestId);
    }
    if (legacyProviders) {
      return await handleProviders(env, request, lang, requestId);
    }
    return errorResponse('E_NOT_FOUND', 404, lang, requestId, { headers: rateHeaders });
  } catch (err) {
    return errorResponse('E_INTERNAL', 500, lang, requestId, { headers: rateHeaders });
  }
}

export default {
  /**
   * Cloudflare Workers entry point.
   * @param {Request} request
   * @param {object} env
   * @param {object} ctx
   */
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      return new Response(
        jsonStringify({
          ok: false,
          status: 500,
          error: { code: 'E_INTERNAL', message: 'Internal error', message_fa: 'خطای داخلی' },
          ...identityBlock(),
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
        }
      );
    }
  },
};

/* ---------------------------------------------------------------------------
 * 15 · Named exports (used by the test-suite; the Worker itself only needs
 *      the default export below).
 * ------------------------------------------------------------------------- */

export {
  fpBuildSignatureUri,
  fpEncodeSignature,
  fpBase64,
  fpCrc32,
  fpFft,
  fpHanningWindow,
  FpSignatureGenerator,
  buildBrowserFingerprintModule,
  base64ToBytes,
  bytesToBase64,
  decodeWav,
  preparePcm,
  resample,
  searchText,
  buildTrackObject,
  shazamSections,
  bestArtwork,
  buildLinks,
  confidenceScore,
  detectLang,
  isUrlAllowed,
  getLyrics,
  hasR2,
  cacheGet,
  cachePut,
  t,
  tPair,
  I18N,
  ERROR_CODES,
  LIMITS,
  APP_INFO,
  CREATOR,
  ASSET_HTML,
  ASSET_CSS,
  ASSET_JS,
  ASSET_FAVICON,
};

/* ---------------------------------------------------------------------------
 * 14 · Web UI assets (CSS / HTML / client JavaScript)
 * ------------------------------------------------------------------------- */

const ASSET_CSS = `
/* ============================================================
   Shzm · Cloudflare Worker UI
   Author: Ali Mousavi (@AliMsvD)
   ============================================================ */
:root {
  --bg: #070b16;
  --bg-2: #0b1224;
  --surface: rgba(255,255,255,.055);
  --surface-2: rgba(255,255,255,.085);
  --border: rgba(255,255,255,.11);
  --border-strong: rgba(255,255,255,.2);
  --text: #eaf0ff;
  --muted: #9aa8c7;
  --faint: #6b7899;
  --primary: #6c5ce7;
  --primary-2: #a855f7;
  --accent: #22d3ee;
  --success: #34d399;
  --warn: #fbbf24;
  --danger: #fb7185;
  --shadow: 0 24px 60px -24px rgba(0,0,0,.75);
  --radius: 22px;
  --radius-sm: 14px;
  --font: 'Vazirmatn', 'Segoe UI', system-ui, -apple-system, 'Noto Sans Arabic', Tahoma, sans-serif;
  --mono: ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace;
  --maxw: 1180px;
}
[data-theme='light'] {
  --bg: #f2f4fb;
  --bg-2: #ffffff;
  --surface: rgba(255,255,255,.78);
  --surface-2: rgba(255,255,255,.95);
  --border: rgba(15,23,42,.1);
  --border-strong: rgba(15,23,42,.18);
  --text: #111827;
  --muted: #55627d;
  --faint: #8b97ae;
  --shadow: 0 20px 50px -26px rgba(15,23,42,.35);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  line-height: 1.75;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
  transition: background .45s ease, color .45s ease;
}
body::before {
  content: '';
  position: fixed;
  inset: -30vmax;
  z-index: -3;
  background:
    radial-gradient(38vmax 38vmax at 18% 12%, color-mix(in srgb, var(--primary) 42%, transparent), transparent 62%),
    radial-gradient(34vmax 34vmax at 82% 8%, color-mix(in srgb, var(--primary-2) 34%, transparent), transparent 60%),
    radial-gradient(40vmax 40vmax at 72% 82%, color-mix(in srgb, var(--accent) 26%, transparent), transparent 62%),
    radial-gradient(30vmax 30vmax at 12% 88%, color-mix(in srgb, #f472b6 22%, transparent), transparent 60%);
  filter: blur(28px);
  opacity: .75;
  animation: drift 26s ease-in-out infinite alternate;
}
[data-theme='light'] body::before { opacity: .5; }
body::after {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -2;
  pointer-events: none;
  background-image: linear-gradient(rgba(255,255,255,.028) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.028) 1px, transparent 1px);
  background-size: 46px 46px;
  mask-image: radial-gradient(120vmax 90vmax at 50% 0%, #000 35%, transparent 78%);
}
@keyframes drift {
  0% { transform: translate3d(0,0,0) scale(1); }
  50% { transform: translate3d(2%, -2%, 0) scale(1.06); }
  100% { transform: translate3d(-2%, 2%, 0) scale(1.02); }
}
.wrap { width: min(100% - 2rem, var(--maxw)); margin-inline: auto; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre { font-family: var(--mono); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 8px; }

/* ---------- header ---------- */
header.top {
  position: sticky;
  top: 0;
  z-index: 50;
  backdrop-filter: blur(16px);
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  border-bottom: 1px solid var(--border);
}
.top-inner {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: .7rem 0;
  flex-wrap: wrap;
}
.brand { display: flex; align-items: center; gap: .65rem; font-weight: 800; letter-spacing: .2px; }
.brand .logo {
  width: 40px; height: 40px;
  display: grid; place-items: center;
  border-radius: 13px;
  background: linear-gradient(135deg, var(--primary), var(--primary-2));
  box-shadow: 0 10px 26px -8px var(--primary);
  font-size: 1.15rem;
}
.brand .logo svg { width: 22px; height: 22px; fill: #fff; }
.brand small { display: block; font-weight: 500; font-size: .68rem; color: var(--faint); letter-spacing: .12em; text-transform: uppercase; }
nav.main { display: flex; gap: .35rem; margin-inline-start: auto; align-items: center; flex-wrap: wrap; }
nav.main a {
  color: var(--muted);
  padding: .42rem .8rem;
  border-radius: 999px;
  font-size: .9rem;
  transition: .2s;
}
nav.main a:hover { color: var(--text); background: var(--surface); text-decoration: none; }
.icon-btn {
  width: 40px; height: 40px;
  display: grid; place-items: center;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: .2s;
  font-size: 1rem;
}
.icon-btn:hover { border-color: var(--border-strong); transform: translateY(-1px); }
.lang-toggle {
  display: flex; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--surface);
}
.lang-toggle button {
  border: 0; background: transparent; color: var(--muted); cursor: pointer;
  padding: .45rem .7rem; font-family: var(--font); font-weight: 600; font-size: .85rem; transition: .2s;
}
.lang-toggle button.active { background: linear-gradient(135deg, var(--primary), var(--primary-2)); color: #fff; }

/* ---------- hero ---------- */
.hero { padding: clamp(2.4rem, 7vw, 5rem) 0 1.6rem; text-align: center; }
.hero .pill {
  display: inline-flex; align-items: center; gap: .5rem;
  padding: .35rem .9rem; border-radius: 999px;
  background: var(--surface); border: 1px solid var(--border);
  font-size: .82rem; color: var(--muted);
}
.hero .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 4px color-mix(in srgb, var(--success) 22%, transparent); animation: pulse 2s infinite; }
@keyframes pulse { 50% { box-shadow: 0 0 0 9px color-mix(in srgb, var(--success) 0%, transparent); } }
.hero h1 {
  font-size: clamp(2.1rem, 6vw, 3.6rem);
  margin: 1rem 0 .6rem;
  line-height: 1.25;
  font-weight: 900;
  background: linear-gradient(120deg, #fff 10%, var(--accent) 45%, var(--primary-2) 80%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
[data-theme='light'] .hero h1 { background: linear-gradient(120deg, #0f172a 10%, var(--primary) 55%, var(--primary-2) 85%); -webkit-background-clip: text; background-clip: text; }
.hero p { color: var(--muted); max-width: 62ch; margin-inline: auto; font-size: 1.02rem; }
.chips { display: flex; gap: .5rem; justify-content: center; flex-wrap: wrap; margin-top: 1.2rem; }
.chip {
  padding: .32rem .8rem; border-radius: 999px; font-size: .8rem;
  background: var(--surface); border: 1px solid var(--border); color: var(--muted);
}

/* ---------- cards ---------- */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  backdrop-filter: blur(14px);
  box-shadow: var(--shadow);
  padding: clamp(1.1rem, 2.4vw, 1.7rem);
  margin-bottom: 1.4rem;
}
.card h2 { margin: 0 0 .2rem; font-size: 1.25rem; }
.card .sub { color: var(--faint); font-size: .88rem; margin: 0 0 1.1rem; }
.grid { display: grid; gap: 1.4rem; }
@media (min-width: 900px) { .grid.two { grid-template-columns: 1.15fr .85fr; align-items: start; } }

/* ---------- tabs ---------- */
.tabs { display: flex; gap: .4rem; background: var(--surface); border: 1px solid var(--border); padding: .32rem; border-radius: 999px; overflow-x: auto; margin-bottom: 1.2rem; }
.tabs button {
  flex: 1; white-space: nowrap;
  border: 0; background: transparent; color: var(--muted);
  font-family: var(--font); font-weight: 700; font-size: .92rem;
  padding: .55rem 1rem; border-radius: 999px; cursor: pointer; transition: .22s;
}
.tabs button.active { color: #fff; background: linear-gradient(135deg, var(--primary), var(--primary-2)); box-shadow: 0 10px 24px -12px var(--primary); }
.panel { display: none; animation: fade .35s ease; }
.panel.active { display: block; }
@keyframes fade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

/* ---------- recorder ---------- */
.recorder { display: grid; gap: 1.1rem; justify-items: center; text-align: center; }
.mic-btn {
  width: 132px; height: 132px; border-radius: 50%; border: 0; cursor: pointer;
  background: radial-gradient(circle at 32% 28%, #ff8fa3, #e11d48 55%, #9f1239);
  box-shadow: 0 22px 50px -18px #e11d48, inset 0 -6px 16px rgba(0,0,0,.35);
  display: grid; place-items: center; position: relative; transition: transform .2s;
}
.mic-btn:hover { transform: scale(1.04); }
.mic-btn svg { width: 46px; height: 46px; fill: #fff; }
.mic-btn::after {
  content: ''; position: absolute; inset: -14px; border-radius: 50%;
  border: 2px solid rgba(225,29,72,.4); animation: ring 2.4s ease-out infinite;
}
.mic-btn.recording::after { border-color: rgba(225,29,72,.75); animation-duration: 1s; }
@keyframes ring { 0% { transform: scale(.9); opacity: .9; } 100% { transform: scale(1.35); opacity: 0; } }
.timer { font-family: var(--mono); font-size: 1.5rem; font-weight: 700; letter-spacing: .06em; }
canvas.wave { width: 100%; height: 120px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--bg-2) 70%, transparent); border: 1px solid var(--border); }
.level { width: min(320px, 100%); height: 6px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.level span { display: block; height: 100%; width: 0%; background: linear-gradient(90deg, var(--accent), var(--success)); transition: width .1s linear; }

/* ---------- forms ---------- */
.field { display: grid; gap: .45rem; margin-bottom: .9rem; }
label { font-size: .86rem; color: var(--muted); font-weight: 600; }
input[type='text'], input[type='url'], input[type='search'], textarea, select {
  width: 100%;
  padding: .78rem 1rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-2) 62%, transparent);
  color: var(--text);
  font-family: var(--font);
  font-size: .98rem;
  transition: .2s;
}
input:focus, textarea:focus, select:focus { border-color: var(--primary); box-shadow: 0 0 0 4px color-mix(in srgb, var(--primary) 18%, transparent); outline: none; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: .5rem;
  border: 0; cursor: pointer; font-family: var(--font); font-weight: 700; font-size: .95rem;
  padding: .78rem 1.4rem; border-radius: var(--radius-sm);
  background: linear-gradient(135deg, var(--primary), var(--primary-2));
  color: #fff; transition: .22s; box-shadow: 0 14px 30px -16px var(--primary);
}
.btn:hover { transform: translateY(-2px); filter: brightness(1.06); }
.btn:disabled { opacity: .55; cursor: not-allowed; transform: none; }
.btn.ghost { background: var(--surface); color: var(--text); border: 1px solid var(--border); box-shadow: none; }
.btn.ghost:hover { border-color: var(--border-strong); }
.btn.small { padding: .45rem .85rem; font-size: .82rem; }
.row { display: flex; gap: .6rem; flex-wrap: wrap; align-items: center; }
.drop {
  border: 2px dashed var(--border-strong);
  border-radius: var(--radius);
  padding: 2.2rem 1rem;
  text-align: center;
  color: var(--muted);
  cursor: pointer;
  transition: .22s;
  background: color-mix(in srgb, var(--bg-2) 35%, transparent);
}
.drop:hover, .drop.over { border-color: var(--primary); color: var(--text); background: color-mix(in srgb, var(--primary) 9%, transparent); }
.drop svg { width: 44px; height: 44px; opacity: .7; }

/* ---------- status / loader ---------- */
.status { display: flex; align-items: center; gap: .6rem; margin-top: .9rem; font-size: .88rem; color: var(--muted); }
.spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--border-strong); border-top-color: var(--accent); animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.bar { height: 4px; border-radius: 999px; background: var(--surface-2); overflow: hidden; margin-top: .7rem; }
.bar span { display: block; height: 100%; width: 30%; background: linear-gradient(90deg, var(--accent), var(--primary-2)); animation: slide 1.2s ease-in-out infinite; }
@keyframes slide { 0% { transform: translateX(-120%); } 100% { transform: translateX(420%); } }

/* ---------- result ---------- */
.result { display: grid; gap: 1.2rem; }
.result-head { display: flex; gap: 1.1rem; align-items: center; flex-wrap: wrap; }
.art {
  width: 148px; height: 148px; border-radius: 20px; object-fit: cover;
  background: var(--surface-2); border: 1px solid var(--border);
  box-shadow: 0 24px 50px -22px rgba(0,0,0,.8);
}
.meta { flex: 1; min-width: 220px; }
.meta h3 { margin: 0; font-size: 1.35rem; line-height: 1.35; }
.meta .artist { color: var(--muted); font-size: 1rem; margin-top: .15rem; }
.conf { display: flex; align-items: center; gap: .7rem; margin-top: .7rem; }
.ring { width: 52px; height: 52px; flex: none; }
.ring circle { fill: none; stroke-width: 5; }
.ring .track { stroke: var(--surface-2); }
.ring .val { stroke: url(#ringGrad); stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dashoffset .9s ease; }
.ring text { fill: var(--text); font-size: 13px; font-weight: 700; font-family: var(--mono); }
.kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .7rem; margin-top: 1.1rem; }
.kv .cell { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: .6rem .8rem; }
.kv .k { font-size: .72rem; color: var(--faint); text-transform: uppercase; letter-spacing: .08em; }
.kv .v { font-size: .92rem; font-weight: 600; word-break: break-word; }
.lyrics {
  max-height: 340px; overflow: auto; white-space: pre-wrap;
  background: color-mix(in srgb, var(--bg-2) 60%, transparent);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 1rem 1.1rem; font-size: .94rem; line-height: 2; color: var(--muted);
}
.links { display: flex; flex-wrap: wrap; gap: .5rem; }
.links a {
  padding: .38rem .8rem; border-radius: 999px; font-size: .83rem; font-weight: 600;
  background: var(--surface); border: 1px solid var(--border); color: var(--text);
  transition: .2s;
}
.links a:hover { border-color: var(--primary); text-decoration: none; transform: translateY(-1px); }
.badge { display: inline-block; padding: .18rem .6rem; border-radius: 999px; font-size: .72rem; font-weight: 700; background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); }
.empty { text-align: center; color: var(--faint); padding: 2.2rem 1rem; }
.empty svg { width: 60px; height: 60px; opacity: .35; margin-bottom: .6rem; }
.history { display: flex; gap: .6rem; flex-wrap: wrap; }
.history button {
  border: 1px solid var(--border); background: var(--surface); color: var(--muted);
  border-radius: 999px; padding: .3rem .75rem; font-size: .78rem; cursor: pointer; font-family: var(--font);
  max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.history button:hover { color: var(--text); border-color: var(--border-strong); }

/* ---------- docs ---------- */
.docs-grid { display: grid; gap: 1rem; }
table.api { width: 100%; border-collapse: collapse; font-size: .88rem; }
table.api th, table.api td { padding: .6rem .7rem; text-align: start; border-bottom: 1px solid var(--border); vertical-align: top; }
table.api th { color: var(--faint); font-weight: 700; font-size: .78rem; text-transform: uppercase; letter-spacing: .07em; }
table.api code { color: var(--accent); font-size: .84rem; }
.method { display: inline-block; padding: .1rem .45rem; border-radius: 6px; font-size: .7rem; font-weight: 800; font-family: var(--mono); }
.method.get { background: color-mix(in srgb, var(--success) 20%, transparent); color: var(--success); }
.method.post { background: color-mix(in srgb, var(--primary) 24%, transparent); color: #c9c2ff; }
[data-theme='light'] .method.post { color: var(--primary); }
.code-tabs { display: flex; gap: .35rem; flex-wrap: wrap; margin-bottom: .6rem; }
.code-tabs button {
  border: 1px solid var(--border); background: var(--surface); color: var(--muted);
  border-radius: 10px; padding: .32rem .75rem; font-size: .8rem; cursor: pointer; font-family: var(--mono);
}
.code-tabs button.active { color: #fff; background: linear-gradient(135deg, var(--primary), var(--primary-2)); border-color: transparent; }
pre.code {
  background: #05070f; color: #d7e0f5; border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 1rem 1.1rem; overflow: auto;
  font-size: .84rem; line-height: 1.85; direction: ltr; text-align: left;
}
pre.code .c { color: #7d8aa8; }
pre.code .s { color: #7ee7b0; }
pre.code .k { color: #c9c2ff; }
.note {
  border-inline-start: 3px solid var(--warn);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  padding: .8rem 1rem; border-radius: 10px; font-size: .87rem; color: var(--muted);
}
.note strong { color: var(--text); }
.faq details { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: .7rem 1rem; margin-bottom: .6rem; background: var(--surface); }
.faq summary { cursor: pointer; font-weight: 700; font-size: .95rem; }
.faq details p { margin: .6rem 0 0; color: var(--muted); font-size: .9rem; }

/* ---------- footer ---------- */
footer { padding: 2.4rem 0 3rem; color: var(--faint); font-size: .86rem; text-align: center; border-top: 1px solid var(--border); margin-top: 2rem; }
footer .social { display: flex; gap: .5rem; justify-content: center; margin-bottom: .8rem; }
.toast {
  position: fixed; inset-block-end: 1.4rem; inset-inline-start: 50%;
  transform: translate(50%, 140%);
  background: var(--surface-2); border: 1px solid var(--border-strong);
  padding: .7rem 1.2rem; border-radius: 999px; z-index: 99;
  box-shadow: var(--shadow); transition: transform .35s cubic-bezier(.2,.9,.3,1.4); font-size: .9rem;
}
.toast.show { transform: translate(50%, 0); }
/* ---------- reveal (progressive enhancement) ----------
   The content is ALWAYS visible: opacity 1 is the default state and the
   entrance animation is only *armed* when the page script runs (html.js) and
   an IntersectionObserver is available (html.can-observe). If the script dies,
   the observer is missing, the browser is ancient or the visitor asked for
   reduced motion, the sections simply stay visible instead of vanishing. */
.reveal { opacity: 1; transform: none; }
html.js .reveal { transition: opacity .7s ease, transform .7s ease; }
html.js.can-observe .reveal { opacity: 0; transform: translateY(24px); }
html.js.can-observe .reveal.in { opacity: 1; transform: none; }

/* The <noscript> hint is only shown when the page script did not run. */
.no-js-note { display: none; }
html:not(.js) .no-js-note { display: block; }

/* Code samples: every panel is visible until the tab script takes over. */
.code-panel { display: block; }
html.tabs-ready .code-panel { display: none; }
html.tabs-ready .code-panel.active { display: block; }
html:not(.tabs-ready) .code-tabs { display: none; }
.code-panel + .code-panel { margin-top: 1.1rem; }
.code-label {
  font-family: var(--mono); font-size: .74rem; font-weight: 700; letter-spacing: .08em;
  text-transform: uppercase; color: var(--faint); margin-bottom: .35rem;
}
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
  html.js.can-observe .reveal { opacity: 1; transform: none; }
}
@media (max-width: 640px) {
  .art { width: 108px; height: 108px; }
  nav.main a { padding: .35rem .6rem; font-size: .82rem; }
  .hero h1 { font-size: 1.9rem; }
}
`;

/* ------------------------------------------------------------------------- */

/* ======================= bilingual dictionary ======================= */
const I18N_UI = {
  fa: {
    brand: 'شزم', nav_studio: 'استودیو', nav_result: 'نتیجه', nav_docs: 'مستندات',
    hero_pill: 'زنده روی Cloudflare Workers',
    hero_title: 'آهنگ را بشناس',
    hero_text: 'صدای زنده، فایل صوتی، ویدیو یا حتی یک خط از ترانه را بده؛ شزم در چند ثانیه نام آهنگ، خواننده، آلبوم و متن کامل ترانه را برمی‌گرداند.',
    chip1: 'اثر انگشت Shazam', chip2: 'متن کامل ترانه', chip3: 'فرم‌فا / انگلیسی',
    chip4: 'بدون کلید API', chip5: 'تک‌فایل · بدون وابستگی',
    studio_title: 'استودیوی تشخیص', studio_sub: 'یکی از روش‌ها را انتخاب کن.',
    tab_mic: 'ضبط صدا', tab_upload: 'بارگذاری فایل', tab_url: 'لینک ویدیو', tab_text: 'متن / ترانه',
    mic_start: 'شروع ضبط', mic_stop: 'پایان و تشخیص',
    mic_hint: 'حداکثر ۱۲ ثانیه ضبط می‌شود؛ همین بخش کافی است.',
    drop_title: 'فایل را اینجا رها کن یا کلیک کن',
    drop_sub: 'MP3 · M4A · WAV · OGG · FLAC · MP4 · WebM',
    opt_lyrics: 'گزینه‌ها', opt_lyrics_text: 'دریافت متن ترانه',
    url_label: 'لینک مستقیم ویدیو یا فایل صوتی', url_submit: 'تشخیص از لینک',
    url_note: 'برای پردازش ویدیو، سرور باید متغیر محیطی BACKEND_URL را تنظیم کرده باشد (پایتون + ffmpeg). اگر تنظیم نباشد، پاسخ دقیق و روشنی دریافت می‌کنید.',
    text_label: 'نام آهنگ، خواننده یا یک خط از ترانه', text_submit: 'جستجو',
    text_lyrics: 'همراه با ترانه',
    result_title: 'نتیجه', result_sub: 'جزئیات آهنگ شناسایی‌شده.',
    result_empty: 'هنوز چیزی شناسایی نشده است.',
    history_label: 'تاریخچهٔ اخیر',
    docs_title: 'مستندات API',
    docs_sub: 'همهٔ پاسخ‌ها JSON هستند و نسخهٔ v1 دارند. زبان پاسخ با ?lang=fa یا هدر Accept-Language تعیین می‌شود.',
    th_method: 'متد', th_path: 'مسیر', th_desc: 'توضیح',
    ep_recognize: 'تشخیص آهنگ از اثر انگشت، PCM یا فایل WAV',
    ep_url: 'تشخیص از لینک ویدیو/صدا (نیازمند BACKEND_URL)',
    ep_search: 'جستجو با نام، خواننده یا متن ترانه',
    ep_lyrics: 'دریافت متن ترانه', ep_info: 'مشخصات سرویس',
    ep_providers: 'سرویس‌های بیرونی', ep_openapi: 'توصیف OpenAPI 3.1',
    ep_health: 'بررسی سلامت سرویس',
    docs_examples: 'نمونه کد', docs_errors: 'جدول کدهای خطا',
    th_code: 'کد', th_status: 'وضعیت', th_meaning: 'معنی',
    note_title: 'نکات مهم و محدودیت‌ها',
    note_body: '<li>این سرویس از API غیررسمی Shazam استفاده می‌کند؛ استفادهٔ شخصی و غیرتجاری مجاز است و مسئولیت رعایت شرایط استفاده بر عهدهٔ کاربر است.</li><li>در پلن رایگان Cloudflare سقف CPU هر درخواست ۱۰ میلی‌ثانیه است؛ محاسبهٔ اثر انگشت در مرورگر انجام می‌شود تا همیشه کار کند. برای محاسبهٔ سمت سرور، پلن دارای CPU کافی لازم است.</li><li>Worker فقط WAV را به‌صورت بومی رمزگشایی می‌کند؛ برای MP4/MKV و سایر فرمت‌ها BACKEND_URL لازم است.</li><li>پاسخ‌ها در KV و D1 کش می‌شوند؛ نتایج شناسایی ۲۴ ساعت و نتایج جستجو ۶ ساعت نگهداری می‌شوند.</li><li>پاسخ‌ها دو زبانه‌اند: هر پیام هم به انگلیسی و هم به فارسی برگردانده می‌شود.</li>',
    docs_faq: 'پرسش‌های پرتکرار',
    footer_credit: 'ساخته‌شده با ❤️ توسط', footer_license: 'پروانهٔ MIT',
    err_generic: 'خطایی رخ داد', please_wait: 'در حال پردازش…', listening: 'در حال شنیدن…',
    analysing: 'در حال تحلیل صدا…', done: 'انجام شد', copy: 'کپی',
    no_lyrics: 'متن ترانه‌ای یافت نشد', cached: 'از کش',
    source: 'منبع', confidence: 'اطمینان', album: 'آلبوم', year: 'سال',
    genre: 'ژانر', label: 'ناشر', duration: 'مدت', isrc: 'ISRC', bpm: 'BPM',
    lyrics_title: 'متن ترانه', links_title: 'پلتفرم‌ها', open_links: 'لینک‌ها',
    faq: [
      ['چه فرمت‌هایی پشتیبانی می‌شوند؟', 'مرورگر فایل را با Web Audio API به PCM مونو ۱۶ کیلوهرتز تبدیل می‌کند، پس MP3، M4A، WAV، OGG، FLAC و در بیشتر مرورگرها MP4 و WebM هم کار می‌کنند. Worker به‌تنهایی فقط WAV را می‌خواند.'],
      ['چرا اثر انگشت در مرورگر ساخته می‌شود؟', 'پلن رایگان Cloudflare برای هر درخواست فقط ۱۰ میلی‌ثانیه CPU می‌دهد و محاسبهٔ FFT کاملاً بیشتر از آن است. با محاسبه در مرورگر، سرویس روی همهٔ پلن‌ها کار می‌کند و سریع‌تر هم هست. اگر محاسبهٔ مرورگر شکست بخورد، به‌صورت خودکار PCM برای سرور فرستاده می‌شود.'],
      ['آیا برای استفاده از API کلید لازم است؟', 'خیر. تمام سرویس‌های بیرونی بدون کلید کار می‌کنند. تنها متغیر اختیاری BACKEND_URL برای پردازش ویدیو/فرمت‌های غیرWAV است.'],
      ['متن ترانه از کجا می‌آید؟', 'از lyrics.ovh و در صورت ناموفق بودن از LRCLIB. اگر هیچ‌کدام پاسخ ندهند، فیلد lyrics.available برابر false قرار می‌گیرد و چیزی حدس زده نمی‌شود.'],
      ['آیا می‌توانم از این سرویس در پروژهٔ تجاری استفاده کنم؟', 'پروژه تحت پروانهٔ MIT است، اما سرویس زیربنایی (Shazam) رسمی نیست. برای استفادهٔ تجاری به‌شدت توصیه می‌شود از یک ارائه‌دهندهٔ دارای لایسنس رسمی استفاده کنید.'],
      ['چطور می‌توانم فراتر از محدودیت نرخ درخواست کار کنم؟', 'متغیرهای RATE_LIMIT_PER_MINUTE و RATE_LIMIT_RECOGNIZE_PER_MINUTE را در تنظیمات Worker تغییر دهید.']
    ]
  },
  en: {
    brand: 'Shzm', nav_studio: 'Studio', nav_result: 'Result', nav_docs: 'Docs',
    hero_pill: 'Live on Cloudflare Workers',
    hero_title: 'Recognise any song',
    hero_text: 'Give us live audio, an audio file, a video or a single lyric line — Shzm returns the title, artist, album and the full lyrics within seconds.',
    chip1: 'Shazam fingerprint', chip2: 'Full lyrics', chip3: 'Persian / English',
    chip4: 'No API key', chip5: 'Single file · zero dependencies',
    studio_title: 'Recognition studio', studio_sub: 'Pick one of the methods.',
    tab_mic: 'Record', tab_upload: 'Upload', tab_url: 'Video link', tab_text: 'Text / lyrics',
    mic_start: 'Start recording', mic_stop: 'Stop & recognise',
    mic_hint: 'Only the first 12 seconds are analysed — that is plenty.',
    drop_title: 'Drop a file here or click to browse',
    drop_sub: 'MP3 · M4A · WAV · OGG · FLAC · MP4 · WebM',
    opt_lyrics: 'Options', opt_lyrics_text: 'Fetch lyrics',
    url_label: 'Direct video or audio URL', url_submit: 'Recognise from URL',
    url_note: 'Video processing requires the BACKEND_URL environment variable (Python + ffmpeg). If it is not configured you get a precise, explicit error.',
    text_label: 'Song title, artist or a lyric line', text_submit: 'Search',
    text_lyrics: 'Include lyrics',
    result_title: 'Result', result_sub: 'Details of the recognised song.',
    result_empty: 'Nothing recognised yet.',
    history_label: 'Recent history',
    docs_title: 'API documentation',
    docs_sub: 'Every response is JSON and versioned with v1. The response language follows ?lang=fa or the Accept-Language header.',
    th_method: 'Method', th_path: 'Path', th_desc: 'Description',
    ep_recognize: 'Recognise from a fingerprint, PCM or WAV file',
    ep_url: 'Recognise from a video/audio URL (requires BACKEND_URL)',
    ep_search: 'Search by title, artist or lyrics',
    ep_lyrics: 'Fetch lyrics', ep_info: 'Service information',
    ep_providers: 'Upstream providers', ep_openapi: 'OpenAPI 3.1 description',
    ep_health: 'Service health probe',
    docs_examples: 'Code samples', docs_errors: 'Error code table',
    th_code: 'Code', th_status: 'Status', th_meaning: 'Meaning',
    note_title: 'Important notes and limitations',
    note_body: '<li>This service uses the unofficial Shazam API; personal, non-commercial use is fine, but you are responsible for complying with the terms of service.</li><li>The free Cloudflare plan allows 10 ms of CPU per request, which is not enough to compute the FFT fingerprint. The fingerprint is therefore computed in the browser so the service works on every plan. Server-side fingerprinting needs a plan with enough CPU time.</li><li>The Worker decodes WAV natively. MP4/MKV and other formats require BACKEND_URL.</li><li>Results are cached in KV and D1: recognitions for 24 hours, searches for 6 hours.</li><li>Every message is bilingual — English and Persian are always included.</li>',
    docs_faq: 'Frequently asked questions',
    footer_credit: 'Built with ❤️ by', footer_license: 'MIT License',
    err_generic: 'Something went wrong', please_wait: 'Processing…', listening: 'Listening…',
    analysing: 'Analysing audio…', done: 'Done', copy: 'Copy',
    no_lyrics: 'No lyrics found', cached: 'cached',
    source: 'Source', confidence: 'Confidence', album: 'Album', year: 'Year',
    genre: 'Genre', label: 'Label', duration: 'Duration', isrc: 'ISRC', bpm: 'BPM',
    lyrics_title: 'Lyrics', links_title: 'Platforms', open_links: 'Links',
    faq: [
      ['Which formats are supported?', 'The browser converts the file to 16 kHz mono PCM with the Web Audio API, so MP3, M4A, WAV, OGG, FLAC and — in most browsers — MP4 and WebM all work. The Worker itself only reads WAV.'],
      ['Why is the fingerprint computed in the browser?', 'The free Cloudflare plan grants only 10 ms of CPU per request, and a full FFT needs far more. Computing it client-side keeps the service working on every plan and makes it faster. If the browser-side computation fails, the raw PCM is sent to the server automatically.'],
      ['Do I need an API key?', 'No. All upstream services are key-free. The only optional variable is BACKEND_URL, used for video and non-WAV formats.'],
      ['Where do the lyrics come from?', 'lyrics.ovh first, then LRCLIB. If neither answers, lyrics.available is false — nothing is ever guessed.'],
      ['Can I use this in a commercial product?', 'The project is MIT licensed, but the underlying Shazam service is not official. For commercial use we strongly recommend a provider with a proper licence.'],
      ['How do I raise the rate limit?', 'Change RATE_LIMIT_PER_MINUTE and RATE_LIMIT_RECOGNIZE_PER_MINUTE in the Worker settings.']
    ]
  }
};

/* ---------------------------------------------------------------------------
 * 16 · Static page content
 *
 * Everything below is rendered on the server so the page is complete even
 * when the browser never runs the page script (no JavaScript, a blocked
 * module, an in-app browser that refuses localStorage, an old WebView …).
 * The client script only *replaces* this content when the visitor switches
 * the interface language.
 * ------------------------------------------------------------------------- */

/** The six code sample tabs of the documentation section. */
const CODE_TABS = [
  ['curl', 'cURL'],
  ['python', 'Python'],
  ['php', 'PHP'],
  ['js', 'JavaScript'],
  ['node', 'Node.js'],
  ['telegram', 'Telegram'],
];

/**
 * The code samples, kept in one place: the documentation section renders
 * them server side, the browser only toggles between the rendered panels.
 */
const CODE_SAMPLES = {
  curl: [
    '# Recognise a song (fingerprint, PCM or WAV)',
    'curl -X POST "$BASE/api/v1/recognize" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Accept-Language: fa" \\',
    '  -d \'{"signature":"data:audio/vnd.shazam.sig;base64,AAAA...","samplems":12000,"lyrics":true}\'',
    '',
    '# Search by title / artist / lyric line',
    'curl -X POST "$BASE/api/v1/search" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d \'{"query":"Coldplay Paradise","limit":5,"lyrics":true}\'',
    '',
    '# Lyrics only',
    'curl "$BASE/api/v1/lyrics?artist=Coldplay&title=Paradise&lang=fa"',
  ],
  python: [
    'import requests',
    '',
    'BASE = "https://shzm.example.workers.dev"',
    '',
    'def recognize_wav(path: str) -> dict:',
    '    with open(path, "rb") as fh:',
    '        wav = fh.read()',
    '    r = requests.post(',
    '        f"{BASE}/api/v1/recognize",',
    '        files={"file": ("clip.wav", wav, "audio/wav")},',
    '        data={"lyrics": "true"},',
    '        headers={"Accept-Language": "fa"},',
    '        timeout=60,',
    '    )',
    '    r.raise_for_status()',
    '    body = r.json()',
    '    return body["data"]',
    '',
    'def search(query: str, limit: int = 5) -> dict:',
    '    r = requests.post(',
    '        f"{BASE}/api/v1/search",',
    '        json={"query": query, "limit": limit, "lyrics": True},',
    '        timeout=30,',
    '    )',
    '    r.raise_for_status()',
    '    return r.json()["data"]',
    '',
    'def lyrics(artist: str, title: str) -> str:',
    '    r = requests.get(f"{BASE}/api/v1/lyrics",',
    '                     params={"artist": artist, "title": title}, timeout=30)',
    '    r.raise_for_status()',
    '    return r.json()["data"]["text"]',
    '',
    'result = recognize_wav("clip.wav")',
    'print(result["title"], "-", result["artist"], result["confidence"])',
  ],
  php: [
    '<?php',
    '$BASE = "https://shzm.example.workers.dev";',
    '',
    '// --- recognise a WAV file ---',
    '$wav = file_get_contents("clip.wav");',
    '$ch  = curl_init($BASE . "/api/v1/recognize");',
    'curl_setopt_array($ch, [',
    '    CURLOPT_POST           => true,',
    '    CURLOPT_RETURNTRANSFER => true,',
    '    CURLOPT_HTTPHEADER     => ["Accept-Language: fa"],',
    '    CURLOPT_POSTFIELDS     => [',
    '        "file"   => new CURLFile("clip.wav", "audio/wav", "clip.wav"),',
    '        "lyrics" => "true",',
    '    ],',
    ']);',
    '$body = json_decode(curl_exec($ch), true);',
    'curl_close($ch);',
    'echo $body["data"]["title"] . " - " . $body["data"]["artist"];',
    '',
    '// --- search ---',
    '$ch = curl_init($BASE . "/api/v1/search");',
    'curl_setopt_array($ch, [',
    '    CURLOPT_POST           => true,',
    '    CURLOPT_RETURNTRANSFER => true,',
    '    CURLOPT_HTTPHEADER     => ["Content-Type: application/json"],',
    '    CURLOPT_POSTFIELDS     => json_encode([',
    '        "query"  => "Coldplay Paradise",',
    '        "limit"  => 5,',
    '        "lyrics" => true,',
    '    ]),',
    ']);',
    '$search = json_decode(curl_exec($ch), true);',
    'curl_close($ch);',
    'foreach ($search["data"]["results"] as $row) {',
    '    echo $row["title"] . " - " . $row["artist"];',
    '}',
  ],
  js: [
    '// Browser (fetch)',
    'const BASE = "https://shzm.example.workers.dev";',
    '',
    '// Recognise a File object (any format the browser can decode)',
    'async function recognise(file) {',
    '  const form = new FormData();',
    '  form.append("file", file);',
    '  form.append("lyrics", "true");',
    '  const res = await fetch(`${BASE}/api/v1/recognize`, { method: "POST", body: form });',
    '  const body = await res.json();',
    '  if (!body.ok) throw new Error(body.error?.message || "request failed");',
    '  return body.data;',
    '}',
    '',
    '// Search',
    'async function search(query) {',
    '  const res = await fetch(`${BASE}/api/v1/search`, {',
    '    method: "POST",',
    '    headers: { "Content-Type": "application/json" },',
    '    body: JSON.stringify({ query, limit: 5, lyrics: true }),',
    '  });',
    '  return (await res.json()).data;',
    '}',
    '',
    'const track = await recognise(document.querySelector("input[type=file]").files[0]);',
    'console.log(track.title, track.artist, track.confidence);',
  ],
  node: [
    '// Node.js 18+ (fetch is built in)',
    'import { readFile } from "node:fs/promises";',
    '',
    'const BASE = "https://shzm.example.workers.dev";',
    '',
    'async function recogniseWav(path) {',
    '  const wav = await readFile(path);',
    '  const form = new FormData();',
    '  form.append("file", new Blob([wav], { type: "audio/wav" }), "clip.wav");',
    '  form.append("lyrics", "true");',
    '',
    '  const res = await fetch(`${BASE}/api/v1/recognize`, { method: "POST", body: form });',
    '  const body = await res.json();',
    '  if (!body.ok) throw new Error(`${body.error.code}: ${body.error.message}`);',
    '  return body.data;',
    '}',
    '',
    'async function search(query) {',
    '  const res = await fetch(`${BASE}/api/v1/search`, {',
    '    method: "POST",',
    '    headers: { "Content-Type": "application/json" },',
    '    body: JSON.stringify({ query, limit: 5, lyrics: true }),',
    '  });',
    '  return (await res.json()).data;',
    '}',
    '',
    'const track = await recogniseWav("clip.wav");',
    'console.log(`${track.title} - ${track.artist} (${track.confidence}%)`);',
    'console.log(track.lyrics?.text ?? "no lyrics");',
  ],
  telegram: [
    '# Telegram bot (python-telegram-bot) - send a voice note or an audio file',
    'import os, requests',
    'from telegram import Update',
    'from telegram.ext import ApplicationBuilder, CommandHandler, MessageHandler, filters',
    '',
    'BASE = os.environ["SHZM_BASE"]          # e.g. https://shzm.example.workers.dev',
    '',
    'async def on_voice(update: Update, ctx):',
    '    voice = await update.message.voice.get_file()',
    '    wav = await voice.download_as_bytearray()',
    '    res = requests.post(',
    '        f"{BASE}/api/v1/recognize",',
    '        files={"file": ("voice.wav", bytes(wav), "audio/wav")},',
    '        data={"lyrics": "true"},',
    '        timeout=60,',
    '    )',
    '    data = res.json()["data"]',
    '    if not data.get("found"):',
    '        await update.message.reply_text("No result was found.")',
    '        return',
    '    text = (',
    '        f"{data[\'title\']}\\n"',
    '        f"{data[\'artist\']}\\n"',
    '        f"{data[\'track\'].get(\'album\') or \'-\'}\\n"',
    '        f"{data[\'track\'][\'links\'].get(\'shazam\', \'-\')}\\n\\n"',
    '        f"{data.get(\'lyrics\', {}).get(\'text\', \'\')}"',
    '    )',
    '    await update.message.reply_text(text[:4000], disable_web_page_preview=True)',
    '',
    'async def on_audio(update: Update, ctx):',
    '    f = await update.message.audio.get_file()',
    '    raw = await f.download_as_bytearray()',
    '    res = requests.post(',
    '        f"{BASE}/api/v1/recognize",',
    '        files={"file": (f.file_path or "audio.wav", bytes(raw), "audio/mpeg")},',
    '        data={"lyrics": "true"},',
    '        timeout=60,',
    '    )',
    '    await update.message.reply_text(res.json()["data"]["title"])',
    '',
    'app = ApplicationBuilder().token(os.environ["TELEGRAM_BOT_TOKEN"]).build()',
    'app.add_handler(MessageHandler(filters.VOICE, on_voice))',
    'app.add_handler(MessageHandler(filters.AUDIO, on_audio))',
    'app.run_polling()',
  ],
};

/** Escape a text so it can be embedded safely in HTML. */
function htmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The error code table of the documentation section (server rendered). */
function buildErrorRowsHtml() {
  return Object.keys(ERROR_CODES)
    .filter((code) => code !== 'E_OK')
    .map((code) => {
      const meta = ERROR_CODES[code];
      return (
        '<tr><td><code>' + code + '</code></td>' +
        '<td>' + meta.status + '</td>' +
        '<td>' + htmlEscape(meta.fa) + '</td></tr>'
      );
    })
    .join('');
}

/** The six code sample panels of the documentation section (server rendered). */
function buildCodePanelsHtml() {
  return CODE_TABS.map(([id, label], index) =>
    '<div class="code-panel' + (index === 0 ? ' active' : '') + '" data-code="' + id + '">' +
      '<div class="code-label">' + label + '</div>' +
      '<pre class="code">' + htmlEscape(CODE_SAMPLES[id].join('\n')) + '</pre>' +
    '</div>'
  ).join('');
}

/** The FAQ list of the documentation section (server rendered). */
function buildFaqHtml(list) {
  return list
    .map(([question, answer]) =>
      '<details><summary>' + htmlEscape(question) + '</summary>' +
      '<p>' + htmlEscape(answer) + '</p></details>')
    .join('');
}

const ASSET_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="fa" dir="rtl" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Shzm — سرویس حرفه‌ای تشخیص موزیک با Worker: صدا، ویدیو، متن و ترانه.">
<meta name="theme-color" content="#070b16">
<title>شزم · Shzm — تشخیص هوشمند موزیک</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css">
<link rel="stylesheet" href="/static/app.css">
<script>document.documentElement.classList.add('js');</script>
</head>
<body>
<header class="top">
  <div class="wrap top-inner">
    <a class="brand" href="/">
      <span class="logo"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.6 0 3.2.3 4.6.9l-1.8 3.1A8 8 0 0 0 12 8V4zm-2 0v4a8 8 0 0 0-3.4 1.3L5 5.6A10 10 0 0 1 10 4zm-5 3.2 1.8 3.1A8 8 0 0 0 4 16H2a10 10 0 0 1 3-8.8zm5 12.8a8 8 0 0 1-3.7-1.5L6.5 15A8 8 0 0 0 10 16v4zM12 18a8 8 0 0 1-4.6-1.5 8 8 0 0 0 4.6-4.5V18zm2 2v-4a8 8 0 0 0 4.5-1.5L20 18.4A10 10 0 0 1 14 20zm6-4h-2a8 8 0 0 0-1.2-4.3l1.8-3.1A10 10 0 0 1 20 16zM8.5 9.3 6.7 6.2A10 10 0 0 1 12 4v4a8 8 0 0 0-3.5 1.3z"/></svg></span>
      <span><span data-i18n="brand">شزم</span><small>Shzm · Music Recognition</small></span>
    </a>
    <nav class="main">
      <a href="#studio" data-i18n="nav_studio">استودیو</a>
      <a href="#result" data-i18n="nav_result">نتیجه</a>
      <a href="#docs" data-i18n="nav_docs">مستندات</a>
      <a href="https://github.com/AliMsvD/Shazam" target="_blank" rel="noopener">GitHub</a>
      <div class="lang-toggle" role="group" aria-label="Language">
        <button type="button" data-lang="fa" class="active">فا</button>
        <button type="button" data-lang="en">EN</button>
      </div>
      <button class="icon-btn" id="themeBtn" type="button" title="Theme" aria-label="Toggle theme">◐</button>
    </nav>
  </div>
</header>

<main>
  <noscript><p class="note no-js-note" role="note"><strong>JavaScript غیرفعال است.</strong> ضبط صدا، بارگذاری فایل و جستجوی زنده به JavaScript نیاز دارند، اما مستندات، جدول کدهای خطا و همهٔ نمونه‌کدهای پایین همین صفحه بدون JavaScript هم کاملاً قابل خواندن است. · JavaScript is disabled: recording, upload and live search need it, but the documentation, the error-code table and every code sample below are fully readable without it.</p></noscript>
  <section class="hero wrap">
    <span class="pill"><span class="dot"></span><span data-i18n="hero_pill">زنده روی Cloudflare Workers</span></span>
    <h1 data-i18n="hero_title">آهنگ را بشناس</h1>
    <p data-i18n="hero_text">صدای زنده، فایل صوتی، ویدیو یا حتی یک خط از ترانه را بده؛ شزم در چند ثانیه نام آهنگ، خواننده، آلبوم و متن کامل ترانه را برمی‌گرداند.</p>
    <div class="chips">
      <span class="chip" data-i18n="chip1">اثر انگشت Shazam</span>
      <span class="chip" data-i18n="chip2">متن کامل ترانه</span>
      <span class="chip" data-i18n="chip3">فرم‌فا / انگلیسی</span>
      <span class="chip" data-i18n="chip4">بدون کلید API</span>
      <span class="chip" data-i18n="chip5">تک‌فایل · بدون وابستگی</span>
    </div>
  </section>

  <section class="wrap" id="studio">
    <div class="grid two">
      <div class="card reveal">
        <h2 data-i18n="studio_title">استودیوی تشخیص</h2>
        <p class="sub" data-i18n="studio_sub">یکی از روش‌ها را انتخاب کن.</p>

        <div class="tabs" role="tablist">
          <button type="button" class="active" data-panel="mic" data-i18n="tab_mic">ضبط صدا</button>
          <button type="button" data-panel="upload" data-i18n="tab_upload">بارگذاری فایل</button>
          <button type="button" data-panel="url" data-i18n="tab_url">لینک ویدیو</button>
          <button type="button" data-panel="text" data-i18n="tab_text">متن / ترانه</button>
        </div>

        <!-- microphone -->
        <div class="panel active" id="panel-mic">
          <div class="recorder">
            <button class="mic-btn" id="micBtn" type="button" aria-label="Record">
              <svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>
            </button>
            <div class="timer" id="timer">00:00</div>
            <canvas class="wave" id="wave" width="800" height="240"></canvas>
            <div class="level"><span id="levelBar"></span></div>
            <div class="row" style="justify-content:center">
              <button class="btn" id="micStart" type="button" data-i18n="mic_start">شروع ضبط</button>
              <button class="btn ghost" id="micStop" type="button" disabled data-i18n="mic_stop">پایان و تشخیص</button>
            </div>
            <p class="sub" style="margin:0" data-i18n="mic_hint">حداکثر ۱۲ ثانیه ضبط می‌شود؛ همین بخش کافی است.</p>
          </div>
        </div>

        <!-- upload -->
        <div class="panel" id="panel-upload">
          <div class="drop" id="drop" tabindex="0" role="button">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-4H3v4a4 4 0 0 0 4 4h10a4 4 0 0 0 4-4v-4h-2zM12 3 7 8h3v6h4V8h3l-5-5z"/></svg>
            <p data-i18n="drop_title">فایل را اینجا رها کن یا کلیک کن</p>
            <p class="sub" style="margin:.2rem 0 0" data-i18n="drop_sub">MP3 · M4A · WAV · OGG · FLAC · MP4 · WebM</p>
          </div>
          <input type="file" id="file" accept="audio/*,video/*" hidden>
          <div class="field" style="margin-top:1rem">
            <label data-i18n="opt_lyrics">گزینه‌ها</label>
            <div class="row">
              <label class="row" style="gap:.4rem"><input type="checkbox" id="wantLyrics" checked> <span data-i18n="opt_lyrics_text">دریافت متن ترانه</span></label>
            </div>
          </div>
          <div class="status" id="uploadStatus"></div>
        </div>

        <!-- url -->
        <div class="panel" id="panel-url">
          <div class="field">
            <label for="urlInput" data-i18n="url_label">لینک مستقیم ویدیو یا فایل صوتی</label>
            <input type="url" id="urlInput" placeholder="https://example.com/video.mp4" autocomplete="off">
          </div>
          <button class="btn" id="urlBtn" type="button" data-i18n="url_submit">تشخیص از لینک</button>
          <p class="sub" style="margin-top:.8rem" data-i18n="url_note">برای پردازش ویدیو، سرور باید متغیر محیطی BACKEND_URL را تنظیم کرده باشد (پایتون + ffmpeg). اگر تنظیم نباشد، پاسخ دقیق و روشنی دریافت می‌کنید.</p>
          <div class="status" id="urlStatus"></div>
        </div>

        <!-- text -->
        <div class="panel" id="panel-text">
          <div class="field">
            <label for="textInput" data-i18n="text_label">نام آهنگ، خواننده یا یک خط از ترانه</label>
            <input type="search" id="textInput" placeholder="Coldplay Paradise" autocomplete="off">
          </div>
          <div class="row">
            <button class="btn" id="textBtn" type="button" data-i18n="text_submit">جستجو</button>
            <label class="row" style="gap:.4rem"><input type="checkbox" id="textLyrics" checked> <span data-i18n="text_lyrics">همراه با ترانه</span></label>
          </div>
          <div class="status" id="textStatus"></div>
        </div>
      </div>

      <div class="card reveal" id="result">
        <h2 data-i18n="result_title">نتیجه</h2>
        <p class="sub" data-i18n="result_sub">جزئیات آهنگ شناسایی‌شده.</p>
        <div id="resultBody">
          <div class="empty">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>
            <p data-i18n="result_empty">هنوز چیزی شناسایی نشده است.</p>
          </div>
        </div>
        <div class="field" style="margin-top:1.2rem;margin-bottom:.4rem">
          <label data-i18n="history_label">تاریخچهٔ اخیر</label>
          <div class="history" id="history"></div>
        </div>
      </div>
    </div>
  </section>

  <section class="wrap" id="docs">
    <div class="card reveal">
      <h2 data-i18n="docs_title">مستندات API</h2>
      <p class="sub" data-i18n="docs_sub">همهٔ پاسخ‌ها JSON هستند و نسخهٔ <code>v1</code> دارند. زبان پاسخ با <code>?lang=fa</code> یا هدر <code>Accept-Language</code> تعیین می‌شود.</p>
      <div class="docs-grid">
        <table class="api">
          <thead><tr><th data-i18n="th_method">متد</th><th data-i18n="th_path">مسیر</th><th data-i18n="th_desc">توضیح</th></tr></thead>
          <tbody>
            <tr><td><span class="method post">POST</span></td><td><code>/api/v1/recognize</code></td><td data-i18n="ep_recognize">تشخیص آهنگ از اثر انگشت، PCM یا فایل WAV</td></tr>
            <tr><td><span class="method post">POST</span></td><td><code>/api/v1/recognize/url</code></td><td data-i18n="ep_url">تشخیص از لینک ویدیو/صدا (نیازمند BACKEND_URL)</td></tr>
            <tr><td><span class="method post">POST</span></td><td><code>/api/v1/search</code></td><td data-i18n="ep_search">جستجو با نام، خواننده یا متن ترانه</td></tr>
            <tr><td><span class="method get">GET</span></td><td><code>/api/v1/lyrics</code></td><td data-i18n="ep_lyrics">دریافت متن ترانه</td></tr>
            <tr><td><span class="method get">GET</span></td><td><code>/api/v1/info</code></td><td data-i18n="ep_info">مشخصات سرویس</td></tr>
            <tr><td><span class="method get">GET</span></td><td><code>/api/v1/providers</code></td><td data-i18n="ep_providers">سرویس‌های بیرونی</td></tr>
            <tr><td><span class="method get">GET</span></td><td><code>/api/v1/openapi.json</code></td><td data-i18n="ep_openapi">توصیف OpenAPI 3.1</td></tr>
            <tr><td><span class="method get">GET</span></td><td><code>/health</code></td><td data-i18n="ep_health">بررسی سلامت سرویس</td></tr>
          </tbody>
        </table>

        <h3 data-i18n="docs_examples">نمونه کد</h3>
        <div class="code-tabs" id="codeTabs">
          <button type="button" class="active" data-code="curl">cURL</button>
          <button type="button" data-code="python">Python</button>
          <button type="button" data-code="php">PHP</button>
          <button type="button" data-code="js">JavaScript</button>
          <button type="button" data-code="node">Node.js</button>
          <button type="button" data-code="telegram">Telegram</button>
        </div>
        <div class="code-panels" id="codePanels">/*__CODE_PANELS__*/</div>

        <h3 data-i18n="docs_errors">جدول کدهای خطا</h3>
        <table class="api">
          <thead><tr><th data-i18n="th_code">کد</th><th data-i18n="th_status">وضعیت</th><th data-i18n="th_meaning">معنی</th></tr></thead>
          <tbody id="errorTable">/*__ERROR_ROWS__*/</tbody>
        </table>

        <div class="note">
          <strong data-i18n="note_title">نکات مهم و محدودیت‌ها</strong>
          <ul style="margin:.6rem 0 0;padding-inline-start:1.2rem" data-i18n-html="note_body">/*__NOTE_LIST__*/</ul>
        </div>

        <h3 data-i18n="docs_faq">پرسش‌های پرتکرار</h3>
        <div class="faq" id="faq">/*__FAQ__*/</div>
      </div>
    </div>
  </section>
</main>

<footer>
  <div class="social">
    <a class="btn ghost small" href="https://github.com/AliMsvD/Shazam" target="_blank" rel="noopener">GitHub</a>
    <a class="btn ghost small" href="https://t.me/AliMsvD" target="_blank" rel="noopener">Telegram</a>
    <a class="btn ghost small" href="/api/v1/openapi.json" target="_blank" rel="noopener">OpenAPI</a>
  </div>
  <p><span data-i18n="footer_credit">ساخته‌شده با ❤️ توسط</span> <a href="https://github.com/AliMsvD" target="_blank" rel="noopener">Ali Mousavi (@AliMsvD)</a> · <span data-i18n="footer_license">MIT License</span> · Shzm v3.0.0</p>
</footer>

<div class="toast" id="toast"></div>
<script type="module" src="/static/app.js"></script>
</body>
</html>`;

/**
 * The final page: the static template plus the server rendered blocks
 * (error table, notes, FAQ and the six code samples).
 * The placeholders are replaced with a replacer *function* so that the
 * dollar signs inside the code samples are never treated as `$&`-style
 * replacement patterns.
 */
const ASSET_HTML = ASSET_HTML_TEMPLATE
  .replace('/*__CODE_PANELS__*/', () => buildCodePanelsHtml())
  .replace('/*__ERROR_ROWS__*/', () => buildErrorRowsHtml())
  .replace('/*__NOTE_LIST__*/', () => I18N_UI.fa.note_body)
  .replace('/*__FAQ__*/', () => buildFaqHtml(I18N_UI.fa.faq));

/* ------------------------------------------------------------------------- */

const ASSET_JS_TEMPLATE = `
const I18N_UI = /*__I18N_UI__*/;
const ERROR_CODES_UI = /*__ERROR_CODES__*/;

/* ============================ helpers ============================ */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* The inline head script already flagged the document, but a strict
   Content-Security-Policy may block it: flag it here as well. */
try { document.documentElement.classList.add('js'); } catch (err) { /* ignore */ }

/* localStorage is unavailable in some in-app browsers and in private mode:
   every access goes through these helpers so a SecurityError can never
   break the page. */
function lsGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  try { window.localStorage.setItem(key, value); return true; } catch { return false; }
}

const storedLang = lsGet('shzm_lang');
const browserLang = ((navigator && navigator.language) || 'en').toLowerCase();
const state = {
  lang: storedLang || (browserLang.startsWith('fa') ? 'fa' : 'en'),
  theme: lsGet('shzm_theme') || 'dark',
};

const API = location.origin + '/api/v1';

function toast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  lsSet('shzm_theme', state.theme);
}

function applyLang() {
  const dict = I18N_UI[state.lang] || I18N_UI.fa;
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === 'fa' ? 'rtl' : 'ltr';
  $$('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (dict[key] !== undefined) el.textContent = dict[key];
  });
  $$('[data-i18n-html]').forEach((el) => {
    const key = el.getAttribute('data-i18n-html');
    if (dict[key] !== undefined) el.innerHTML = dict[key];
  });
  $$('.lang-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.lang === state.lang));
  lsSet('shzm_lang', state.lang);
  renderErrors();
  renderFaq();
}

function apiError(payload, fallback) {
  if (payload && payload.error && payload.error.message) return payload.error.message;
  if (payload && payload.message) return payload.message;
  return fallback;
}


/* ============================ rendering ============================ */
function renderErrors() {
  const body = $('#errorTable');
  if (!body) return;
  const lang = state.lang === 'fa' ? 'fa' : 'en';
  body.innerHTML = Object.keys(ERROR_CODES_UI)
    .filter((code) => code !== 'E_OK')
    .map((code) => {
      const meta = ERROR_CODES_UI[code] || {};
      const meaning = meta[lang] || meta.en || '';
      return '<tr><td><code>' + code + '</code></td><td>' + (meta.status || '') + '</td><td>' +
        escapeHtml(meaning) + '</td></tr>';
    })
    .join('');
}

function renderFaq() {
  const box = $('#faq');
  if (!box) return;
  const list = (I18N_UI[state.lang] || I18N_UI.fa).faq || [];
  box.innerHTML = list.map(([q, a]) =>
    '<details><summary>' + escapeHtml(q) + '</summary><p>' + escapeHtml(a) + '</p></details>').join('');
}

/** Escape a text before it is injected into the DOM. */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setStatus(selector, message, kind) {
  const el = $(selector);
  if (!el) return;
  if (!message) { el.innerHTML = ''; return; }
  const icon = kind === 'error' ? '⚠️' : kind === 'ok' ? '✅' : '';
  el.innerHTML = (kind === 'busy' ? '<span class="spinner"></span>' : icon) +
    ' <span>' + message + '</span>';
}

function fmtDuration(ms) {
  if (!ms) return '—';
  const total = Math.floor(ms / 1000);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

function renderResult(data) {
  const box = $('#resultBody');
  if (!data || !data.found) {
    box.innerHTML = '<div class="empty"><p>' +
      (I18N_UI[state.lang].result_empty) + '</p></div>';
    return;
  }
  const t = I18N_UI[state.lang];
  const track = data.track || {};
  const conf = data.confidence || 0;
  const circumference = 2 * Math.PI * 22;
  const offset = circumference * (1 - conf / 100);
  const links = track.links || {};
  const linkLabels = {
    shazam: 'Shazam', apple_music: 'Apple Music', deezer: 'Deezer',
    spotify: 'Spotify', youtube: 'YouTube', youtube_music: 'YouTube Music', google: 'Google',
  };
  const cells = [
    [t.album, track.album], [t.year, track.release_date], [t.genre, track.genre],
    [t.label, track.label], [t.duration, track.duration_text || fmtDuration(track.duration_ms)],
    [t.isrc, track.isrc], [t.bpm, track.bpm], [t.source, data.source],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');

  const lyricsText = data.lyrics && data.lyrics.available
    ? data.lyrics.text
    : '<em>' + t.no_lyrics + '</em>';

  box.innerHTML =
    '<div class="result">' +
      '<div class="result-head">' +
        (data.artwork ? '<img class="art" src="' + data.artwork + '" alt="" referrerpolicy="no-referrer">' : '') +
        '<div class="meta">' +
          '<h3>' + (data.title || '—') + '</h3>' +
          '<div class="artist">' + (data.artist || '—') + '</div>' +
          '<div class="conf">' +
            '<svg class="ring" viewBox="0 0 52 52">' +
              '<defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">' +
                '<stop offset="0%" stop-color="#22d3ee"/><stop offset="100%" stop-color="#a855f7"/>' +
              '</linearGradient></defs>' +
              '<circle class="track" cx="26" cy="26" r="22"/>' +
              '<circle class="val" cx="26" cy="26" r="22" stroke-dasharray="' + circumference + '" stroke-dashoffset="' + offset + '"/>' +
              '<text x="26" y="30" text-anchor="middle">' + conf + '</text>' +
            '</svg>' +
            '<div><div style="font-weight:700">' + t.confidence + '</div>' +
            '<div style="font-size:.78rem;color:var(--faint)">' + (data.cached ? t.cached : data.processing_ms + ' ms') + '</div></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="kv">' + cells.map(([k, v]) =>
        '<div class="cell"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('') +
      '</div>' +
      '<div><h3 style="font-size:1rem;margin:.2rem 0 .5rem">' + t.lyrics_title + '</h3>' +
        '<div class="lyrics" id="lyricsBox">' + lyricsText + '</div></div>' +
      '<div><h3 style="font-size:1rem;margin:.2rem 0 .5rem">' + t.links_title + '</h3>' +
        '<div class="links">' + Object.keys(links).map((k) =>
          '<a href="' + links[k] + '" target="_blank" rel="noopener">' + (linkLabels[k] || k) + '</a>').join('') +
        '</div></div>' +
      '<div class="row">' +
        '<button class="btn small" id="copyLyrics" type="button">' + t.copy + '</button>' +
      '</div>' +
    '</div>';

  const copyBtn = $('#copyLyrics');
  if (copyBtn) copyBtn.addEventListener('click', () => {
    const text = data.lyrics && data.lyrics.text ? data.lyrics.text : '';
    navigator.clipboard.writeText(text).then(() => toast(t.done)).catch(() => toast(t.err_generic));
  });

  pushHistory(data);
}

function pushHistory(data) {
  if (!data || !data.title) return;
  let list = [];
  try { list = JSON.parse(lsGet('shzm_history') || '[]'); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  list = list.filter((x) => !(x.title === data.title && x.artist === data.artist));
  list.unshift({ title: data.title, artist: data.artist, artwork: data.artwork || null });
  list = list.slice(0, 12);
  lsSet('shzm_history', JSON.stringify(list));
  renderHistory();
}

function renderHistory() {
  const box = $('#history');
  if (!box) return;
  let list = [];
  try { list = JSON.parse(lsGet('shzm_history') || '[]'); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  box.innerHTML = list.map((x) =>
    '<button type="button" data-title="' + escapeHtml(x.title || '') +
    '" data-artist="' + escapeHtml(x.artist || '') + '">' +
    escapeHtml(x.title || '') + (x.artist ? ' · ' + escapeHtml(x.artist) : '') + '</button>').join('');
  Array.from(box.querySelectorAll('button')).forEach((b) => {
    b.addEventListener('click', () => {
      const input = $('#textInput');
      if (!input) return;
      input.value = b.dataset.title + ' ' + (b.dataset.artist || '');
      switchPanel('text');
      const btn = $('#textBtn');
      if (btn) btn.click();
    });
  });
}

/* ======================== audio → fingerprint ======================== */
const SIG_PREFIX = 'data:audio/vnd.shazam.sig;base64,';

function toInt16(floatMono) {
  const pcm = new Int16Array(floatMono.length);
  for (let i = 0; i < floatMono.length; i++) {
    let v = Math.round(floatMono[i] * 32767);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    pcm[i] = v;
  }
  return pcm;
}

async function decodeToMono16k(arrayBuffer) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    ctx.close();
  }
  const targetRate = 16000;
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/* The fingerprint engine is loaded lazily: a static import would make the
   whole page script fail (and therefore hide every section) whenever
   /static/fingerprint.js cannot be fetched. */
let fingerprintModule = null;
function loadFingerprintModule() {
  if (!fingerprintModule) {
    fingerprintModule = import('/static/fingerprint.js').catch((err) => {
      fingerprintModule = null;
      throw err;
    });
  }
  return fingerprintModule;
}

async function buildFingerprint(pcm) {
  const fp = await loadFingerprintModule();
  const gen = new fp.FpSignatureGenerator({ maxTimeSeconds: 12 });
  gen.feed(pcm);
  const duration = pcm.length / 16000;
  if (duration > 36) gen.skipSamples(16000 * (Math.floor(duration / 2) - 6));
  const signature = gen.getNextSignature();
  const bytes = fp.fpEncodeSignature(signature);
  return {
    uri: SIG_PREFIX + fp.fpBase64(bytes),
    samplems: Math.trunc((signature.numberSamples / signature.sampleRate) * 1000),
    pcm,
  };
}

async function recognizePcm(pcm, wantLyrics) {
  // 1) try the fast path: fingerprint in the browser
  try {
    const fp = await buildFingerprint(pcm);
    const res = await fetch(API + '/recognize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': state.lang },
      body: JSON.stringify({ signature: fp.uri, samplems: fp.samplems, lyrics: wantLyrics }),
    });
    const body = await res.json();
    if (res.ok && body.ok) return body.data;
    const code = body && body.error ? body.error.code : null;
    if (code === 'E_NO_MATCH') {
      // The fingerprint was valid, the upstream simply found nothing:
      // re-sending the raw PCM would not change the outcome.
      const err = new Error(apiError(body, I18N_UI[state.lang].err_generic));
      err.payload = body;
      throw err;
    }
    // every other failure (network, 5xx, malformed request, a missing
    // fingerprint module) is retried with the server side fingerprint
  } catch (err) {
    if (err && err.payload) throw err;
    // fall through to the server-side path
  }
  // 2) fallback: send the raw PCM and let the Worker fingerprint it
  const res = await fetch(API + '/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': state.lang },
    body: JSON.stringify({ pcm: pcmToBase64(pcm), lyrics: wantLyrics }),
  });
  const body = await res.json();
  if (!res.ok || !body.ok) {
    const err = new Error(apiError(body, I18N_UI[state.lang].err_generic));
    err.payload = body;
    throw err;
  }
  return body.data;
}

function pcmToBase64(pcm) {
  const bytes = new Uint8Array(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] < 0 ? pcm[i] + 65536 : pcm[i];
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = (v >> 8) & 0xff;
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ============================ recorder ============================ */
const rec = { media: null, recorder: null, chunks: [], stream: null, ctx: null, raf: 0, startedAt: 0 };

function drawWave() {
  const canvas = $('#wave');
  if (!canvas || !rec.ctx) return;
  const ctx = canvas.getContext('2d');
  const analyser = rec.ctx.createAnalyser ? rec.analyser : null;
  const data = new Uint8Array(analyser ? analyser.frequencyBinCount : 0);
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (analyser) analyser.getByteTimeDomainData(data);
  const step = Math.max(1, Math.floor(data.length / 120));
  const gradient = ctx.createLinearGradient(0, 0, W, 0);
  gradient.addColorStop(0, '#22d3ee');
  gradient.addColorStop(1, '#a855f7');
  ctx.fillStyle = gradient;
  for (let i = 0, x = 0; i < data.length; i += step, x += W / 120) {
    const v = (data[i] - 128) / 128;
    const h = Math.abs(v) * H * 0.9;
    ctx.fillRect(x, (H - h) / 2, W / 240, h);
  }
  rec.raf = requestAnimationFrame(drawWave);
}

async function startRecording() {
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    toast(I18N_UI[state.lang].err_generic);
    return;
  }
  rec.chunks = [];
  rec.recorder = new MediaRecorder(rec.stream);
  rec.recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
  rec.recorder.start(100);
  rec.startedAt = Date.now();

  rec.ctx = new (window.AudioContext || window.webkitAudioContext)();
  const source = rec.ctx.createMediaStreamSource(rec.stream);
  rec.analyser = rec.ctx.createAnalyser();
  rec.analyser.fftSize = 2048;
  source.connect(rec.analyser);
  drawWave();

  $('#micBtn').classList.add('recording');
  $('#micStart').disabled = true;
  $('#micStop').disabled = false;
  setStatus('#uploadStatus', I18N_UI[state.lang].listening, 'busy');
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - rec.startedAt) / 1000);
    $('#timer').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    if (s >= 12) stopRecording();
  }, 200);
  rec.timer = timer;
}

async function stopRecording() {
  clearInterval(rec.timer);
  cancelAnimationFrame(rec.raf);
  $('#micBtn').classList.remove('recording');
  $('#micStart').disabled = false;
  $('#micStop').disabled = true;
  if (!rec.recorder || rec.recorder.state === 'inactive') return;
  const done = new Promise((resolve) => { rec.recorder.onstop = resolve; });
  rec.recorder.stop();
  await done;
  if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
  if (rec.ctx) rec.ctx.close();

  const blob = new Blob(rec.chunks, { type: rec.chunks[0] ? rec.chunks[0].type : 'audio/webm' });
  setStatus('#uploadStatus', I18N_UI[state.lang].analysing, 'busy');
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const mono = await decodeToMono16k(arrayBuffer);
    const pcm = toInt16(mono);
    const data = await recognizePcm(pcm, $('#wantLyrics').checked);
    renderResult(data);
    setStatus('#uploadStatus', I18N_UI[state.lang].done, 'ok');
  } catch (err) {
    setStatus('#uploadStatus', err.message, 'error');
  }
}

/* ============================ interactions ============================ */
function switchPanel(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
}

async function handleFile(file) {
  if (!file) return;
  setStatus('#uploadStatus', I18N_UI[state.lang].analysing, 'busy');
  try {
    const arrayBuffer = await file.arrayBuffer();
    const mono = await decodeToMono16k(arrayBuffer);
    const pcm = toInt16(mono);
    const data = await recognizePcm(pcm, $('#wantLyrics').checked);
    renderResult(data);
    setStatus('#uploadStatus', I18N_UI[state.lang].done, 'ok');
  } catch (err) {
    setStatus('#uploadStatus', err.message, 'error');
  }
}

async function handleUrl() {
  const url = $('#urlInput').value.trim();
  if (!url) return;
  setStatus('#urlStatus', I18N_UI[state.lang].please_wait, 'busy');
  try {
    const res = await fetch(API + '/recognize/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': state.lang },
      body: JSON.stringify({ url }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(apiError(body, I18N_UI[state.lang].err_generic));
    renderResult(body.data);
    setStatus('#urlStatus', I18N_UI[state.lang].done, 'ok');
  } catch (err) {
    setStatus('#urlStatus', err.message, 'error');
  }
}

async function handleText() {
  const query = $('#textInput').value.trim();
  if (!query) return;
  setStatus('#textStatus', I18N_UI[state.lang].please_wait, 'busy');
  try {
    const res = await fetch(API + '/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': state.lang },
      body: JSON.stringify({ query, limit: 8, lyrics: $('#textLyrics').checked }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(apiError(body, I18N_UI[state.lang].err_generic));
    renderResult(body.data);
    setStatus('#textStatus', I18N_UI[state.lang].done, 'ok');
  } catch (err) {
    setStatus('#textStatus', err.message, 'error');
  }
}

/* ======================= reveal (scroll animation) ======================= */
/*
 * The sections are visible by default (the stylesheet only hides them when
 * html.js *and* html.can-observe are set). The animation is therefore a
 * pure enhancement: if anything goes wrong the content simply stays
 * visible instead of turning into an empty page.
 */
function revealAll() {
  $$('.reveal').forEach((el) => el.classList.add('in'));
}

/** Reveal every .reveal element that is currently inside the viewport. */
function revealVisible() {
  const height = window.innerHeight || document.documentElement.clientHeight || 0;
  $$('.reveal').forEach((el) => {
    if (el.classList.contains('in')) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < height && rect.bottom > 0) el.classList.add('in');
  });
}

function setupReveal() {
  const root = document.documentElement;
  const targets = $$('.reveal');
  if (!targets.length) return;

  const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (reduced || typeof window.IntersectionObserver !== 'function') {
    // no animation wanted or not supported -> keep everything visible
    revealAll();
    return;
  }

  let observer;
  try {
    observer = new window.IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0, rootMargin: '0px 0px -5% 0px' });
    targets.forEach((el) => observer.observe(el));
  } catch (err) {
    revealAll();
    return;
  }

  // Everything is watched from now on, so it is safe to let the stylesheet
  // hide the not yet revealed sections.
  revealVisible();
  root.classList.add('can-observe');

  /* Safety nets: a broken observer, a failed request or any other error
     must never leave an invisible section behind. */
  window.addEventListener('load', revealVisible);
  window.addEventListener('error', revealAll);
  window.addEventListener('unhandledrejection', revealAll);
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(() => {
      ticking = false;
      revealVisible();
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  setTimeout(revealVisible, 1200);
}

/* ============================ bootstrap ============================ */
function wireTheme() {
  const btn = $('#themeBtn');
  if (btn) btn.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
  });
  $$('.lang-toggle button').forEach((b) => b.addEventListener('click', () => {
    state.lang = b.dataset.lang;
    applyLang();
  }));
}

function wireStudio() {
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => switchPanel(b.dataset.panel)));

  const start = $('#micStart');
  const stop = $('#micStop');
  const mic = $('#micBtn');
  if (start) start.addEventListener('click', startRecording);
  if (stop) stop.addEventListener('click', stopRecording);
  if (mic) mic.addEventListener('click', () => {
    if (rec.recorder && rec.recorder.state === 'recording') stopRecording();
    else startRecording();
  });

  const drop = $('#drop');
  const fileInput = $('#file');
  if (drop && fileInput) {
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
    fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.remove('over');
    }));
    drop.addEventListener('drop', (e) => {
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    });
  }

  const urlBtn = $('#urlBtn');
  const textBtn = $('#textBtn');
  const urlInput = $('#urlInput');
  const textInput = $('#textInput');
  if (urlBtn) urlBtn.addEventListener('click', handleUrl);
  if (textBtn) textBtn.addEventListener('click', handleText);
  if (textInput) textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleText(); });
  if (urlInput) urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleUrl(); });
}

/* The code samples are rendered on the server; the script only switches
   between the panels that are already in the DOM. */
function wireCodeTabs() {
  const panels = $$('.code-panel');
  const buttons = $$('#codeTabs button');
  if (!panels.length || !buttons.length) return;
  const showCode = (name) => {
    panels.forEach((p) => p.classList.toggle('active', p.dataset.code === name));
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.code === name));
  };
  buttons.forEach((b) => b.addEventListener('click', () => showCode(b.dataset.code)));
  const active = buttons.find((b) => b.classList.contains('active')) || buttons[0];
  showCode(active.dataset.code);
  document.documentElement.classList.add('tabs-ready');
}

function init() {
  // Every step is isolated: a single failure must never take the rest of
  // the page (and above all the visible content) down with it.
  const steps = [
    ['reveal', setupReveal],
    ['theme', wireTheme],
    ['studio', wireStudio],
    ['code-tabs', wireCodeTabs],
    ['lang', applyLang],
    ['history', renderHistory],
  ];
  for (const [name, run] of steps) {
    try {
      run();
    } catch (err) {
      if (name === 'reveal') revealAll();
      console.warn('[shzm] step "' + name + '" failed:', err);
    }
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
`;

/**
 * The page script. The bilingual dictionary and the error catalogue are
 * injected from the Worker so the browser and the server always agree.
 */
const ASSET_JS = ASSET_JS_TEMPLATE
  .replace('/*__I18N_UI__*/', () => JSON.stringify(I18N_UI))
  .replace('/*__ERROR_CODES__*/', () => JSON.stringify(ERROR_CODES));

/* ------------------------------------------------------------------------- */

const ASSET_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6c5ce7"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="16" fill="url(#g)"/>
  <path fill="#fff" d="M40 14v20.2a7 7 0 1 1-4-6.3V19.4l-13 2.9v14.5a7 7 0 1 1-4-6.3V19l21-5z"/>
</svg>
`;
