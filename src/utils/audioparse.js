// Minimal, allocation-light audio container parsers used by the chunked
// decode pipeline. Everything here runs inside a Worker, so the goal is:
// parse what is needed (OGG page boundaries / MP4 sample tables) with as
// little CPU as possible, and never buffer more than required.

const tstr = (b, o, s) => String.fromCharCode(...b.subarray(o, o + s.length)) === s;

/**
 * Parse an Ogg container into page records.
 * Returns { headEnd, pages:[{start,end,packets}], packets } where headEnd is
 * the byte offset after the OpusHead/OpusTags (or Vorbis) header pages and
 * each page record is a byte range containing `packets` packets.
 */
export function parseOggPages(bytes) {
  if (!bytes || bytes.length < 4 || !tstr(bytes, 0, "OggS")) return null;
  const pages = [];
  let packets = 0;
  let headEnd = 0;
  let headerPackets = 0;
  let i = 0;
  let packetOpen = false; // packet continues from previous page
  while (i + 27 <= bytes.length) {
    if (!tstr(bytes, i, "OggS")) break;
    const nsegs = bytes[i + 26];
    const table = i + 27;
    const dataStart = table + nsegs;
    let end = dataStart;
    for (let s = 0; s < nsegs; s++) end += bytes[table + s];
    if (end > bytes.length) break;
    let pagePackets = 0;
    let open = packetOpen;
    for (let s = 0; s < nsegs; s++) {
      const l = bytes[table + s];
      if (!open) pagePackets++;
      if (l < 255) open = false;
      else open = true;
    }
    // `open` at page end means the last packet continues into the next page.
    packetOpen = open;
    pages.push({ start: i, end, packets: pagePackets });
    packets += pagePackets;
    if (headerPackets < 2) {
      headerPackets += pagePackets;
      if (headerPackets >= 2) headEnd = end;
    }
    i = end;
  }
  if (!pages.length) return null;
  return { pages, headEnd, packets };
}

/** Group data pages into page-aligned byte ranges of ~packetsPerChunk packets. */
export function oggChunkRanges(pages, headEnd, packetsPerChunk) {
  const ranges = [];
  let start = -1;
  let count = 0;
  for (const p of pages) {
    if (p.start < headEnd) continue;
    if (start < 0) start = p.start;
    count += p.packets;
    if (count >= packetsPerChunk) {
      ranges.push([start, p.end]);
      start = -1;
      count = 0;
    }
  }
  if (start >= 0) {
    const last = pages[pages.length - 1];
    ranges.push([start, last.end]);
  }
  return ranges;
}

// ── MP4 ──────────────────────────────────────────────────────────────────────
// Walks ISO-BMFF boxes and extracts the first audio track's sample table.
// Designed for moov-at-start files (Telegram uploads & Instagram CDN), but
// tolerates any order as long as the caller has fetched the relevant bytes.

function walkBoxes(bytes, from, to, cb) {
  let o = from;
  while (o + 8 <= to) {
    let size = bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3];
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    let hdr = 8;
    if (size === 1) {
      // 64-bit size
      const hi = bytes[o + 8] << 24 | bytes[o + 9] << 16 | bytes[o + 10] << 8 | bytes[o + 11];
      const lo = bytes[o + 12] << 24 | bytes[o + 13] << 16 | bytes[o + 14] << 8 | bytes[o + 15];
      size = hi * 4294967296 + lo;
      hdr = 16;
    } else if (size === 0) {
      size = to - o;
    }
    if (size < hdr || o + size > to) break;
    if (cb(type, o + hdr, o + size) === false) return o;
    o += size;
  }
}

/**
 * Parse MP4 (MP4/MOV/M4A) bytes and extract the primary audio track.
 * Returns { asc:Uint8Array|null, sampleRate, channels, frames:[{o,s}] } or null.
 * `bytes` must cover ftyp + moov + at least the start of mdat.
 */
