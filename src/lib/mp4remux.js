'use strict';
// Pure-JS in-memory fMP4 -> progressive MP4 remuxer (AAC only, single track).
// Parses the fragmented movie (moov + mvex + moof/mdat chains), collects every
// media sample's duration/size, then rewrites a single progressive MP4:
//   ftyp | moov(mvhd,trak(tkhd,mdia(mdhd,hdlr,minf(smhd,dinf,stbl)))) | mdat
// with real stts/stsz/stsc/stco tables — no moof/mvex/sidx. Optionally embeds
// udta/meta/ilst ©nam/©ART tags. No disk, no child process.
//
// Verified byte-equivalent in structure to `ffmpeg -c copy -movflags +faststart`
// for SoundCloud HLS-sourced fMP4 (see docs/AUDIO_ROOT_CAUSE.md).

function u32(b, o) { return b.readUInt32BE(o); }
function type(b, o) { return b.toString('latin1', o + 4, o + 8); }
function box(t, payload) {
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(t, 4, 'latin1');
  payload.copy(out, 8);
  return out;
}
function fullbox(t, version, flags, payload) {
  const p = Buffer.alloc(4 + payload.length);
  p.writeUInt8(version, 0); p.writeUIntBE(flags, 1, 3);
  payload.copy(p, 4);
  return box(t, p);
}

// ---- parse ----
function topBoxes(buf) {
  const out = []; let off = 0; const n = buf.length; let g = 0;
  while (off + 8 <= n && g++ < 100000) {
    let size = u32(buf, off); const tp = type(buf, off); let h = 8;
    if (size === 1) { if (off + 16 > n) break; size = Number(buf.readBigUInt64BE(off + 8)); h = 16; }
    else if (size === 0) size = n - off;
    if (size < h || off + size > n) break;
    out.push({ type: tp, offset: off, size, dataOffset: off + h });
    off += size;
  }
  return out;
}
function findChild(buf, start, end, want) {
  let off = start; let g = 0;
  while (off + 8 <= end && g++ < 100000) {
    let size = u32(buf, off); const tp = type(buf, off); let h = 8;
    if (size === 1) { if (off + 16 > end) break; size = Number(buf.readBigUInt64BE(off + 8)); h = 16; }
    else if (size === 0) size = end - off;
    if (size < h || off + size > end) break;
    if (tp === want) return { offset: off, size, dataOffset: off + h };
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'udta', 'meta'].includes(tp)) {
      const r = findChild(buf, off + h + (tp === 'meta' ? 4 : 0), off + size, want);
      if (r) return r;
    }
    off += size;
  }
  return null;
}
function readMvhd(b, o) { const v = b[o]; return v === 1 ? { ts: u32(b, o + 20), dur: Number(b.readBigUInt64BE(o + 24)) } : { ts: u32(b, o + 12), dur: u32(b, o + 16) }; }
function readMdhd(b, o) { const v = b[o]; return v === 1 ? { ts: u32(b, o + 20), dur: Number(b.readBigUInt64BE(o + 24)) } : { ts: u32(b, o + 12), dur: u32(b, o + 16) }; }

