'use strict';
// Direct-send audio pipeline. NO disk writes, NO transcode, NO ffprobe/RMS on
// the main path. Flow:
//   file_id cache -> in-memory fetch (single GET or HLS stitch) -> upload as
//   .mp3 (so Telegram returns a real `audio` object) -> verify duration -> cache.
const config = require('../config');
const sc = require('../services/soundcloud');
const { getStore } = require('../core/store');
const log = require('../core/log');

const MAX_BYTES = 48 * 1024 * 1024;
const CACHE_VERSION = 'v5';
const META_VERSION = 'cleanTrackMeta-v2';

// Output container preference for the audio send path. 'mp3' (default) uploads
// the assembled bytes with an .mp3 filename/mime so Telegram returns a seekable
// `audio` object; 'm4a' is kept for the forensic /audiotest A/B comparison and
// is NOT used on the user-facing path because URL-sends of m4a land as
// `document`. Changeable from the owner settings panel.
function audioFormat() {
  const s = getStore().get('settings', 'global') || {};
  // default 'm4a': lossless remux to a progressive, seekable container (fixes F1
  // without re-encoding). 'mp3' re-encodes as a fallback.
  return s.audio_format === 'mp3' ? 'mp3' : 'm4a';
}

function audioCaption(tr, lang) {
  const { i18n } = require('../core/context'); const { cleanTrackMeta } = require('../services/trackMeta'); const { esc } = i18n;
  const m = cleanTrackMeta(tr);
  const dur = tr.duration || (tr.duration_ms ? `${Math.floor(tr.duration_ms / 60000)}:${String(Math.round(tr.duration_ms / 1000) % 60).padStart(2, '0')}` : null);
  const lines = [`🎵 <b>${esc(m.title)}</b>`];
  if (m.artist) lines.push(`👤 ${esc(m.artist)}`);
  if (dur) lines.push(`⏱ ${esc(dur)}`);
  return lines.join('\n');
}

// standard audio-message buttons: more-by-artist + share
function audioButtons(tr, lang) {
  const { kb, B, URLB } = require('./keyboard');
  const { cleanTrackMeta } = require('../services/trackMeta');
  const m = cleanTrackMeta(tr);
  const rows = [];
  if (m.artist) rows.push([B(`🔎 آهنگ‌های بیشتر از ${m.artist}`, 'qa:' + Buffer.from(m.artist).toString('base64url').slice(0, 44))]);
  rows.push([URLB('📤 اشتراک‌گذاری', `https://t.me/share/url?url=${encodeURIComponent('🎵 ' + (m.artist ? m.artist + ' — ' : '') + m.title)}`)]);
  return kb(rows);
}

// Fetch track bytes fully into memory. Returns {buf, via}.
async function buildAudioBuffer(tr, sid = sc.sidOf(tr)) {
  const { buf, via } = await sc.fetchTrackBuffer(sid, { maxBytes: MAX_BYTES });
  if (!buf || buf.length < 40 * 1024) { const e = new Error('audio too small'); e.code = 'TOO_SMALL'; throw e; }
  return { buf, via, size: buf.length };
}

// Normalise the fetched bytes into a *progressive, seekable* container in memory.
// The SoundCloud catalog is HLS-only: the worker emits fragmented MP4 (fMP4),
// which Telegram's player truncates to the first fragment (~12s bug, F1). For
// fMP4 we remux losslessly to progressive MP4 (-c copy equivalent). For the
// default 'mp3' format we re-encode to real MP3 so Telegram shows a seekable
// audio object with correct duration and performer/title. No disk writes.
async function normalizeAudio(tr, sid = sc.sidOf(tr)) {
  const { buf, via } = await buildAudioBuffer(tr, sid);
  const mp4check = require('../lib/mp4check');
  const meta = require('../services/trackMeta').cleanTrackMeta(tr);
  const expected = Math.round((tr.duration_ms || 0) / 1000);
  const struct = mp4check.check(buf, { expectedSeconds: expected });
  const fmt = audioFormat();
  const { remux } = require('../lib/mp4remux');
  const { transcodeToMp3 } = require('./audio');
  // mp3 fallback is opt-in; m4a progressive remux is the default.
  if (fmt === 'mp3') {
    const mp3 = await transcodeToMp3(buf, { durationSec: expected });
    if (!mp3 || mp3.length < 40 * 1024) { const e = new Error('mp3 too small'); e.code = 'TOO_SMALL'; throw e; }
    return { buf: mp3, ext: 'mp3', mime: 'audio/mpeg', via: via + '+mp3', size: mp3.length };
  }
  // m4a: lossless remux to progressive MP4 (source is fMP4 from HLS stitching)
  try {
    const out = struct.ok ? buf : remux(buf, { title: meta.title, artist: meta.artist });
    const ok = mp4check.check(out, { expectedSeconds: expected });
    if (ok.ok) return { buf: out, ext: 'm4a', mime: 'audio/mp4', via: via + '+remux', size: out.length };
    const e = new Error('remux produced invalid file: ' + ok.reasons.join(',')); e.code = 'REMUX_INVALID'; throw e;
  } catch (e) {
    if (e.code === 'REMUX_INVALID') throw e;
    // remux code error -> last resort: try mp3 transcode capped at expected duration
    const mp3 = await transcodeToMp3(buf, { durationSec: expected }).catch(() => null);
    if (mp3 && mp3.length > 40 * 1024) return { buf: mp3, ext: 'mp3', mime: 'audio/mpeg', via: via + '+mp3fb', size: mp3.length };
    throw e;
  }
}

