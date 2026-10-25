'use strict';
const config = require('../config');
const log = require('../core/log');
const rl = require('../core/ratelimit');
const { store, i18n, isOwner, getPanel, setPanel } = require('../core/context');
const { t, esc, iso, num, dateFmt, dateGreg, vtruncate } = i18n;
const { fmt, f, e } = require('../core/fmt');
const { kb, G, B, R, URLB, btn } = require('./keyboard');
const panel = require('./panel');
const sc = require('../services/soundcloud');
const sh = require('../services/shazam');
const ig = require('../services/instagram');
const { normalize, transliterate, aliasFor, isSoundCloudUrl, similarity } = require('../services/query');
const { downloadAndSend } = require('./send');
const { processAudio } = require('./audio');

const SEARCH_PAGE = 7;

function sidOf(tr) { return sc.sidOf(tr); }
function card(tr) { return `${tr.artist || '?'} — ${tr.title || '?'}`; }
function fmtDur(ms) { if (!ms) return ''; const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

async function editOrReply(ctx, text, extra) {
  try { return await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...(extra || {}) }); } catch (_) { return null; }
}
async function answer(ctx, text, alert) { if (ctx.callbackQuery) { try { await ctx.answerCallbackQuery({ text, show_alert: !!alert }); } catch (_) {} } }

// ============ SCREENS ============
panel.register('menu', async (ctx, p, lang) => {
  const own = isOwner(ctx.from.id);
  const rows = [
    [URLB(t(lang, 'menu_addgroup'), `https://t.me/${config.botUsername}?startgroup=true&admin=delete_messages+pin_messages`)],
    [URLB(t(lang, 'menu_channel'), `https://t.me/${String(config.channel).replace('@', '')}`), B(t(lang, 'menu_lang'), 'm:lang')],
    [B(t(lang, 'menu_help'), 'm:help'), B(t(lang, 'menu_support'), 'm:support')],
  ];
  if (own) rows.push([B(t(lang, 'menu_admin'), 'a:panel')]);
  const welcome = String(t(lang, 'welcome', { name: '' })).replace('{bot}', ctx.botUsername || config.botUsername);
  return { text: fmt(welcome.replace('{name}', e(ctx.from.first_name || 'دوست'))), keyboard: kb(rows) };
});

panel.register('help', async (ctx, p, lang) => ({
  text: t(lang, 'help_text') + '\n\n' + t(lang, 'about_text', { owner: esc(config.ownerName), user: '@' + config.ownerUsername }),
  keyboard: kb([[R(t(lang, 'back'), 'nav:back')]]),
}));

panel.register('lang', async (ctx, p, lang) => {
  const langs = i18n.availableLocales();
  const rows = [];
  for (let i = 0; i < langs.length; i += 3) {
    rows.push(langs.slice(i, i + 3).map((c) => { const l = i18n.loadLocale(c); return B(l && l.meta && l.meta.name || c, 'lang:' + c); }));
  }
  rows.push([R(t(lang, 'back'), 'nav:back')]);
  return { text: t(lang, 'lang_title'), keyboard: kb(rows) };
});

panel.register('results', async (ctx, params, lang) => {
  const { q, page = 1, items } = params;
  const rows = items.slice((page - 1) * SEARCH_PAGE, page * SEARCH_PAGE).map((tr) =>
    [G(vtruncate(card(tr), 42) + ` · ${tr.duration || ''}`, 'pick:' + sidOf(tr))]);
  const totalPages = Math.max(1, Math.ceil(items.length / SEARCH_PAGE));
  const nav = [];
  if (page > 1) nav.push(B('⬅️', `pg:${page - 1}`));
  nav.push(B(`${num(lang, page)} / ${num(lang, totalPages)}`, 'noop'));
  if (page < totalPages) nav.push(B('➡️', `pg:${page + 1}`));
  if (nav.length > 1 || totalPages > 1) rows.push(nav);
  rows.push([R(t(lang, 'back'), 'nav:menu')]);
  return { text: t(lang, 'results_title', { q: iso(esc(q)) }), keyboard: kb(rows) };
});