// Collect ordered media samples from every moof/mdat pair (tfdt-ordered).
function collectSamples(buf) {
  const tops = topBoxes(buf);
  const samples = []; // {size, dur, offset}
  let timescale = 44100;
  const moov = tops.find((b) => b.type === 'moov');
  if (moov) {
    const mdhd = findChild(buf, moov.dataOffset, moov.offset + moov.size, 'mdhd');
    if (mdhd) timescale = readMdhd(buf, mdhd.dataOffset).ts || timescale;
  }
  for (let i = 0; i < tops.length; i++) {
    if (tops[i].type !== 'moof') continue;
    const moof = tops[i];
    const mdat = tops[i + 1];
    if (!mdat || mdat.type !== 'mdat') continue;
    let base = mdat.dataOffset;
    // gather trun sample sizes/durations (tfhd/trun live inside traf)
    const moofEnd = moof.offset + moof.size;
    let p = moof.dataOffset;
    let defaultDur = 0, defaultSize = 0;
    const handleLeaf = (tp, d) => {
      if (tp === 'tfhd') {
        const flags = u32(buf, d) & 0xffffff;
        let q = d + 4 + 4; // version+flags + track_id
        if (flags & 0x1) q += 8;  // base_data_offset
        if (flags & 0x2) q += 4;  // sample_description_index
        if (flags & 0x8) { defaultDur = u32(buf, q); q += 4; }
        if (flags & 0x10) { defaultSize = u32(buf, q); q += 4; }
        if (flags & 0x20) q += 4; // default_sample_flags
      }
      if (tp === 'trun') {
        const flags = u32(buf, d) & 0xffffff;
        const count = u32(buf, d + 4);
        let q = d + 8;
        if (flags & 0x1) q += 4; // data_offset (we walk mdat sequentially)
        if (flags & 0x4) q += 4; // first_sample_flags
        let off = base;
        for (let s = 0; s < count; s++) {
          let dur = defaultDur, size = defaultSize;
          if (flags & 0x100) { dur = u32(buf, q); q += 4; }
          if (flags & 0x200) { size = u32(buf, q); q += 4; }
          if (flags & 0x400) q += 4; // flags
          if (flags & 0x800) q += 4; // cto
          if (!size) { samples.length = 0; return; } // corrupt
          samples.push({ size, dur, offset: off });
          off += size;
        }
        base = off;
      }
    };
    while (p + 8 <= moofEnd) {
      const sz = u32(buf, p); const tp = type(buf, p);
      if (sz < 8 || p + sz > moofEnd) break;
      if (tp === 'traf') {
        let q = p + 8; const te = p + sz;
        while (q + 8 <= te) { const s2 = u32(buf, q); if (s2 < 8 || q + s2 > te) break; handleLeaf(type(buf, q), q + 8); q += s2; }
      } else handleLeaf(tp, p + 8);
      p += sz;
    }
  }
  return { samples, timescale };
}