export function parseMp4Audio(bytes) {
  if (!bytes || bytes.length < 32) return null;
  let moov = null;
  walkBoxes(bytes, 0, bytes.length, (type, bodyStart, bodyEnd) => {
    if (type === "moov") { moov = [bodyStart, bodyEnd]; return false; }
    return true;
  });
  if (!moov) return null;

  let audioTrack = null;
  walkBoxes(bytes, moov[0], moov[1], (type, s, e) => {
    if (type === "trak") {
      const tr = parseTrak(bytes, s, e);
      if (tr && tr.isAudio && !audioTrack) audioTrack = tr;
    }
    return true;
  });
  if (!audioTrack) return null;

  // Expand chunk offsets into per-sample offsets via stsc/stco/stsz.
  const { stsz, stco, co64, stsc, stts } = audioTrack;
  const sizes = stsz.uniform !== null
    ? Array.from({ length: stsz.count }, () => stsz.uniform)
    : stsz.sizes;
  if (!sizes || !sizes.length) return null;

  const chunkOffsets = (co64 ? co64.map((v) => v * 4294967296 + 0) : stco).slice();
  const offsets = new Array(sizes.length);
  const stscRuns = stsc.slice().sort((a, b) => a.firstChunk - b.firstChunk);
  let sampleIdx = 0;
  for (let ci = 0; ci < chunkOffsets.length && sampleIdx < sizes.length; ci++) {
    // which run covers this chunk (runs are 1-based chunk indexes); the last
    // matching run extends to all following chunks.
    let run = null;
    for (let r = 0; r < stscRuns.length; r++) {
      if (stscRuns[r].firstChunk - 1 <= ci) run = stscRuns[r];
      else break;
    }
    const samplesThisChunk = run ? run.samplesPerChunk : 1;
    let off = chunkOffsets[ci];
    for (let s = 0; s < samplesThisChunk && sampleIdx < sizes.length; s++, sampleIdx++) {
      offsets[sampleIdx] = { o: off, s: sizes[sampleIdx] };
      off += sizes[sampleIdx];
    }
  }
  return {
    asc: audioTrack.asc || null,
    sampleRate: audioTrack.sampleRate,
    channels: audioTrack.channels,
    duration_ms: audioTrack.duration_ms,
    frames: offsets.filter(Boolean).map((f) => ({ o: f.o, s: f.s })),
  };
}

/** Parse one trak box -> {isAudio, sampleRate, channels, asc, stbl tables} */
function parseTrak(bytes, from, to) {
  let tkhdRate = 0;
  let out = null;
  walkBoxes(bytes, from, to, (type, s, e) => {
    if (type === "tkhd") {
      // volume field (fixed 8.8) hints audio (0x0100 = 1.0)
      const version = bytes[s];
      const volOff = version === 1 ? s + 80 : s + 72;
      tkhdRate = bytes[volOff];
    } else if (type === "mdia") {
      walkBoxes(bytes, s, e, (t2, s2, e2) => {
        if (t2 === "mdhd") {
          const v = bytes[s2];
          const timescale = v === 1
            ? bytes[s2 + 20] << 24 | bytes[s2 + 21] << 16 | bytes[s2 + 22] << 8 | bytes[s2 + 23]
            : bytes[s2 + 12] << 24 | bytes[s2 + 13] << 16 | bytes[s2 + 14] << 8 | bytes[s2 + 15];
          out = out || {};
          out.timescale = timescale;
          const dur = v === 1
            ? (bytes[s2 + 12] << 24 | bytes[s2 + 13] << 16 | bytes[s2 + 14] << 8 | bytes[s2 + 15])
            : (bytes[s2 + 16] << 24 | bytes[s2 + 17] << 16 | bytes[s2 + 18] << 8 | bytes[s2 + 19]);
          out.mediaDur = dur;
        } else if (t2 === "minf") {
          walkBoxes(bytes, s2, e2, (t3, s3, e3) => {
            if (t3 === "stbl") {
              const tbl = parseStbl(bytes, s3, e3);
              out = { ...out, ...tbl };
            }
            return true;
          });
        }
        return true;
      });
    }
    return true;
  });
  if (!out) return null;
  return {
    isAudio: out.isAudio === true,
    sampleRate: out.sampleRate || 0,
    channels: out.channels || 0,
    asc: out.asc || null,
    duration_ms: out.timescale && out.mediaDur ? Math.round((out.mediaDur / out.timescale) * 1000) : 0,
    stsz: out.stsz, stco: out.stco, co64: out.co64, stsc: out.stsc, stts: out.stts,
  };
}

