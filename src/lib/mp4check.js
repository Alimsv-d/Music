'use strict';
// Pure-JS, in-memory MP4/fMP4 structural validator + lightweight media tag reader.
// NO disk writes, NO child processes. Parses the box tree to determine whether a
// buffer is a progressive (non-fragmented) MP4/M4A with a proper moov before mdat,
// real mvhd/mdhd duration, consistent stts totals, and optional metadata tags.
//
// This is used for forensic verification of what the bot/worker actually ships:
// Telegram playback truncation (the "12-second" bug) is caused by fragmented
// fMP4 (moof/mvex chains), not by truncated bytes.

const BOX_HEADER = 8;
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'moof', 'traf', 'mfra', 'udta', 'meta', 'ilst']);

function u32(b, o) { return b.readUInt32BE(o); }
function boxType(b, o) { return b.toString('latin1', o + 4, o + 8); }

// Walk top-level boxes; returns [{type,offset,size,dataOffset}]
function topBoxes(buf) {
  const out = [];
  let off = 0;
  const n = buf.length;
  let guard = 0;
  while (off + BOX_HEADER <= n && guard++ < 100000) {
    let size = u32(buf, off);
    const type = boxType(buf, off);
    let header = BOX_HEADER;
    if (size === 1) { // 64-bit largesize
      if (off + 16 > n) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) { // extends to EOF
      size = n - off;
    }
    if (size < header || off + size > n) {
      // corrupt/short tail — stop, but report what we have
      break;
    }
    out.push({ type, offset: off, size, dataOffset: off + header });
    off += size;
  }
  return out;
}

// Recursively collect box counts and find a specific box's data offset.
function walk(buf, start, end, depth, found) {
  let off = start;
  let guard = 0;
  while (off + BOX_HEADER <= end && guard++ < 100000) {
    let size = u32(buf, off);
    const type = boxType(buf, off);
    let header = BOX_HEADER;
    if (size === 1) { if (off + 16 > end) break; size = Number(buf.readBigUInt64BE(off + 8)); header = 16; }
    else if (size === 0) size = end - off;
    if (size < header || off + size > end) break;
    found.counts[type] = (found.counts[type] || 0) + 1;
    if (!found[type]) found[type] = [];
    found[type].push({ offset: off, size, dataOffset: off + header });
    if (CONTAINERS.has(type) && depth < 8) {
      // 'meta' has a 4-byte version/flags preamble before children
      const extra = type === 'meta' ? 4 : 0;
      walk(buf, off + header + extra, off + size, depth + 1, found);
    }
    off += size;
  }
}

// Full ParsedMovieBox: sum of stts sample deltas * timescale gives track duration.
function readMvhd(buf, off) {
  const version = buf[off];
  if (version === 1) {
    return { timescale: u32(buf, off + 20), duration: Number(buf.readBigUInt64BE(off + 24)) };
  }
  return { timescale: u32(buf, off + 12), duration: u32(buf, off + 16) };
}
function readMdhd(buf, off) {
  const version = buf[off];
  if (version === 1) {
    return { timescale: u32(buf, off + 20), duration: Number(buf.readBigUInt64BE(off + 24)) };
  }
  return { timescale: u32(buf, off + 12), duration: u32(buf, off + 16) };
}
function readSttsTotal(buf, off) {
  const entries = u32(buf, off + 4);
  let total = 0;
  let p = off + 8;
  for (let i = 0; i < entries; i++) {
    const count = u32(buf, p); const delta = u32(buf, p + 4); p += 8;
    total += count * delta;
  }
  return total; // in track timescale units
}

// Read a metadata atom value (e.g. ©nam, ©ART) inside ilst. Returns first string.
function readIlstTag(buf, ilstBox, tag) {
  // children of ilst are atoms named e.g. ©nam containing a 'data' box
  let off = ilstBox.dataOffset;
  const end = ilstBox.offset + ilstBox.size;
  while (off + BOX_HEADER <= end) {
    const size = u32(buf, off);
    const type = boxType(buf, off);
    if (size < BOX_HEADER || off + size > end) break;
    if (type === tag) {
      // find nested 'data' box
      let d = off + BOX_HEADER; const dend = off + size;
      while (d + BOX_HEADER <= dend) {
        const ds = u32(buf, d);
        if (boxType(buf, d) === 'data') {
          // data box: 8-byte header + 8 bytes (type+locale) then value
          const voff = d + 8 + 8;
          const vlen = d + ds - voff;
          if (vlen > 0) return buf.toString('utf8', voff, voff + vlen);
        }
        d += ds;
      }
    }
    off += size;
  }
  return null;
}