async function downloadAndSend(ctx, tr, lang, opts = {}) {
  const t0 = Date.now();
  try { await _downloadAndSend(ctx, tr, lang, opts); }
  finally { require('../core/perf').record('send', Date.now() - t0); }
}
function streamFileUrl(sid, title, performer) {
  const slug = (performer ? performer + ' - ' : '') + title;
  return sc.fileUrl(sid, slug || 'track', 'mp3');
}

async function _downloadAndSend(ctx, tr, lang, opts = {}) {
  const store = getStore(), sid = sc.sidOf(tr), meta = require('../services/trackMeta').cleanTrackMeta(tr),
    cacheKey = `${sid}|${meta.artist}|${meta.title}|${META_VERSION}`, chatId = ctx.chat.id,
    key = store.get('file_id_cache', cacheKey);
  const title = meta.title || 'track', performer = meta.artist || '';
  const expected = Math.round((tr.duration_ms || 0) / 1000);
  const markup = opts.reply_markup || audioButtons(tr, lang);
  const share = { caption: audioCaption(tr, lang), parse_mode: 'HTML', reply_markup: markup, ...(opts.reply_to ? { reply_to_message_id: opts.reply_to } : {}) };

  // 1) verified file_id -> instant send
  if (key && key.file_id && key.v === CACHE_VERSION) {
    try {
      const sent = await ctx.api.sendAudio(chatId, key.file_id, { title, performer, duration: key.duration, ...share });
      const sentDuration = sent && sent.audio && sent.audio.duration;
      if (expected && sentDuration && Math.abs(sentDuration - expected) > 3) {
        try { await ctx.api.deleteMessage(chatId, sent.message_id); } catch (_) {}
        store.del('file_id_cache', cacheKey);
      } else return;
    } catch (_) { store.del('file_id_cache', cacheKey); }
  } else if (key) store.del('file_id_cache', cacheKey);

  // 2) URL-send the worker's validated progressive file (zero bytes through the
  //    bot). Only when the worker v2 /f/ endpoint is up. Falls back to the
  //    in-memory remux+upload path on any failure.
  try {
    const url = streamFileUrl(sid, title, performer);
    const sent = await ctx.api.sendAudio(chatId, url, { title, performer, duration: expected || undefined, ...share });
    if (sent && sent.audio && sent.audio.file_id) {
      store.set('file_id_cache', cacheKey, {
        file_id: sent.audio.file_id, v: CACHE_VERSION, metaVersion: META_VERSION,
        artist: performer, title, duration: sent.audio.duration || expected,
        validated: true, via: 'url' });
      return;
    }
    try { await ctx.api.deleteMessage(chatId, sent.message_id); } catch (_) {}
  } catch (_) { /* fall through to in-memory */ }

  // 3) in-memory fetch -> normalise to progressive/seekable container -> upload
  const { InputFile } = require('grammy');
  const audio = await normalizeAudio(tr, sid);
  const fname = (`${performer} - ${title}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || 'track') + '.' + audio.ext;
  const file = new InputFile(audio.buf, fname);
  const msg = await ctx.api.sendAudio(chatId, file, { title, performer, duration: expected || undefined, ...share });
  const result = msg.audio;
  if (!result || !result.file_id) {
    try { await ctx.api.deleteMessage(chatId, msg.message_id); } catch (_) {}
    const e = new Error('Telegram returned no audio object'); e.code = 'NO_AUDIO'; throw e;
  }
  // free verification: returned duration must match API duration within 3s.
  const rd = result.duration || 0;
  if (expected && Math.abs(rd - expected) > 3) {
    try { await ctx.api.deleteMessage(chatId, msg.message_id); } catch (_) {}
    const e = new Error(`duration mismatch ${rd} != ${expected}`); e.code = 'DURATION_MISMATCH'; throw e;
  }
  store.set('file_id_cache', cacheKey, {
    file_id: result.file_id, v: CACHE_VERSION, metaVersion: META_VERSION,
    artist: performer, title, duration: rd || expected, validated: true,
    size: result.file_size || audio.size, via: audio.via,
  });
}

module.exports = { downloadAndSend, buildAudioBuffer, normalizeAudio, audioCaption, audioButtons, audioFormat, CACHE_VERSION };