function parseStbl(bytes, from, to) {
  const res = { isAudio: false };
  walkBoxes(bytes, from, to, (type, s, e) => {
    if (type === "stsd") {
      const cnt = bytes[s + 4] << 24 | bytes[s + 5] << 16 | bytes[s + 6] << 8 | bytes[s + 7];
      let o = s + 8;
      for (let i = 0; i < cnt && o + 8 <= e; i++) {
        let size = bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3];
        const fmt = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
        if (size < 8 || o + size > e) break;
        // mp4a sample entry: body[8..] = audio sample entry (v0: 28 bytes) then children
        if (fmt === "mp4a" || fmt === "alac") {
          res.isAudio = true;
          const body = o + 8;
          // AudioSampleEntry v0 (after 8-byte header): 6 res + 2 dri + 8 res
          // + 2 channelcount + 2 samplesize + 2 pre_def + 2 res + 4 samplerate
          res.channels = (bytes[body + 16] << 8 | bytes[body + 17]) || res.channels;
          const rateFixed = (bytes[body + 24] << 24 | bytes[body + 25] << 16 | bytes[body + 26] << 8 | bytes[body + 27]) >>> 0;
          res.sampleRate = (rateFixed >>> 16) || res.sampleRate;
          // children (esds/alac) start at body+28 (v0)
          walkBoxes(bytes, body + 28, o + size, (t4, s4, e4) => {
            if (t4 === "esds") {
              const asc = extractAsc(bytes, s4 + 8, e4);
              if (asc) res.asc = asc;
            } else if (t4 === "wave") {
              walkBoxes(bytes, s4 + 8, e4, (t5, s5, e5) => {
                if (t5 === "esds") {
                  const asc = extractAsc(bytes, s5 + 8, e5);
                  if (asc) res.asc = asc;
                }
                return true;
              });
            }
            return true;
          });
        }
        o += size;
      }
    } else if (type === "stts") {
      const n = bytes[s + 4] << 24 | bytes[s + 5] << 16 | bytes[s + 6] << 8 | bytes[s + 7];
      res.stts = n;
    } else if (type === "stsc") {
      const n = bytes[s + 4] << 24 | bytes[s + 5] << 16 | bytes[s + 6] << 8 | bytes[s + 7];
      const runs = [];
      for (let i = 0; i < n; i++) {
        const o = s + 8 + i * 12;
        runs.push({
          firstChunk: bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3],
          samplesPerChunk: bytes[o + 4] << 24 | bytes[o + 5] << 16 | bytes[o + 6] << 8 | bytes[o + 7],
        });
      }
      res.stsc = runs;
    } else if (type === "stsz") {
      const uniform = bytes[s + 4] << 24 | bytes[s + 5] << 16 | bytes[s + 6] << 8 | bytes[s + 7];
      const n = bytes[s + 8] << 24 | bytes[s + 9] << 16 | bytes[s + 10] << 8 | bytes[s + 11];
      const sizes = [];
      for (let i = 0; i < n; i++) {
        const o = s + 12 + i * 4;
        sizes.push(bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]);
      }
      res.stsz = { uniform: uniform || null, count: n, sizes: uniform ? null : sizes };
    } else if (type === "stco") {
      const n = bytes[s + 4] << 24 | bytes[s + 5] << 16 | bytes[s + 6] << 8 | bytes[s + 7];
      const offs = [];
      for (let i = 0; i < n; i++) {
        const o = s + 8 + i * 4;
        offs.push(bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]);
      }
      res.stco = offs;
    } else if (type === "co64") {
      const n = bytes[s + 4] << 24 | bytes[s + 5] << 16 | bytes[s + 6] << 8 | bytes[s + 7];
      const offs = [];
      for (let i = 0; i < n; i++) {
        const o = s + 8 + i * 8;
        offs.push(bytes[o] << 24 | bytes[o + 1] << 16 | bytes[o + 2] << 8 | bytes[o + 3]);
      }
      res.co64 = offs;
    }
    return true;
  });
  return res;
}

