'use strict';
// Download track (progressive → stream → HLS-stitch), validate real audio,
// transcode to MP3 so Telegram shows a full seekable player with correct duration.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const config = require('../config');
const sc = require('../services/soundcloud');
const { getStore } = require('../core/store');
const log = require('../core/log');

const MAX_BYTES = 48 * 1024 * 1024;
const CACHE_VERSION = 'v2';
let ffmpegChecked = null;
function hasFfmpeg() {
  if (ffmpegChecked !== null) return Promise.resolve(ffmpegChecked);
  return new Promise((res) => execFile('ffmpeg', ['-version'], (e) => { ffmpegChecked = !e; res(ffmpegChecked); }));
}
function runFfmpeg(args, timeout = 90000) {
  return new Promise((res, rej) => execFile('ffmpeg', args, { timeout }, (e) => e ? rej(e) : res()));
}
function ffprobeDuration(file) {
  return new Promise((res) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 20000 }, (e, out) => {
      const n = e ? NaN : Number(String(out).trim());
      res(Number.isFinite(n) ? n : NaN);
    });
  });
}
// True when the source is DRM/CENC encrypted or otherwise undecodable.
function isEncryptedOrUndecodable(file) {
  return new Promise((res) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 20000 }, (e, out, err) => {
      const s = String(err || '') + String(out || '');
      res(/encryption info|Incorrect number of samples|Invalid data found|moov atom not found/.test(s));
    });
  });
}
async function toMp3(src, dst) {
  await runFfmpeg(['-v', 'error', '-y', '-i', src, '-vn', '-acodec', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '2', dst], 150000);
  if (!fs.existsSync(dst) || fs.statSync(dst).size < 40 * 1024) throw new Error('transcode produced unusable audio');
}

function audioCaption(tr, lang) {
  const { i18n } = require('../core/context');
  const { esc, num } = i18n;
  const lines = [`🎵 <b>${esc(tr.title)}</b>`, `👤 ${esc(tr.artist)}`];
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
  const metaDuration = Math.round((tr.duration_ms || 0) / 1000);

  // cached file_id (validated only) — resend instantly
  if (cache && cache.file_id && cache.v === CACHE_VERSION) {
    try { await ctx.api.sendAudio(chatId, cache.file_id, { title, performer, duration: cache.duration || metaDuration, caption: audioCaption(tr, lang), parse_mode: 'HTML' }); return; }
    catch (_) { store.del('file_id_cache', sid); }
  } else if (cache) store.del('file_id_cache', sid);

  const base = `${performer} - ${title}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  const raw = path.join(config.tmpDir, `dl_${sid}_${Date.now()}.raw`);
  const mp3 = raw + '.mp3';
  const cleanup = () => { for (const f of [raw, mp3]) { try { fs.unlinkSync(f); } catch (_) {} } };
  let sentFileId = null;
  try {
    await sc.downloadFile(sid, raw, MAX_BYTES);
    const st = fs.statSync(raw);
    if (st.size < 1024 || st.size > MAX_BYTES) throw new Error('invalid audio payload');
    const prefix = fs.readFileSync(raw, { encoding: 'utf8', flag: 'r' }).slice(0, 256);
    if (prefix.trimStart().startsWith('{') || /^#EXTM3U/i.test(prefix)) throw new Error('audio endpoint returned manifest/JSON');
    // DRM/CENC or undecodable source -> reject so caller picks another result.
    if (await isEncryptedOrUndecodable(raw)) { const e = new Error('source is encrypted or undecodable'); e.code = 'ENCRYPTED'; throw e; }

    let file = raw, ext = '.m4a', sendDuration = metaDuration;
    if (await hasFfmpeg()) {
      const srcDur = await ffprobeDuration(raw);
      // Reject upstream previews/partials masquerading as the full track.
      if (metaDuration && Number.isFinite(srcDur) && srcDur + 8 < metaDuration) {
        log.warn('short audio source rejected', { sid, srcDur, expected: metaDuration });
        throw new Error('source audio incomplete');
      }
      try {
        await toMp3(raw, mp3);
        file = mp3; ext = '.mp3';
        const outDur = await ffprobeDuration(mp3);
        if (Number.isFinite(outDur) && outDur > 1) sendDuration = Math.round(outDur);
      } catch (e) { log.warn('transcode fail, sending raw', e.message); }
    }
    const { InputFile } = require('grammy');
    const msg = await ctx.api.sendAudio(chatId, new InputFile(file, base + ext), {
      title, performer, duration: sendDuration,
      caption: audioCaption(tr, lang), parse_mode: 'HTML',
    });
    sentFileId = msg.audio && msg.audio.file_id;
    // sanity: reported duration should be within tolerance of metadata
    const tgDur = msg.audio && msg.audio.duration;
    if (sentFileId) store.set('file_id_cache', sid, { file_id: sentFileId, v: CACHE_VERSION, duration: sendDuration });
  } finally { cleanup(); }
}

module.exports = { downloadAndSend, ffprobeDuration };
