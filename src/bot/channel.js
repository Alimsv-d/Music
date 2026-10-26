'use strict';
// News channel: multi-channel management, follow/scan, post formatting, queue.
const config = require('../config');
const { store, i18n } = require('../core/context');
const { t, esc, num, dateFmt, dateGreg } = i18n;
const sc = require('../services/soundcloud');
const { normalize } = require('../services/query');
const log = require('../core/log');
const { kb, G, B, R, URLB } = require('./keyboard');

function channels() { return store.get('settings', 'channels') || []; }
function saveChannels(l) { store.set('settings', 'channels', l); }
function follows() { return store.get('settings', 'follows') || []; }
function saveFollows(l) { store.set('settings', 'follows', l); }
function queueList() { return store.get('settings', 'post_queue') || []; }
function saveQueue(l) { store.set('settings', 'post_queue', l); }
function postPolicy() {
  const cfg = store.get('settings', 'channel_policy') || {};
  return {
    enabled: cfg.enabled !== false,
    maxPerDay: Number(cfg.maxPerDay || 3),
    minGapMs: Number(cfg.minGapMs || 3 * 60 * 60 * 1000),
    quietStart: Number(cfg.quietStart ?? 1),
    quietEnd: Number(cfg.quietEnd ?? 8),
    preview: !!cfg.preview,
  };
}
function savePostPolicy(cfg) { store.set('settings', 'channel_policy', cfg); }
function todayTehran() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function inQuietHours(cfg, now) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', hour12: false }).format(new Date(now)));
  return cfg.quietStart <= cfg.quietEnd ? (hour >= cfg.quietStart && hour < cfg.quietEnd) : (hour >= cfg.quietStart || hour < cfg.quietEnd);
}

async function channelStatus(api, ch) {
  try {
    const chat = await api.getChat(ch.id);
    const me = await api.getMe();
    const member = await api.getChatMember(ch.id, me.id);
    const ok = ['administrator', 'creator'].includes(member.status) && (member.can_post_messages !== false);
    return { ok, title: chat.title, reason: ok ? null : 'not admin/no post' };
  } catch (e) {
    return { ok: false, reason: String(e.description || e.message || e).slice(0, 80) };
  }
}

function dedupeKey(tr) { return normalize(`${tr.artist} ${tr.title}`); }
function alreadyPosted(tr) {
  const sid = String(tr.sid || tr.id);
  if (store.get('posted_tracks', 'id:' + sid)) return true;
  if (store.get('posted_tracks', 'k:' + dedupeKey(tr))) return true;
  return false;
}
function markPosted(tr) {
  const sid = String(tr.sid || tr.id);
  store.set('posted_tracks', 'id:' + sid, { at: Date.now() });
  store.set('posted_tracks', 'k:' + dedupeKey(tr), { at: Date.now() });
}

function hashtags(tr, lang) {
  const tags = [];
  const add = (s) => { const x = String(s || '').replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_]/gu, ''); if (x && !tags.includes(x)) tags.push('#' + x); };
  add(tr.artist); if (tr.genre) add(tr.genre);
  // persian+latin music tags
  add('آهنگ'); add('music');
  return tags.slice(0, 6).join(' ');
}

function postCaption(tr, ch, lang) {
  const d = tr.created_at ? new Date(tr.created_at) : null;
  const date = d ? dateFmt('fa', d) + ' • ' + dateGreg('en', d) : null;
  const lines = [
    `🎵 <b>${esc(tr.title)}</b>`,
    ``,
    `🎤 <b>${esc(tr.artist)}</b>`,
    date ? `🗓 ${esc(date)}` : null,
    tr.duration || tr.duration_ms ? `⏱ ${esc(tr.duration || fmtDur(tr.duration_ms))}` : null,
    tr.genre ? `🏷 ${esc(tr.genre)}` : null,
    tr.plays ? `🎧 ${num('fa', tr.plays)}` : null,
    '',
    `<i>${esc(hashtags(tr, lang))}</i>`,
    (ch && ch.signature) ? `\n${esc(ch.signature)}` : null,
  ].filter((l) => l !== null && l !== undefined);
  return lines.join('\n');
}