/** Pull the AudioSpecificConfig out of an esds body. */
function extractAsc(bytes, from, to) {
  let o = from;
  let asc = null;
  while (o < to) {
    const tag = bytes[o];
    let size = 0;
    o++;
    let b;
    do { b = bytes[o++]; size = (size << 7) | (b & 0x7f); } while (b & 0x80 && o < to);
    if (tag === 0x03) { // ES_Descriptor: 2-byte ES_ID + 1 byte flags
      o += 3;
    } else if (tag === 0x04) { // DecoderConfig: 13 bytes of ObjectTypeIndication etc.
      // objectTypeIndication at bytes[o] (0x40=AAC, 0x69/0x6b=MP3)
      const oti = bytes[o];
      o += 13;
      if (oti === 0x40 || oti === 0x66 || oti === 0x67 || oti === 0x68) {
        // next: DecoderSpecificInfo (0x05) contains the ASC
        const dTag = bytes[o];
        let dSize = 0;
        o++;
        let db;
        do { db = bytes[o++]; dSize = (dSize << 7) | (db & 0x7f); } while (db & 0x80 && o < to);
        if (dTag === 0x05 && o + dSize <= to) {
          asc = bytes.slice(o, o + dSize);
          break;
        }
      }
    } else {
      o += size;
    }
  }
  return asc;
}

/** Read WAV header; returns {sampleRate, channels, bits, dataStart, dataLen} or null. */
export function parseWav(bytes) {
  if (!bytes || bytes.length < 44 || !tstr(bytes, 0, "RIFF") || !tstr(bytes, 8, "WAVE")) return null;
  let o = 12;
  let fmt = null, data = null;
  while (o + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    const size = bytes[o + 4] | bytes[o + 5] << 8 | bytes[o + 6] << 16 | bytes[o + 7] << 24;
    if (id === "fmt ") fmt = { o: o + 8, size };
    else if (id === "data") { data = { o: o + 8, size: Math.min(size, bytes.length - o - 8) }; break; }
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data) return null;
  const p = fmt.o;
  const audioFmt = bytes[p] | bytes[p + 1] << 8;
  const channels = bytes[p + 2] | bytes[p + 3] << 8;
  const sampleRate = bytes[p + 4] | bytes[p + 5] << 8 | bytes[p + 6] << 16 | bytes[p + 7] << 24;
  const bits = bytes[p + 14] | bytes[p + 15] << 8;
  return { audioFmt, channels, sampleRate, bits, dataStart: data.o, dataLen: data.size };
}

/** Build a RIFF/WAV (16-bit PCM) file from Int16 samples. */
export function pcmToWav(samples, sampleRate = 16000, channels = 1) {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); v.setUint32(4, 36 + dataLen, true); wstr(8, "WAVE");
  wstr(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  wstr(36, "data"); v.setUint32(40, dataLen, true);
  new Int16Array(buf, 44).set(samples);
  return new Uint8Array(buf);
}

/**
 * Downmix interleaved Float32 channels to mono Int16 at `targetRate`.
 * `srcRate`/`channels` describe the input layout; `interleaved` selects the
 * layout of the source arrays (mediabunny-style Float32Array[] per channel vs
 * WebAudio-style channel-per-array). We accept per-channel arrays.
 */
export function toMono16k(channelData, srcRate, targetRate = 16000) {
  const ch = channelData.length || 1;
  const n = channelData[0]?.length || 0;
  const ratio = srcRate / targetRate;
  const outLen = Math.max(0, Math.floor(n / ratio));
  const out = new Int16Array(outLen);
  if (ch === 1) {
    for (let i = 0; i < outLen; i++) {
      const f = i * ratio;
      const i0 = Math.floor(f);
      const frac = f - i0;
      const s0 = channelData[0][i0] || 0;
      const s1 = channelData[0][i0 + 1] || s0;
      const v = s0 + (s1 - s0) * frac;
      out[i] = v < 0 ? v * 32768 : v * 32767;
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const f = i * ratio;
      const i0 = Math.floor(f);
      const frac = f - i0;
      let sum = 0;
      for (let c = 0; c < ch; c++) {
        const arr = channelData[c];
        const s0 = arr[i0] || 0;
        const s1 = arr[i0 + 1] || s0;
        sum += s0 + (s1 - s0) * frac;
      }
      const v = sum / ch;
      out[i] = v < 0 ? v * 32768 : v * 32767;
    }
  }
  return out;
}

export function bytesToB64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