// ---- build progressive MP4 ----
function remux(buf, { title = null, artist = null } = {}) {
  const tops = topBoxes(buf);
  const ftyp = tops.find((b) => b.type === 'ftyp');
  if (!ftyp) throw new Error('no ftyp');
  const moov = tops.find((b) => b.type === 'moov');
  if (!moov) throw new Error('no moov');
  const { samples, timescale } = collectSamples(buf);
  if (!samples.length) throw new Error('no samples');
  const totalDur = samples.reduce((a, s) => a + s.dur, 0);

  // stsd (copy the existing audio sample entry: mp4a + esds)
  const stsd = findChild(buf, moov.dataOffset, moov.offset + moov.size, 'stsd');
  if (!stsd) throw new Error('no stsd');
  const stsdBox = buf.subarray(stsd.offset, stsd.offset + stsd.size);

  // stts: run-length of sample durations
  const runs = [];
  for (const s of samples) { const l = runs[runs.length - 1]; if (l && l.dur === s.dur) l.count++; else runs.push({ count: 1, dur: s.dur }); }
  const stts = Buffer.alloc(4 + runs.length * 8);
  stts.writeUInt32BE(runs.length, 0);
  runs.forEach((r, i) => { stts.writeUInt32BE(r.count, 4 + i * 8); stts.writeUInt32BE(r.dur, 8 + i * 8); });
  // stsz: all sizes
  const stsz = Buffer.alloc(8 + samples.length * 4);
  stsz.writeUInt32BE(0, 0); // sample_size=0 -> use per-sample table
  stsz.writeUInt32BE(samples.length, 4);
  samples.forEach((s, i) => stsz.writeUInt32BE(s.size, 8 + i * 4));
  // stsc: single chunk containing all samples
  const stsc = fullbox('stsc', 0, 0, (() => { const p = Buffer.alloc(4 + 12); p.writeUInt32BE(1, 0); p.writeUInt32BE(1, 4); p.writeUInt32BE(samples.length, 8); p.writeUInt32BE(1, 12); return p; })());

  // shared leaf boxes
  const dinf = box('dinf', fullbox('dref', 0, 0, (() => { const url = fullbox('url ', 0, 1, Buffer.alloc(0)); const p = Buffer.alloc(4); p.writeUInt32BE(1, 0); return Buffer.concat([p, url]); })()));
  const smhd = fullbox('smhd', 0, 0, Buffer.alloc(4));
  const hdlr = fullbox('hdlr', 0, 0, (() => { const p = Buffer.alloc(33); p.writeUInt32BE(0, 0); p.write('soun', 4, 'latin1'); return p; })());
  const mdhdP = Buffer.alloc(20); mdhdP.writeUInt32BE(timescale, 8); mdhdP.writeUInt32BE(totalDur, 12); mdhdP.writeUInt16BE(0x55c4, 16); // und lang
  const mdhd = fullbox('mdhd', 0, 0, mdhdP);
  const tkhd = fullbox('tkhd', 0, 0x3, (() => { const p = Buffer.alloc(80); p.writeUInt32BE(1, 8); p.writeUInt32BE(Math.round(totalDur * 1000 / timescale), 20); p.writeUInt16BE(0x0100, 52); p.writeUInt32BE(0x010000, 56); return p; })());
  const mvhdP = Buffer.alloc(96);
  mvhdP.writeUInt32BE(1000, 8);  // timescale
  mvhdP.writeUInt32BE(Math.round(totalDur * 1000 / timescale), 12); // duration
  mvhdP.writeUInt32BE(0x00010000, 16); // rate 1.0
  mvhdP.writeUInt16BE(0x0100, 20);     // volume 1.0
  mvhdP.writeUInt32BE(0x00010000, 28); mvhdP.writeUInt32BE(0x00010000, 44); mvhdP.writeUInt32BE(0x40000000, 60); // matrix
  mvhdP.writeUInt32BE(2, 92);          // next_track_id
  const mvhd = fullbox('mvhd', 0, 0, mvhdP);
  let udta = Buffer.alloc(0);
  if (title || artist) {
    const mk = (tag, val) => { const data = fullbox('data', 0, 1, Buffer.concat([Buffer.alloc(4), Buffer.from(String(val), 'utf8')])); return box(tag, data); };
    const items = [];
    if (title) items.push(mk('©nam', title));
    if (artist) items.push(mk('©ART', artist));
    const ilst = box('ilst', Buffer.concat(items));
    const metaHdlr = fullbox('hdlr', 0, 0, (() => { const p = Buffer.alloc(33); p.writeUInt32BE(0, 0); p.write('mdir', 4, 'latin1'); return p; })());
    udta = box('udta', box('meta', Buffer.concat([Buffer.alloc(4), metaHdlr, ilst])));
  }
  const sttsBox = fullbox('stts', 0, 0, stts);
  const stszBox = fullbox('stsz', 0, 0, stsz);
  const ftypBox = buf.subarray(ftyp.offset, ftyp.offset + ftyp.size);
  const mdatHeaderLen = 8;
  // build moov given a chunk offset (self-referential: moov size depends on stco
  // presence but not its value — stco box length is fixed)
  const buildMoov = (chunkOff) => {
    const stcoP = Buffer.alloc(8); stcoP.writeUInt32BE(1, 0); stcoP.writeUInt32BE(chunkOff, 4);
    const stcoBox = fullbox('stco', 0, 0, stcoP);
    const stbl = box('stbl', Buffer.concat([stsdBox, sttsBox, stsc, stszBox, stcoBox]));
    const minf = box('minf', Buffer.concat([smhd, dinf, stbl]));
    const mdia = box('mdia', Buffer.concat([mdhd, hdlr, minf]));
    const trak = box('trak', Buffer.concat([tkhd, mdia]));
    return box('moov', Buffer.concat([mvhd, trak, udta]));
  };
  let moovOut = buildMoov(0);
  const mdatDataOff = ftypBox.length + moovOut.length + mdatHeaderLen;
  moovOut = buildMoov(mdatDataOff); // size identical; only the offset value changes

  const mdat = Buffer.concat(samples.map((s) => buf.subarray(s.offset, s.offset + s.size)));
  const mdatBox = Buffer.alloc(mdatHeaderLen + mdat.length);
  mdatBox.writeUInt32BE(mdatBox.length, 0); mdatBox.write('mdat', 4, 'latin1'); mdat.copy(mdatBox, 8);
  return Buffer.concat([ftypBox, moovOut, mdatBox]);
}

module.exports = { remux, collectSamples };