function fmtDur(ms) { if (!ms) return ''; const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

// Build inline keyboard properly (mix of url + callback). Use simple url buttons.
function postKb(tr, lang) {
  const sid = sc.sidOf(tr);
  return kb([
    [URLB(t(lang, 'btn_download_bot'), `https://t.me/${config.botUsername}?start=t_${sid}`)],
    [URLB(t(lang, 'btn_more_search'), `https://t.me/${config.botUsername}?start=s_${encodeURIComponent((tr.artist || '').slice(0, 20))}`), URLB(t(lang, 'btn_soundcloud'), tr.page_url || 'https://soundcloud.com')],
  ]);
}

async function sendPost(api, chId, tr, lang = 'fa', opts = {}) {
  const ch = (channels().find((c) => String(c.id) === String(chId))) || { id: chId };
  const caption = tr.customCaption || postCaption(tr, ch, lang);
  const cover = tr.cover ? sc.coverUrl(tr.cover) : null;
  const base = { caption, parse_mode: 'HTML', reply_markup: postKb(tr, lang), ...(opts.silent ? { disable_notification: true } : {}) };
  let msg;
  if (cover) {
    msg = await api.sendPhoto(chId, cover, base);
  } else {
    msg = await api.sendMessage(chId, caption, { ...base, disable_web_page_preview: true });
  }
  // demo voice note: short mp3 clip sent as a voice reply to the post
  try {
    const demo = await makeDemo(tr);
    if (demo) {
      const { InputFile } = require('grammy');
      await api.sendVoice(chId, new InputFile(demo.buf, `${tr.artist} - ${tr.title}`.slice(0, 60) + '.mp3'), {
        duration: Math.min(30, Math.round((tr.duration_ms || 0) / 1000) || 30),
        reply_to_message_id: msg.message_id, ...(opts.silent ? { disable_notification: true } : {}),
      });
    }
  } catch (e) { log.warn('demo', e.message); }
  markPosted(tr);
  return msg;
}

// Build a ~30s demo clip from the stream entirely via ffmpeg pipes — no disk.
async function makeDemo(tr) {
  const { spawn } = require('node:child_process');
  const sid = sc.sidOf(tr);
  try {
    const { request } = require('../core/http');
    const res = await request(sc.streamUrl(sid), { timeout: 30000, maxBytes: 2 * 1024 * 1024 });
    const src = res.body;
    const out = await new Promise((resolve, reject) => {
      const p = spawn('nice', ['-n', '10', 'ffmpeg', '-v', 'error', '-i', 'pipe:0', '-t', '30', '-acodec', 'libmp3lame', '-b:a', '96k', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks = [];
      const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} ; reject(new Error('ffmpeg timeout')); }, 30000);
      p.stdout.on('data', (c) => chunks.push(c));
      p.on('error', (e) => { clearTimeout(to); reject(e); });
      p.on('close', (code) => { clearTimeout(to); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('exit ' + code)); });
      p.stdin.on('error', () => {});
      p.stdin.write(src); p.stdin.end();
    });
    if (out.length > 20000) return { buf: out };
    return null;
  } catch (_) { return null; }
}