panel.register('track', async (ctx, params, lang) => {
  const tr = await sc.track(params.sid);
  const date = tr.created_at ? dateFmt(lang, new Date(tr.created_at)) + '  •  ' + dateGreg(lang, new Date(tr.created_at)) : null;
  const lines = [
    `🎵 <b>${esc(tr.title)}</b>`,
    `👤 ${esc(tr.artist)}`,
    date ? `📅 ${iso(esc(date))}` : null,
    tr.duration || tr.duration_ms ? `⏱ ${esc(tr.duration || fmtDur(tr.duration_ms))}` : null,
    tr.genre ? `🏷 ${esc(tr.genre)}` : null,
    tr.plays ? `🎧 ${num(lang, tr.plays)}` : null,
  ].filter(Boolean);
  const fav = isFav(ctx.from.id, sidOf(tr));
  const rows = [
    [G(t(lang, 'dl'), 'dl:' + sidOf(tr))],
    [B(t(lang, 'lyrics'), 'lyr:' + sidOf(tr)), B(t(lang, 'similar'), 'sim:' + sidOf(tr))],
    [fav ? B(t(lang, 'fav_del'), 'favd:' + sidOf(tr)) : B(t(lang, 'fav_add'), 'fava:' + sidOf(tr)), URLB('🔗', tr.page_url || 'https://soundcloud.com')],
    [R(t(lang, 'back'), 'nav:back')],
  ];
  return { text: lines.join('\n'), keyboard: kb(rows), media: tr.cover ? sc.coverUrl(tr.cover) : null };
});

panel.register('lyrics', async (ctx, params, lang) => {
  const tr = params.tr || (await sc.track(params.sid));
  let lyr = null;
  try { lyr = await sh.lyrics(tr.artist, tr.title); } catch (_) {}
  const text = lyr && lyr.text ? `🎼 <b>${esc(tr.title)}</b>\n\n${esc(lyr.text).slice(0, 3800)}` : t(lang, 'no_lyrics');
  return { text, keyboard: kb([[R(t(lang, 'back'), 'nav:back')]]) };
});

panel.register('favorites', async (ctx, p, lang) => {
  const list = store.get('favorites', String(ctx.from.id)) || [];
  if (!list.length) return { text: t(lang, 'favorites_empty'), keyboard: kb([[R(t(lang, 'back'), 'nav:back')]]) };
  const rows = list.slice(-18).reverse().map((tr) => [B(vtruncate(card(tr), 42), 'trk:' + tr.sid)]);
  rows.push([R(t(lang, 'back'), 'nav:back')]);
  return { text: t(lang, 'favorites_title'), keyboard: kb(rows) };
});

panel.register('history', async (ctx, p, lang) => {
  const list = store.get('history', String(ctx.from.id)) || [];
  if (!list.length) return { text: t(lang, 'history_empty'), keyboard: kb([[R(t(lang, 'back'), 'nav:back')]]) };
  const rows = list.slice(-18).reverse().map((tr) => [B(vtruncate(card(tr), 42), 'trk:' + tr.sid)]);
  rows.push([R(t(lang, 'back'), 'nav:back')]);
  return { text: t(lang, 'history_title'), keyboard: kb(rows) };
});

panel.register('recog', async (ctx, params, lang) => {
  const d = params.data;
  const lines = [
    `🎤 <b>${esc(d.title || '?')}</b>`,
    `👤 ${esc(d.artist || '?')}`,
    d.album ? `💿 ${esc(d.album)}` : null,
    d.year ? `📅 ${iso(esc(String(d.year)))}` : null,
    d.confidence != null ? `🎯 ${num(lang, Math.round(d.confidence))}%` : null,
  ].filter(Boolean);
  const q = `${d.artist || ''} ${d.title || ''}`.trim();
  const rows = [
    [G(t(lang, 'dl'), 'rdl:' + Buffer.from(q).toString('base64url').slice(0, 44))],
    d.lyrics && d.lyrics.available ? [B(t(lang, 'lyrics'), 'rlyr')] : null,
    [R(t(lang, 'back'), 'nav:menu')],
  ].filter(Boolean);
  setPanel(ctx.chat.id, ctx.from.id, { recog: d, recogQuery: q });
  return { text: lines.join('\n'), keyboard: kb(rows), media: d.artwork };
});

panel.register('igresult', async (ctx, params, lang) => {
  const d = params.data;
  const typeMap = { image: '🖼 عکس', video: '🎬 ویدیو', carousel: '🖼🎬 کاروسل' };
  const author = (d.author && (d.author.username || d.author.full_name)) || '';
  const cap = (d.caption || '').replace(/\s+/g, ' ').slice(0, 200);
  const text = [
    `📸 <b>${typeMap[d.type] || 'اینستاگرام'}</b>`,
    author ? `👤 ${esc(author)}` : null,
    cap ? `📝 ${esc(cap)}` : null,
  ].filter(Boolean).join('\n');
  // Always offer music recognition: fingerprint the downloaded audio track.
  const q = guessMusicQuery(d);
  const hasVideo = (d.items || []).some((i) => i.type === 'video' || (i.variants || []).some((v) => (v.mime || '').startsWith('video')));
  const rows = [];
  if (hasVideo) rows.push([G('🎵 ' + t(lang, 'ig_recognize'), 'igx')]);   // fingerprint -> find song -> download
  if (q) rows.push([B('🔍 ' + t(lang, 'ig_search_sc'), 'igm:' + Buffer.from(q).toString('base64url').slice(0, 44))]);
  rows.push([R(t(lang, 'back'), 'nav:menu')]);
  // stash for the igx fingerprint flow
  setPanel(ctx.chat.id, ctx.from.id, { igData: d, igQuery: q });
  return { text, keyboard: kb(rows), media: d.thumbnail ? ig.thumbUrl(d.thumbnail) : null };
});

