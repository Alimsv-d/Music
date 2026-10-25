'use strict';
// Download track (prefer /download, fallback /stream), normalize to real MP3
// via ffmpeg so Telegram shows the full seekable player with correct duration.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const config = require('../config');
const sc = require('../services/soundcloud');
const { getStore } = require('../core/store');
const log = require('../core/log');

const MAX_BYTES = 48 * 1024 * 1024;
let ffmpegChecked = null;
function hasFfmpeg() {
  if (ffmpegChecked !== null) return Promise.resolve(ffmpegChecked);
  return new Promise((res) => execFile('ffmpeg', ['-version'], (e) => { ffmpegChecked = !e; res(ffmpegChecked); }));
}

function runFfmpeg(args, timeout = 90000) {
  return new Promise((res, rej) => execFile('ffmpeg', args, { timeout }, (e) => e ? rej(e) : res()));
}

// Transcode to mp3 128k with proper headers so duration/seek works.
// Throws if the output is suspiciously small (encrypted/DRM source).
async function toMp3(src, dst) {
  await runFfmpeg(['-v', 'error', '-y', '-i', src, '-vn', '-acodec', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '2', dst], 120000);
  if (!fs.existsSync(dst) || fs.statSync(dst).size < 40 * 1024) throw new Error('transcode produced unusable audio');
}

function audioCaption(tr, lang) {
  const { i18n } = require('../core/context');
  const { esc, num } = i18n;
  const lines = [`🎵 <b>${esc(tr.title)}</b>`, `🎤 ${esc(tr.artist)}`];
  const meta = [];
  if (tr.duration) meta.push(`⏱ ${esc(tr.duration)}`);
  if (tr.genre) meta.push(`🏷 ${esc(tr.genre)}`);
  if (tr.plays) meta.push(`🎧 ${num(lang, tr.plays)}`);
  if (meta.length) lines.push(meta.join('  •  '));
  return lines.join('\n');
}

async function downloadAndSend(ctx, tr, lang) {
  const store = getStore();
  const sid = sc.sidOf(tr);
  const chatId = ctx.chat.id;
  const cache = store.get('file_id_cache', sid);

  const title = tr.title || 'track';
  const performer = tr.artist || '';
  const duration = Math.round((tr.duration_ms || 0) / 1000);

  // cached file_id (already a proper audio) — resend instantly
  if (cache && cache.file_id) {
    try { await ctx.api.sendAudio(chatId, cache.file_id, { title, performer, duration }); return; }
    catch (_) { store.del('file_id_cache', sid); }
  }

  const base = `${performer} - ${title}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const raw = path.join(config.tmpDir, `dl_${sid}_${Date.now()}.raw`);
  const mp3 = raw + '.mp3';
  const cleanup = () => { for (const f of [raw, mp3]) { try { fs.unlinkSync(f); } catch (_) {} } };
  let sentFileId = null;
  try {
    await sc.downloadFile(sid, raw, MAX_BYTES);
    const st = fs.statSync(raw);
    if (st.size < 128 || st.size > MAX_BYTES) throw new Error('invalid audio payload');
    const prefix = fs.readFileSync(raw, { encoding: 'utf8', flag: 'r' }).slice(0, 32);
    if (prefix.trimStart().startsWith('{') || prefix.includes('"ok":false')) throw new Error('audio endpoint returned JSON');

    let file = raw, ext = '.m4a';
    if (await hasFfmpeg()) {
      try { await toMp3(raw, mp3); file = mp3; ext = '.mp3'; }
      catch (e) { log.warn('transcode fail, sending raw', e.message); }
    }
    const { InputFile } = require('grammy');
    const msg = await ctx.api.sendAudio(chatId, new InputFile(file, base + ext), {
      title, performer, duration,
      caption: audioCaption(tr, lang), parse_mode: 'HTML',
    });
    sentFileId = msg.audio && msg.audio.file_id;
    if (sentFileId) store.set('file_id_cache', sid, { file_id: sentFileId });
  } finally { cleanup(); }
}

module.exports = { downloadAndSend };