// produce a preview to owner with action buttons
async function sendPreview(api, tr, lang = 'fa') {
  const ch = { signature: '' };
  const caption = postCaption(tr, ch, lang);
  const sid = sc.sidOf(tr);
  const cover = tr.cover ? sc.coverUrl(tr.cover) : null;
  const actionKb = kb([
    [G(t(lang, 'btn_publish'), `cp:pub:${sid}`), B(t(lang, 'btn_edit'), `cp:edit:${sid}`)],
    [B(t(lang, 'btn_schedule'), `cp:sch:${sid}`), R(t(lang, 'btn_reject'), `cp:rej:${sid}`)],
  ]);
  const stash = store.get('settings', 'pending_posts') || {};
  stash[sid] = { tr, at: Date.now() };
  store.set('settings', 'pending_posts', stash);
  if (cover) return api.sendPhoto(config.ownerId, cover, { caption, parse_mode: 'HTML', reply_markup: actionKb });
  return api.sendMessage(config.ownerId, caption, { parse_mode: 'HTML', reply_markup: actionKb });
}

// follow scan: for each follow term, search & find new tracks (last 7 days)
async function scanFollows(api) {
  const fl = follows();
  if (!fl.length) return;
  const now = Date.now();
  for (const f of fl) {
    try {
      const d = await sc.search(f.term, 1, 'fa');
      for (const tr of (d.results || []).slice(0, 10)) {
        const created = tr.created_at ? new Date(tr.created_at).getTime() : 0;
        if (now - created > 7 * 86400000) continue;
        if (alreadyPosted(tr)) continue;
        if (postPolicy().preview) await sendPreview(api, tr, 'fa');
        else { const q = queueList(); q.push({ tr, at: now }); saveQueue(q); }
      }
    } catch (e) { log.warn('follow scan', e.message); }
  }
}

// publish queue with safe spacing and policy limits
async function drainQueue(api) {
  const q = queueList();
  if (!q.length) return;
  const cfg = postPolicy();
  const now = Date.now();
  if (!cfg.enabled || inQuietHours(cfg, now)) return;
  const postedToday = store.get('stats', 'channel_posts:' + todayTehran()) || 0;
  if (postedToday >= cfg.maxPerDay) return;
  const lastPost = store.get('stats', 'last_channel_post') || 0;
  if (now - lastPost < cfg.minGapMs) return;
  const item = q.find((x) => !x.at || x.at <= now);
  if (!item) return;
  const chans = channels().filter((c) => c.auto !== false);
  try {
    for (const ch of (chans.length ? chans : channels())) {
      if (item.targets && !item.targets.includes(String(ch.id))) continue;
      await sendPost(api, ch.id, item.tr, ch.lang || 'fa');
      await new Promise((r) => setTimeout(r, 1500));
    }
    saveQueue(q.filter((x) => x !== item));
    store.set('stats', 'channel_posts:' + todayTehran(), postedToday + 1);
    store.set('stats', 'last_channel_post', now);
  } catch (e) { log.warn('queue drain', e.message); }
}

async function cronTick(api) {
  // periodic: follow scan + queue drain + negcache cleanup
  try { await drainQueue(api); } catch (e) { log.error('drain', e.message); }
  const last = store.get('stats', 'last_follow_scan') || 0;
  const interval = (store.get('settings', 'follow_interval_min') || 30) * 60000;
  if (Date.now() - last > interval) {
    store.set('stats', 'last_follow_scan', Date.now());
    try { await scanFollows(api); } catch (e) { log.error('follow scan', e.message); }
  }
}

async function channelSummary(api) {
  const cfg = postPolicy(), q = queueList(), chans = channels();
  const st = [];
  for (const ch of chans.slice(0, 8)) st.push(await channelStatus(api, ch));
  const last = store.get('stats', 'last_channel_post') || 0;
  return {
    cfg, queued: q.length, channels: chans.map((c, i) => ({ id: c.id, title: c.title, auto: c.auto !== false, status: st[i] && st[i].ok, reason: st[i] && st[i].reason })), lastPost: last,
  };
}

module.exports = { channels, saveChannels, follows, saveFollows, queueList, saveQueue, postPolicy, savePostPolicy, channelStatus, channelSummary, sendPost, sendPreview, scanFollows, drainQueue, cronTick, postCaption, postKb, alreadyPosted, markPosted };