function guessMusicQuery(d) {
  // best-effort: artist username or first caption token(s)
  const c = (d.caption || '').split('\n')[0].trim();
  const author = (d.author && (d.author.username || d.author.full_name)) || '';
  let q = '';
  const m = c.match(/([\p{L} .'-]{3,40})\s[-–—|]\s([\p{L} .'-]{3,40})/u);
  if (m) q = `${m[1]} ${m[2]}`;
  else if (c && c.length < 60 && /[\p{L}]/u.test(c)) q = c;
  else if (author) q = author;
  return normalize(q) || '';
}

// ============ FAV/HISTORY ============
function isFav(uid, sid) { return (store.get('favorites', String(uid)) || []).some((x) => String(x.sid) === String(sid)); }
function toggleFav(uid, tr) {
  const l = store.get('favorites', String(uid)) || [];
  const sid = String(tr.sid || tr.id);
  const i = l.findIndex((x) => String(x.sid) === sid);
  if (i >= 0) l.splice(i, 1); else l.push({ sid, title: tr.title, artist: tr.artist });
  store.set('favorites', String(uid), l.slice(-100));
}
function pushHistory(uid, tr) {
  const l = store.get('history', String(uid)) || [];
  const sid = String(tr.sid || tr.id);
  const i = l.findIndex((x) => String(x.sid) === sid);
  if (i >= 0) l.splice(i, 1);
  l.push({ sid, title: tr.title, artist: tr.artist });
  store.set('history', String(uid), l.slice(-50));
}

// ============ FLOWS ============
async function doSearch(ctx, q) {
  const lang = ctx.lang;
  const w = rl.check(ctx.from.id, 'search');
  if (w) { await editOrReply(ctx, t(lang, 'rate_limited', { wait: rl.fmtWait(w, lang, t) })); return; }
  let results;
  try { const d = await sc.search(q, 1, lang); results = d.results || []; }
  catch (e) { log.warn('search fail', e.code); return editOrReply(ctx, t(lang, 'error_service')); }
  if (!results.length) {
    const al = aliasFor(q), tr = transliterate(normalize(q));
    for (const alt of [al, tr]) {
      if (alt && alt !== q) { try { const d = await sc.search(alt, 1, lang); if (d.results && d.results.length) { results = d.results; break; } } catch (_) {} }
    }
  }
  if (!results.length) { await editOrReply(ctx, t(lang, 'no_results')); return; }
  store.incrStats('search');
  await panel.show(ctx, 'results', { q, page: 1, items: results }, { push: false });
}

const globalDl = { n: 0 }; const userDl = new Map();
async function runDownload(ctx, sid) {
  const lang = ctx.lang, uid = ctx.from.id;
  const w = rl.check(uid, 'download');
  if (w) { await answer(ctx, t(lang, 'rate_limited', { wait: rl.fmtWait(w, lang, t) }), true); return; }
  if ((userDl.get(uid) || 0) >= 2 || globalDl.n >= 4) { await answer(ctx, t(lang, 'processing'), true); return; }
  globalDl.n++; userDl.set(uid, (userDl.get(uid) || 0) + 1);
  try {
    await answer(ctx, t(lang, 'downloading'));
    const tr = await sc.track(sid);
    pushHistory(uid, tr);
    store.incrStats('download');
    await downloadAndSend(ctx, tr, lang);
  } catch (e) {
    log.warn('dl fail', e.code);
    const msg = e.code === 'NOT_DOWNLOADABLE' ? t(lang, 'error_not_downloadable')
      : (e.code === 'PAYLOAD_TOO_LARGE' || e.code === 'TRACK_TOO_LONG') ? t(lang, 'error_too_large') : t(lang, 'error_generic');
    await answer(ctx, msg, true);
  } finally { globalDl.n--; userDl.set(uid, Math.max(0, (userDl.get(uid) || 1) - 1)); }
}