// Main entry: validate a Buffer holding an mp4/m4a/fmp4 file.
// expectedSeconds: API-reported duration; tolerance default 2s.
function check(buf, { expectedSeconds = null, toleranceSeconds = 2 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < BOX_HEADER) {
    return { ok: false, reason: 'not-a-buffer', size: buf && buf.length };
  }
  const tops = topBoxes(buf);
  const found = { counts: {} };
  walk(buf, 0, buf.length, 0, found);
  const counts = found.counts;
  const types = tops.map((b) => b.type);

  const hasFtyp = !!counts.ftyp;
  const hasMoov = !!counts.moov;
  const hasMdat = !!counts.mdat;
  const moofCount = counts.moof || 0;
  const mvex = !!counts.mvex;
  const moof = moofCount > 0;
  const sidx = !!counts.sidx;
  const mehd = !!counts.mehd;

  // order: moov must appear before first mdat for a progressive file
  let moovBeforeMdat = null;
  const moovTop = tops.find((b) => b.type === 'moov');
  const mdatTop = tops.find((b) => b.type === 'mdat');
  if (moovTop && mdatTop) moovBeforeMdat = moovTop.offset < mdatTop.offset;

  // durations
  let mvhdDurS = null, mdhdDurS = null, sttsDurS = null;
  const mvhd = found.mvhd && found.mvhd[0];
  if (mvhd) { const d = readMvhd(buf, mvhd.dataOffset); mvhdDurS = d.timescale ? d.duration / d.timescale : null; }
  const mdhd = found.mdhd && found.mdhd[0];
  let trackTimescale = null;
  if (mdhd) { const d = readMdhd(buf, mdhd.dataOffset); trackTimescale = d.timescale; mdhdDurS = d.timescale ? d.duration / d.timescale : null; }
  const stts = found.stts && found.stts[0];
  if (stts && trackTimescale) sttsDurS = readSttsTotal(buf, stts.dataOffset) / trackTimescale;

  // metadata tags (©nam title / ©ART artist) inside moov.udta.meta.ilst
  let title = null, artist = null;
  const ilst = found.ilst && found.ilst[0];
  if (ilst) {
    title = readIlstTag(buf, ilst, '©nam');
    artist = readIlstTag(buf, ilst, '©ART') || readIlstTag(buf, ilst, 'aART');
  }

  // structural verdict
  const fragmented = moof || mvex || sidx;
  const reasons = [];
  if (!hasFtyp) reasons.push('no-ftyp');
  if (!hasMoov) reasons.push('no-moov');
  if (!hasMdat) reasons.push('no-mdat');
  if (fragmented) reasons.push('fragmented');
  if (moovBeforeMdat === false) reasons.push('moov-after-mdat');
  if (mvhdDurS == null) reasons.push('no-mvhd-duration');
  if (mdhdDurS == null) reasons.push('no-mdhd-duration');

  // duration agreement
  let durationOk = null;
  const dur = sttsDurS != null ? sttsDurS : mvhdDurS;
  if (expectedSeconds != null && dur != null) {
    durationOk = Math.abs(dur - expectedSeconds) <= toleranceSeconds;
    if (!durationOk) reasons.push('duration-mismatch');
  }
  if (mvhdDurS != null && mdhdDurS != null && Math.abs(mvhdDurS - mdhdDurS) > toleranceSeconds) {
    reasons.push('mvhd-mdhd-mismatch');
  }

  const ok = hasFtyp && hasMoov && hasMdat && !fragmented && moovBeforeMdat !== false &&
    mvhdDurS != null && mdhdDurS != null && (durationOk !== false);

  return {
    ok, reasons,
    size: buf.length,
    types,
    counts: { moov: counts.moov || 0, mdat: counts.mdat || 0, moof: moofCount, mvex: counts.mvex || 0, sidx: counts.sidx || 0, mehd: counts.mehd || 0 },
    fragmented,
    moovBeforeMdat,
    mvhdDurS, mdhdDurS, sttsDurS,
    title, artist,
  };
}

module.exports = { check, topBoxes };
