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

function audioCaption(tr, lang) {
  const { i18n } = require('../core/context'); const { cleanTrackMeta } = require('../services/trackMeta'); const { esc, num } = i18n;
  const m = cleanTrackMeta(tr); const lines = [`🎵 <b>${esc(m.title)}</b>`, `👤 ${esc(m.artist)}`];
  const meta = []; if (tr.duration) meta.push(`⏱ ${esc(tr.duration)}`); if (tr.genre) meta.push(`🏷 ${esc(tr.genre)}`); if (tr.plays) meta.push(`🎧 ${num(lang, tr.plays)}`); if (meta.length) lines.push(meta.join('  •  '));
  return lines.join('\n');
}

// Fetch track bytes fully into memory. Returns {buf, via}.
async function buildAudioBuffer(tr, sid = sc.sidOf(tr)) {
  const { buf, via } = await sc.fetchTrackBuffer(sid, { maxBytes: MAX_BYTES });
  if (!buf || buf.length < 40 * 1024) { const e = new Error('audio too small'); e.code = 'TOO_SMALL'; throw e; }
  return { buf, via, size: buf.length };
}

async function downloadAndSend(ctx, tr, lang, opts = {}) {
  const store = getStore(), sid = sc.sidOf(tr), meta = require('../services/trackMeta').cleanTrackMeta(tr),
    cacheKey = `${sid}|${meta.artist}|${meta.title}|${META_VERSION}`, chatId = ctx.chat.id,
    key = store.get('file_id_cache', cacheKey);
  const title = meta.title || 'track', performer = meta.artist || '';
  const expected = Math.round((tr.duration_ms || 0) / 1000);

  // 1) verified file_id -> instant send
  if (key && key.file_id && key.v === CACHE_VERSION) {
    try {
      await ctx.api.sendAudio(chatId, key.file_id, { title, performer, duration: key.duration, caption: audioCaption(tr, lang), parse_mode: 'HTML', ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}) });
      return;
    } catch (_) { store.del('file_id_cache', cacheKey); }
  } else if (key) store.del('file_id_cache', cacheKey);

  // 2) in-memory fetch -> upload as .mp3 -> verify -> cache
  const { InputFile } = require('grammy');
  const audio = await buildAudioBuffer(tr, sid);
  const fname = (`${performer} - ${title}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || 'track') + '.mp3';
  const file = new InputFile(audio.buf, fname);
  const msg = await ctx.api.sendAudio(chatId, file, {
    title, performer, duration: expected || undefined, caption: audioCaption(tr, lang), parse_mode: 'HTML',
    ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
    ...(opts.reply_to ? { reply_to_message_id: opts.reply_to } : {}),
  });
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

module.exports = { downloadAndSend, buildAudioBuffer, audioCaption, CACHE_VERSION };