async function doRecognize(ctx, fileRef) {
  const lang = ctx.lang;
  const w = rl.check(ctx.from.id, 'recognize');
  if (w) { await editOrReply(ctx, t(lang, 'rate_limited', { wait: rl.fmtWait(w, lang, t) })); return; }
  const status = await editOrReply(ctx, t(lang, 'recognizing'));
  try {
    const d = await processAudio(ctx, fileRef, lang);
    if (!d || !d.found) { await editOrReply(ctx, t(lang, 'recognize_none')); return; }
    store.incrStats('rec');
    ctx.panelMsgId = status && status.message_id;
    await panel.show(ctx, 'recog', { data: d }, { push: false });
  } catch (e) {
    log.warn('recog fail', e.code);
    await editOrReply(ctx, e.code === 'UNSUPPORTED' ? t(lang, 'recognize_badformat') : t(lang, 'recognize_none'));
  }
}

// INSTAGRAM: auto-download all items + a music button card.
async function doInsta(ctx, url) {
  const lang = ctx.lang;
  let d;
  const status = await editOrReply(ctx, t(lang, 'processing'));
  try { d = await ig.resolve(url); }
  catch (e) { log.warn('insta fail', e.code); await editOrReply(ctx, t(lang, 'insta_none')); return; }

  // Prefer the primary video (reel) item; otherwise first item.
  const items = d.items || [];
  const q = guessMusicQuery(d);
  const primary = items.find((i) => i.type === 'video' && (i.variants || []).some((v) => (v.mime || '').startsWith('video') || v.has_audio)) || items.find((i) => i.type === 'video') || items[0];
  const hasVideo = items.some((i) => i.type === 'video' || (i.variants || []).some((v) => (v.mime || '').startsWith('video')));
  const control = kb([
    hasVideo ? [G('🎵 ' + t(lang, 'ig_recognize'), 'igx')] : [],
    q ? [B('🔍 ' + t(lang, 'ig_search_sc'), 'igm:' + Buffer.from(q).toString('base64url').slice(0, 44))] : [],
    [R(t(lang, 'back'), 'nav:menu')],
  ]);
  setPanel(ctx.chat.id, ctx.from.id, { igData: d, igQuery: q });

  let sent = 0;
  const { InputFile } = require('grammy');
  const path = require('node:path'), fs = require('node:fs');
  // Single media (reel/post): send the actual media with the control buttons
  // attached to THAT message — never a separate thumbnail card.
  for (const it of items.slice(0, 10)) {
    let tmp;
    try {
      const v = pickVariant(it);
      if (!v) continue;
      tmp = path.join(config.tmpDir, `ig_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
      await ig.downloadFile(d.source_url, { quality: v.quality, index: it.index }, tmp, 80 * 1024 * 1024);
      const fname = v.filename || `instagram_${it.index}`;
      const caption = it.type === 'video' ? '🎬 <b>Instagram</b>' : '🖼 <b>Instagram</b>';
      if (it.type === 'video' || (v.mime || '').startsWith('video')) {
        await ctx.api.sendVideo(ctx.chat.id, new InputFile(tmp, fname), { caption, parse_mode: 'HTML', supports_streaming: true, reply_markup: control });
      } else {
        await ctx.api.sendPhoto(ctx.chat.id, new InputFile(tmp, fname), { caption, parse_mode: 'HTML', reply_markup: control });
      }
      sent++;
    } catch (e) { log.warn('ig item', e.message); }
    finally { if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} } }
    await new Promise((r) => setTimeout(r, 250));
  }
  store.incrStats('download');
  if (status && status.message_id) { try { await ctx.api.deleteMessage(ctx.chat.id, status.message_id); } catch (_) {} }
  if (sent === 0) { await editOrReply(ctx, t(lang, 'insta_none')); return; }
}

function pickVariant(item) {
  const vs = item.variants || [];
  return vs.find((v) => v.has_audio !== false) || vs[0];
}

// search soundcloud by caption query -> send the audio
async function instaMusic(ctx, b64) {
  const lang = ctx.lang;
  const q = Buffer.from(b64, 'base64url').toString();
  await answer(ctx, t(lang, 'searching'));
  try {
    const d = await sc.search(q, 1, lang);
    const tr = d.results && d.results[0];
    if (!tr) { await ctx.reply(t(lang, 'no_results')); return; }
    await runDownload(ctx, sc.sidOf(tr));
  } catch (e) { await ctx.reply(t(lang, 'error_service')); }
}

// Recognize the song inside an instagram video: download -> decode -> fingerprint -> shazam -> download from soundcloud.
async function instaRecognize(ctx) {
  const lang = ctx.lang, uid = ctx.from.id;
  const p = getPanel(ctx.chat.id, uid);
  const d = p && p.igData;
  await answer(ctx, t(lang, 'recognizing'));
  if (!d) { await ctx.reply(t(lang, 'error_generic')); return; }
  const w = rl.check(uid, 'recognize');
  if (w) { await ctx.reply(t(lang, 'rate_limited', { wait: rl.fmtWait(w, lang, t) })); return; }
  const item = (d.items || []).find((i) => i.type === 'video' || (i.variants || []).some((v) => (v.mime || '').startsWith('video')));
  if (!item) { await ctx.reply(t(lang, 'recognize_none')); return; }
  const path = require('node:path'), fs = require('node:fs');
  const tmp = path.join(config.tmpDir, `igv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  try {
    const v = pickVariant(item);
    await ig.downloadFile(d.source_url, { quality: v && v.quality, index: item.index }, tmp, 80 * 1024 * 1024);
    const { decodeWithFfmpeg } = require('./audio');
    const pcm = await decodeWithFfmpeg(fs.readFileSync(tmp), 'mp4');
    const rec = await sh.recognizeBySignature(pcm, { lyrics: true });
    if (!rec || !rec.found) { await ctx.reply(t(lang, 'recognize_none')); return; }
    store.incrStats('rec');
    ctx.panelMsgId = ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.message_id;
    await panel.show(ctx, 'recog', { data: rec }, { push: false });
  } catch (e) {
    log.warn('ig recognize fail', e.code || e.message);
    await ctx.reply(t(lang, 'recognize_none'));
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

async function recogDownload(ctx, b64) {
  const lang = ctx.lang;
  const q = Buffer.from(b64, 'base64url').toString();
  await answer(ctx, t(lang, 'searching'));
  try {
    const d = await sc.search(q, 1, lang);
    const tr = d.results && d.results[0];
    if (!tr) { await ctx.reply(t(lang, 'no_results')); return; }
    await runDownload(ctx, sc.sidOf(tr));
  } catch (e) { await ctx.reply(t(lang, 'error_service')); }
}

// awaiting-text state (support tickets, admin inputs)
const awaiting = new Map();
function setAwait(uid, a) { awaiting.set(uid, { ...a, at: Date.now() }); }
function getAwait(uid) { const a = awaiting.get(uid); if (a && Date.now() - a.at > 300000) { awaiting.delete(uid); return null; } return a; }
function clearAwait(uid) { awaiting.delete(uid); }

// text search (find a song by lyrics/title/artist via the shazam text endpoint)
async function doTextSearch(ctx, q) {
  const lang = ctx.lang;
  try {
    const d = await sh.searchText(q, 4, true);
    if (d && (d.found || (d.results && d.results.length))) {
      const card = d.artist ? d : (d.results && d.results[0] && { artist: d.results[0].artist, title: d.results[0].title });
      // prefer the SoundCloud match for download
      try { const s = await sc.search(`${card.artist} ${card.title}`, 1, lang); const tr = s.results && s.results[0]; if (tr) { await panel.show(ctx, 'track', { sid: sc.sidOf(tr) }, { push: false }); return; } } catch (_) {}
    }
  } catch (_) {}
  // fall back to soundcloud search
  return doSearch(ctx, q);
}

// show lyrics for a recognized/song match
async function doLyrics(ctx, q) {
  const lang = ctx.lang;
  try {
    const d = await sh.searchText(q, 3, true);
    if (d && d.lyrics && d.lyrics.available && d.lyrics.text) {
      const title = d.title || (d.results && d.results[0] && d.results[0].title) || q;
      await ctx.reply(`🎼 <b>${esc(title)}</b>\n\n${esc(d.lyrics.text).slice(0, 3800)}`, { parse_mode: 'HTML' });
      return;
    }
    // try lyrics endpoint with top result
    const top = d.results && d.results[0];
    if (top) {
      const lyr = await sh.lyrics(top.artist, top.title);
      if (lyr && lyr.text) { await ctx.reply(`🎼 <b>${esc(top.title)}</b>\n\n${esc(lyr.text).slice(0, 3800)}`, { parse_mode: 'HTML' }); return; }
    }
  } catch (_) {}
  await ctx.reply(t(lang, 'no_lyrics'));
}

module.exports = { panel, doSearch, doRecognize, doInsta, instaMusic, instaRecognize, recogDownload, doTextSearch, doLyrics, runDownload, toggleFav, isFav, pushHistory, fmtDur, editOrReply, answer, setAwait, getAwait, clearAwait };
