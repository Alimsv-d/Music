'use strict';
const { Bot, webhookCallback, InputFile } = require('grammy');
const http = require('node:http');
const config = require('./config');
const log = require('./core/log');
const rl = require('./core/ratelimit');
const { store, i18n, userLang, setUserLang, setChatLang, chatSettings, setChatSettings, trackUser, isOwner, getPanel, setPanel } = require('./core/context');
const { t, esc, iso } = i18n;
const { kb, G, B, R, URLB } = require('./bot/keyboard');
const panel = require('./bot/panel');
const H = require('./bot/handlers');
const channel = require('./bot/channel');
require('./bot/admin');
const sc = require('./services/soundcloud');
const ig = require('./services/instagram');
const { normalize, isSoundCloudUrl, similarity } = require('./services/query');
const { downloadFile } = require('./bot/send');

const bot = new Bot(config.botToken);

// ---------- context middleware: lang, user tracking, force-join ----------
bot.use(async (ctx, next) => {
  if (ctx.from) trackUser(ctx.from, ctx.chat);
  ctx.lang = ctx.from ? userLang(ctx.from.id, ctx.chat) : 'fa';
  // maintenance
  const s = store.get('settings', 'global') || {};
  if (s.maintenance && !isOwner(ctx.from && ctx.from.id)) {
    if (ctx.message) await ctx.reply(t(ctx.lang, 'maintenance'));
    return;
  }
  return next();
});

// force-join check (multi-channel). Returns true if member of ALL required channels.
async function checkForceJoin(ctx) {
  const s = store.get('settings', 'global') || {};
  const fj = Array.isArray(s.forcejoin) ? s.forcejoin : (s.forcejoin ? [s.forcejoin] : []);
  if (!fj.length || isOwner(ctx.from.id)) return true;
  const missing = [];
  for (const ch of fj) {
    try {
      const m = await ctx.api.getChatMember(ch, ctx.from.id);
      if (!['member', 'administrator', 'creator'].includes(m.status)) missing.push(ch);
    } catch (_) { missing.push(ch); }
  }
  if (!missing.length) return true;
  const rows = missing.map((c) => [URLB(t(ctx.lang, 'btn_join'), `https://t.me/${String(c).replace('@', '')}`)]);
  rows.push([G(t(ctx.lang, 'btn_check'), 'fj:check')]);
  await ctx.reply(t(ctx.lang, 'forcejoin_msg'), { reply_markup: kb(rows) });
  return false;
}

// ---------- /start ----------
bot.command('start', async (ctx) => {
  const arg = (ctx.match || '').trim();
  if (ctx.chat.type !== 'private') return;
  if (!(await checkForceJoin(ctx))) return;
  if (arg.startsWith('t_')) {
    const sid = arg.slice(2);
    await panel.show(ctx, 'track', { sid }).catch(() => panel.show(ctx, 'menu'));
    return;
  }
  if (arg.startsWith('s_')) {
    await H.doSearch(ctx, decodeURIComponent(arg.slice(2)));
    return;
  }
  await panel.show(ctx, 'menu', {}, { push: false });
});

bot.command(['music', 'search', 'song'], async (ctx) => {
  const q = (ctx.match || '').trim();
  if (!q) { await panel.show(ctx, 'menu', {}, { push: false }); return; }
  await H.doSearch(ctx, q);
});
bot.command('lyrics', async (ctx) => {
  const q = (ctx.match || '').trim();
  if (q) return H.doLyrics(ctx, q);
  // reply to a track/audio message -> lyrics of it
  const rep = ctx.message.reply_to_message;
  if (rep && (rep.audio || rep.voice)) {
    const t2 = rep.audio && `${rep.audio.performer || ''} ${rep.audio.title || ''}`.trim();
    if (t2) return H.doLyrics(ctx, t2);
  }
});
bot.command('recognize', async (ctx) => {
  const rep = ctx.message.reply_to_message;
  const target = rep || ctx.message;
  const fr = extractFileRef(target);
  if (fr) await H.doRecognize(ctx, fr);
  else await ctx.reply(t(ctx.lang, 'ask_voice'));
});
bot.command('help', async (ctx) => panel.show(ctx, 'help', {}, { push: false }));
bot.command('settings', async (ctx) => {
  if (ctx.chat.type === 'private') return;
  if (!(await isGroupAdmin(ctx))) return;
  await showGroupSettings(ctx);
});

// ---------- group settings ----------
async function isGroupAdmin(ctx) {
  if (isOwner(ctx.from.id)) return true;
  try {
    const m = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    return ['administrator', 'creator'].includes(m.status);
  } catch (_) { return false; }
}
async function showGroupSettings(ctx) {
  const lang = ctx.lang;
  const s = chatSettings(ctx.chat.id);
  const onoff = (v) => v ? t(lang, 'on') : t(lang, 'off');
  const rows = [
    [B(t(lang, 'gset_smart', { v: onoff(s.smart !== false) }), 'gs:smart')],
    [B(t(lang, 'gset_autodel', { v: s.autodel ? t(lang, 'minutes_n', { n: s.autodel }) : t(lang, 'disabled') }), 'gs:autodel')],
    [B(t(lang, 'gset_lang'), 'gs:lang')],
    [R(t(lang, 'close'), 'nav:close')],
  ];
  await ctx.reply(t(lang, 'group_settings'), { reply_markup: kb(rows) });
}

// ---------- file extraction ----------
function extractFileRef(msg) {
  if (!msg) return null;
  if (msg.voice) return { file_id: msg.voice.file_id, mime: msg.voice.mime_type, kind: 'voice' };
  if (msg.audio) return { file_id: msg.audio.file_id, mime: msg.audio.mime_type, kind: 'audio' };
  if (msg.video) return { file_id: msg.video.file_id, mime: msg.video.mime_type, kind: 'video' };
  if (msg.video_note) return { file_id: msg.video_note.file_id, mime: 'video/mp4', kind: 'video' };
  if (msg.document && /audio|video|ogg|mp4|mpeg/.test(msg.document.mime_type || '')) return { file_id: msg.document.file_id, mime: msg.document.mime_type, kind: 'doc' };
  return null;
}

// ---------- text messages (private) ----------
const TRIGGERS = ['آهنگ', 'موزیک', 'پخش', 'متن آهنگ', 'ترانه', 'music', 'song', 'play', 'lyrics', 'track', 'песня', 'музыка', '播放', 'أغنية', 'اغنية', 'لحن', 'canción', 'musica', 'musique', 'lied', 'şarkı', 'mahnı', 'اهنگ'];

bot.on('message', async (ctx) => {
  const msg = ctx.message;
  if (msg.from && msg.from.is_bot) return;
  if (msg.via_bot || (msg.forward_origin && ctx.chat.type !== 'private')) return; // ignore bot-forwarded spam

  const uid = ctx.from && ctx.from.id;
  const lang = ctx.lang;

  // voice/audio/video -> recognize (private: always; group: only via reply/command handled elsewhere)
  const fr = extractFileRef(msg);
  const aw0 = H.getAwait(uid);
  if (fr && ctx.chat.type === 'private' && (!aw0 || aw0.type === 'recog')) {
    H.clearAwait(uid);
    return H.doRecognize(ctx, fr);
  }
  // group: recognize on reply-to-bot media
  if (fr && ctx.chat.type !== 'private' && msg.reply_to_message && (await isReplyToBot(ctx, msg))) {
    if (rl.groupLimit(ctx.chat.id)) return;
    return H.doRecognize(ctx, fr);
  }

  const text = (msg.text || msg.caption || '').trim();

  // awaiting state (search query, insta link, ticket, admin inputs)
  const aw = H.getAwait(uid);
  if (aw && ctx.chat.type === 'private') {
    H.clearAwait(uid);
    return handleAwait(ctx, aw, msg, text);
  }

  if (!text) return;

  // INSTAGRAM link
  if (ig.isInstaUrl(text)) {
    if (ctx.chat.type === 'private' || (await isReplyToBot(ctx, msg))) return H.doInsta(ctx, text);
    return;
  }
  // SOUNDCLOUD link
  if (isSoundCloudUrl(text)) {
    if (ctx.chat.type === 'private' || (await isReplyToBot(ctx, msg))) {
      try {
        const tr = await sc.resolveUrl(text);
        return panel.show(ctx, 'track', { sid: sc.sidOf(tr) });
      } catch (_) { return ctx.reply(t(lang, 'error_generic')); }
    }
    return;
  }

  if (ctx.chat.type === 'private') {
    // plain text -> treat as search
    if (!(await checkForceJoin(ctx))) return;
    return H.doSearch(ctx, text);
  }

  // ---- GROUP logic ----
  if (rl.isBanned(uid)) return;
  const gs = chatSettings(ctx.chat.id);

  // reply to bot -> search
  if (await isReplyToBot(ctx, msg)) {
    if (rl.groupLimit(ctx.chat.id)) return;
    return H.doSearch(ctx, text);
  }
  // mention
  if (text.toLowerCase().includes('@' + config.botUsername.toLowerCase())) {
    const q = text.replace(new RegExp('@' + config.botUsername, 'gi'), '').trim();
    if (q) { if (rl.groupLimit(ctx.chat.id)) return; return H.doSearch(ctx, q); }
    return;
  }
  // trigger word first + name
  const first = text.split(/\s+/)[0].toLowerCase();
  if (TRIGGERS.includes(first) && text.split(/\s+/).length > 1) {
    const q = text.slice(first.length).trim();
    if (q) { if (rl.groupLimit(ctx.chat.id)) return; return H.doSearch(ctx, q); }
    return;
  }
  // smart detect
  if (gs.smart !== false && text.length < 80) {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= 6 && words.length >= 1 && !/[@#\/]/.test(text) && !containsLink(msg)) {
      return smartDetect(ctx, text);
    }
  }
});

function containsLink(msg) {
  const text = msg.text || msg.caption || '';
  if (/https?:\/\//i.test(text)) return true;
  if (msg.entities && msg.entities.some((e) => e.type === 'url' || e.type === 'text_link')) return true;
  if (msg.caption_entities && msg.caption_entities.some((e) => e.type === 'url' || e.type === 'text_link')) return true;
  return false;
}

const smartCd = new Map();
async function smartDetect(ctx, text) {
  const cid = ctx.chat.id;
  const last = smartCd.get(cid) || 0;
  if (Date.now() - last < 20000) return; // group cooldown
  const key = 'neg:' + normalize(text);
  if (store.get('negcache', key)) return;
  try {
    const d = await sc.search(text, 1, ctx.lang);
    const top = d.results && d.results[0];
    if (!top) { store.set('negcache', key, 1); return; }
    const sim = Math.max(similarity(text, top.title), similarity(text, `${top.artist} ${top.title}`), similarity(text, top.artist));
    if (sim < 0.5) { store.set('negcache', key, 1); return; }
    smartCd.set(cid, Date.now());
    if (rl.groupLimit(cid)) return;
    // send a compact card with a download button; audio goes to the chat directly
    const sid = sc.sidOf(top);
    await ctx.reply(`🎵 <b>${esc(top.artist)} — ${esc(top.title)}</b>\n⏱ ${esc(top.duration || '')}`, {
      parse_mode: 'HTML',
      reply_markup: kb([[G(t(ctx.lang, 'dl'), 'dl:' + sid)]]),
    });
    store.incrStats('search');
  } catch (_) {}
}

async function isReplyToBot(ctx, msg) {
  const rep = msg.reply_to_message;
  if (!rep || !rep.from) return false;
  const me = await bot.api.getMe().catch(() => null);
  return me ? rep.from.id === me.id : false;
}

// ---------- awaiting handler ----------
async function handleAwait(ctx, aw, msg, text) {
  const uid = ctx.from.id, lang = ctx.lang;
  switch (aw.type) {
    case 'search': return H.doSearch(ctx, text);
    case 'insta': return ig.isInstaUrl(text) ? H.doInsta(ctx, text) : ctx.reply(t(lang, 'insta_none'));
    case 'ticket': {
      const n = (store.get('stats', 'ticket_n') || 0) + 1;
      store.set('stats', 'ticket_n', n);
      store.set('tickets', String(n), { uid, name: ctx.from.first_name, text, open: true, at: Date.now() });
      await ctx.api.sendMessage(config.ownerId, t(lang, 'support_owner_new', { n, name: esc(ctx.from.first_name || ''), id: uid, text: esc(text) }), {
        parse_mode: 'HTML', reply_markup: kb([[G(t(lang, 'btn_reply'), `tk:r:${n}`)]]),
      });
      return ctx.reply(t(lang, 'support_sent', { n }));
    }
    case 'addchannel': {
      let chId = text.trim();
      if (msg.forward_from_chat) chId = String(msg.forward_from_chat.id);
      if (!/^-?\d+$|^@/.test(chId)) return ctx.reply(t(lang, 'error_generic'));
      const list = channel.channels();
      list.push({ id: chId, title: chId, auto: true, lang: 'fa', signature: '' });
      channel.saveChannels(list);
      const st = await channel.channelStatus(ctx.api, { id: chId });
      await ctx.reply(st.ok ? t(lang, 'channel_status_ok') : t(lang, 'channel_status_bad', { reason: esc(st.reason || '') }));
      return panel.show(ctx, 'admin_channels', {}, { push: false });
    }
    case 'ban': {
      const target = String(text).replace(/\D/g, '');
      if (!target) return ctx.reply(t(lang, 'error_generic'));
      if (store.get('bans', target)) { store.del('bans', target); } else { store.set('bans', target, { at: Date.now(), by: uid }); }
      await ctx.reply(t(lang, 'ban_done'));
      return panel.show(ctx, 'admin_bans', {}, { push: false });
    }
    case 'broadcast': {
      const users = store.keys('users');
      await ctx.reply(t(lang, 'broadcast_started', { n: users.length }));
      broadcast(ctx, text, users);
      return;
    }
    case 'forceedit': {
      const s = store.get('settings', 'global') || {};
      const fj = Array.isArray(s.forcejoin) ? s.forcejoin : (s.forcejoin ? [s.forcejoin] : []);
      const ch = text.trim();
      if ((ch.startsWith('@') || /^-?\d+$/.test(ch)) && !fj.includes(ch)) fj.push(ch);
      s.forcejoin = fj;
      store.set('settings', 'global', s);
      await ctx.reply(t(lang, 'ban_done'));
      return panel.show(ctx, 'admin_fj', {}, { push: false });
    }
    case 'posttext': {
      // edit pending post caption then publish
      const pp = store.get('settings', 'pending_posts') || {};
      const item = pp[aw.sid];
      if (item) { item.tr.customCaption = text; store.set('settings', 'pending_posts', pp); }
      return ctx.reply('✅');
    }
    case 'scfollow': {
      const fl = channel.follows();
      fl.push({ term: text.trim(), at: Date.now() });
      channel.saveFollows(fl);
      return ctx.reply('✅ ' + esc(text));
    }
  }
}

async function broadcast(ctx, text, users) {
  let ok = 0, fail = 0;
  for (const u of users) {
    try { await ctx.api.sendMessage(u, text, { parse_mode: 'HTML' }); ok++; }
    catch (_) { fail++; }
    await new Promise((r) => setTimeout(r, 40));
  }
  await ctx.api.sendMessage(config.ownerId, t(ctx.lang, 'broadcast_done', { ok, fail }));
}

// ---------- callbacks ----------
bot.on('callback_query', async (ctx) => {
  const cq = ctx.callbackQuery;
  const data = cq.data || '';
  const uid = cq.from.id;
  const lang = ctx.lang = userLang(uid, ctx.chat);
  const answer = (tx, alert) => ctx.answerCallbackQuery({ text: tx, show_alert: !!alert }).catch(() => {});

  // admin guard for a: and ach/atk/cp management
  const isAdminCb = /^(a:|ach|atk|aset|aub|cp:|bc|gs:)/.test(data);
  if (isAdminCb && !isOwner(uid) && !data.startsWith('gs:')) { return answer(t(lang, 'admin_only'), true); }

  try {
    if (data === 'noop') return answer();
    if (data === 'nav:back') { await answer(); return panel.back(ctx); }
    if (data === 'nav:menu') { await answer(); return panel.show(ctx, 'menu', {}, { push: false }); }
    if (data === 'nav:close') { await answer(); try { await ctx.deleteMessage(); } catch (_) {} return; }
    if (data === 'fj:check') {
      const ok = await checkForceJoin(ctx);
      if (ok) { await answer('✅'); return panel.show(ctx, 'menu', {}, { push: false }); }
      return answer(t(lang, 'not_member'), true);
    }
    if (data.startsWith('m:')) {
      await answer();
      const m = data.slice(2);
      if (m === 'new') return showNew(ctx);
      if (m === 'fav') return panel.show(ctx, 'favorites');
      if (m === 'hist') return panel.show(ctx, 'history');
      if (m === 'lang') return panel.show(ctx, 'lang');
      if (m === 'support') { H.setAwait(uid, { type: 'ticket' }); return editPanel(ctx, t(lang, 'support_ask'), [[R(t(lang, 'back'), 'nav:menu')]]); }
      if (m === 'help') return panel.show(ctx, 'help');
      if (m === 'admin') return panel.show(ctx, 'admin');
    }
    if (data.startsWith('lang:')) {
      const c = data.slice(5);
      setUserLang(uid, c);
      if (ctx.chat.type !== 'private') setChatLang(ctx.chat.id, c);
      await answer(t(c, 'lang_set', { lang: c }));
      ctx.lang = c;
      return panel.show(ctx, 'menu', {}, { push: false });
    }
    if (data.startsWith('pg:')) {
      const st = panel.stateFor(ctx.chat.id, cq.message.message_id);
      const page = Number(data.slice(3));
      await answer();
      const cur = st && st.current;
      if (cur && cur.name === 'results' && cur.params.items) return panel.show(ctx, 'results', { ...cur.params, page }, { push: false });
      return;
    }
    if (data.startsWith('pick:')) return H.runDownload(ctx, data.slice(5));
    if (data.startsWith('trk:')) { await answer(); return panel.show(ctx, 'track', { sid: data.slice(4) }); }
    if (data.startsWith('dl:')) { return H.runDownload(ctx, data.slice(3)); }
    if (data.startsWith('lyr:')) { await answer(); return panel.show(ctx, 'lyrics', { sid: data.slice(4) }); }
    if (data.startsWith('sim:')) {
      await answer(t(lang, 'searching'));
      const tr = await sc.track(data.slice(4));
      return H.doSearch(ctx, `${tr.artist} ${tr.title}`.split(' ').slice(0, 3).join(' '));
    }
    if (data.startsWith('fava:')) { const tr = await sc.track(data.slice(5)); H.toggleFav(uid, { ...tr, sid: data.slice(5) }); await answer('⭐'); return panel.show(ctx, 'track', { sid: data.slice(5) }, { push: false }); }
    if (data.startsWith('favd:')) { const tr = await sc.track(data.slice(5)); H.toggleFav(uid, { ...tr, sid: data.slice(5) }); await answer('✓'); return panel.show(ctx, 'track', { sid: data.slice(5) }, { push: false }); }
    if (data === 'rlyr') {
      const p = getPanel(ctx.chat.id, uid);
      const d = p && p.recog;
      await answer();
      if (d && d.lyrics && d.lyrics.text) return editPanel(ctx, `🎼 <b>${esc(d.title)}</b>\n\n${esc(d.lyrics.text).slice(0, 3800)}`, [[R(t(lang, 'back'), 'nav:menu')]]);
      return;
    }
    if (data.startsWith('rdl:')) return H.recogDownload(ctx, data.slice(4));
    if (data.startsWith('igm:')) return H.instaMusic(ctx, data.slice(4));
    if (data === 'igx') return H.instaRecognize(ctx);
    // ----- admin -----
    if (data === 'a:panel') { await answer(); return panel.show(ctx, 'admin'); }
    if (data === 'a:stats') { await answer(); return panel.show(ctx, 'admin_stats'); }
    if (data === 'a:health') { await answer(); return panel.show(ctx, 'admin_health'); }
    if (data === 'a:chans') { await answer(); return panel.show(ctx, 'admin_channels'); }
    if (data === 'a:bans') { await answer(); return panel.show(ctx, 'admin_bans'); }
    if (data === 'a:set') { await answer(); return panel.show(ctx, 'admin_settings'); }
    if (data === 'a:langs') { await answer(); return panel.show(ctx, 'admin_langs'); }
    if (data === 'a:tickets') { await answer(); return panel.show(ctx, 'admin_tickets'); }
    if (data === 'a:bc') { await answer(); H.setAwait(uid, { type: 'broadcast' }); return editPanel(ctx, t(lang, 'broadcast_ask'), [[R(t(lang, 'cancel'), 'a:panel')]]); }
    if (data === 'a:banask') { await answer(); H.setAwait(uid, { type: 'ban' }); return editPanel(ctx, t(lang, 'ban_ask'), [[R(t(lang, 'cancel'), 'a:bans')]]); }
    if (data === 'ach:add') { await answer(); H.setAwait(uid, { type: 'addchannel' }); return editPanel(ctx, t(lang, 'channel_add_ask'), [[R(t(lang, 'cancel'), 'a:chans')]]); }
    if (data.startsWith('achd:')) {
      const id = data.slice(5);
      channel.saveChannels(channel.channels().filter((c) => String(c.id) !== id));
      await answer('🗑'); return panel.show(ctx, 'admin_channels', {}, { push: false });
    }
    if (data.startsWith('aub:')) {
      const k = data.slice(4); store.del('bans', k); await answer('✓');
      return panel.show(ctx, 'admin_bans', {}, { push: false });
    }
    if (data === 'a:fjlist') { await answer(); return panel.show(ctx, 'admin_fj'); }
    if (data === 'a:fjadd') { await answer(); H.setAwait(uid, { type: 'forceedit' }); return editPanel(ctx, '🔒 @username یا آیدی کانال را بفرست:', [[R(t(lang, 'cancel'), 'a:fjlist')]]); }
    if (data.startsWith('fjdel:')) {
      const i = Number(data.slice(6));
      const s = store.get('settings', 'global') || {};
      const fj = Array.isArray(s.forcejoin) ? s.forcejoin : (s.forcejoin ? [s.forcejoin] : []);
      fj.splice(i, 1); s.forcejoin = fj; store.set('settings', 'global', s);
      await answer('🗑'); return panel.show(ctx, 'admin_fj', {}, { push: false });
    }
    if (data.startsWith('aset:')) {
      const key = data.slice(5);
      const s = store.get('settings', 'global') || {};
      if (key === 'antispam') s.antispam = !(s.antispam !== false);
      if (key === 'maintenance') s.maintenance = !s.maintenance;
      store.set('settings', 'global', s);
      await answer('✓'); return panel.show(ctx, 'admin_settings', {}, { push: false });
    }
    if (data.startsWith('atk:')) {
      const tk = store.get('tickets', data.slice(4));
      if (tk) { H.setAwait(uid, { type: 'posttext', ticket: data.slice(4) }); }
      await answer(); return;
    }
    if (data.startsWith('tk:r:')) {
      const n = data.slice(5);
      const tk = store.get('tickets', n);
      if (tk) { H.setAwait(uid, { type: 'posttext', ticket: n }); await answer(); return ctx.reply('✏️ reply to ticket #' + n); }
      return answer();
    }
    // group settings
    if (data.startsWith('gs:')) {
      if (!(await isGroupAdmin(ctx))) return answer(t(lang, 'admin_only'), true);
      const key = data.slice(3);
      const s = chatSettings(ctx.chat.id);
      if (key === 'smart') s.smart = !(s.smart !== false);
      if (key === 'autodel') s.autodel = s.autodel ? 0 : 5;
      if (key === 'lang') { return panel.show(ctx, 'lang'); }
      setChatSettings(ctx.chat.id, s);
      await answer('✓');
      return showGroupSettingsEdit(ctx, s);
    }
    // channel post actions
    if (data.startsWith('cp:')) {
      const [, act, sid] = data.split(':');
      const pp = store.get('settings', 'pending_posts') || {};
      const item = pp[sid];
      if (!item) return answer('expired', true);
      if (act === 'pub') {
        await answer(t(lang, 'post_published'));
        const q = channel.queueList(); q.push({ tr: item.tr, at: Date.now() }); channel.saveQueue(q);
        delete pp[sid]; store.set('settings', 'pending_posts', pp);
        return;
      }
      if (act === 'rej') { delete pp[sid]; store.set('settings', 'pending_posts', pp); await answer(t(lang, 'post_rejected')); try { await ctx.deleteMessage(); } catch (_) {} return; }
      if (act === 'edit') { H.setAwait(uid, { type: 'posttext', sid }); await answer(); return ctx.reply('✏️'); }
      if (act === 'sch') { const q = channel.queueList(); q.push({ tr: item.tr, at: Date.now() + 3600000 }); channel.saveQueue(q); delete pp[sid]; store.set('settings', 'pending_posts', pp); await answer('🕒'); return; }
    }
    await answer();
  } catch (e) {
    log.error('cb error', e.message);
    await answer(t(lang, 'error_generic'), true).catch(() => {});
  }
});

async function editPanel(ctx, text, rows) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb(rows), disable_web_page_preview: true });
  } catch (_) { await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb(rows) }); }
}
async function showGroupSettingsEdit(ctx, s) {
  const lang = ctx.lang;
  const onoff = (v) => v ? t(lang, 'on') : t(lang, 'off');
  const rows = [
    [B(t(lang, 'gset_smart', { v: onoff(s.smart !== false) }), 'gs:smart')],
    [B(t(lang, 'gset_autodel', { v: s.autodel ? t(lang, 'minutes_n', { n: s.autodel }) : t(lang, 'disabled') }), 'gs:autodel')],
    [B(t(lang, 'gset_lang'), 'gs:lang')],
    [R(t(lang, 'close'), 'nav:close')],
  ];
  await editPanel(ctx, t(lang, 'group_settings'), rows);
}

async function showNew(ctx) {
  try {
    const d = await sc.search('new music 2026', 1, ctx.lang);
    const items = (d.results || []).slice(0, 16);
    await panel.show(ctx, 'results', { q: t(ctx.lang, 'new_title'), page: 1, items }, { push: false });
  } catch (_) { await ctx.reply(t(ctx.lang, 'error_service')); }
}

// ---------- inline mode ----------
bot.on('inline_query', async (ctx) => {
  const q = (ctx.inlineQuery.query || '').trim();
  if (q.length < 2) return ctx.answerInlineQuery([], { cache_time: 60 });
  try {
    const d = await sc.search(q, 1, ctx.lang);
    const results = (d.results || []).slice(0, 10).map((tr, i) => {
      const sid = sc.sidOf(tr);
      return {
        type: 'article', id: 'sc' + sid + '_' + i,
        title: `${tr.artist} — ${tr.title}`,
        description: `${tr.duration || ''} · ${tr.genre || ''}`,
        input_message_content: { message_text: `🎵 ${tr.artist} — ${tr.title}\nhttps://t.me/${config.botUsername}?start=t_${sid}` },
        reply_markup: kb([[URLB(t(ctx.lang, 'inline_open'), `https://t.me/${config.botUsername}?start=t_${sid}`)]]),
        thumb_url: tr.cover,
      };
    });
    await ctx.answerInlineQuery(results, { cache_time: 120 });
  } catch (_) { await ctx.answerInlineQuery([], { cache_time: 10 }); }
});

// ---------- error ----------
bot.catch((err) => log.error('bot error', err.message));

// ---------- HTTP server (webhook + health + cron) ----------
function makeServer() {
  const queues = new Map();
  let active = 0;
  const MAX_ACTIVE = 32;
  const MAX_BODY = 1024 * 1024;
  function enqueue(update) {
    const chatId = String(update.message && update.message.chat && update.message.chat.id
      || update.callback_query && update.callback_query.message && update.callback_query.message.chat && update.callback_query.message.chat.id
      || update.inline_query && update.inline_query.from && update.inline_query.from.id
      || update.from && update.from.id || 'global');
    const prev = queues.get(chatId) || Promise.resolve();
    const job = prev.catch(() => {}).then(async () => {
      while (active >= MAX_ACTIVE) await new Promise((r) => setTimeout(r, 10));
      active++;
      try { log.debug('handleUpdate ' + update.update_id); await bot.handleUpdate(update); log.debug('done ' + update.update_id); }
      catch (e) { log.error('update processing failed', e.message); }
      finally { active--; }
    });
    queues.set(chatId, job);
    job.finally(() => { if (queues.get(chatId) === job) queues.delete(chatId); });
  }
  return http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && url === '/health') return reply(200, { ok: true, uptime: process.uptime(), rss: process.memoryUsage().rss });
    if (req.method === 'GET' && url === '/cron/' + config.cronSecret) {
      reply(200, { ok: true });
      setImmediate(() => channel.cronTick(bot.api).catch((e) => log.error('cron', e.message)));
      return;
    }
    if (req.method !== 'POST' || url !== config.webhookPath) return reply(404, { ok: false });
    if (req.headers['x-telegram-bot-api-secret-token'] !== config.webhookSecret) return reply(403, { ok: false });
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reply(413, { ok: false });
      let update;
      try { update = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (_) { return reply(400, { ok: false }); }
      reply(200, { ok: true });
      setImmediate(() => enqueue(update));
    });
    req.on('error', () => { if (!res.headersSent) reply(400, { ok: false }); });
  });
}

async function main() {
  const polling = process.argv.includes('--polling') || !config.publicUrl;
  log.info('Music bot starting', { polling, worker: config.isWorker });
  if (polling) {
    await bot.api.deleteWebhook({});
    bot.start({ drop_pending_updates: true });
    log.info('polling started');
  } else {
    await bot.init(); // populate botInfo so handleUpdate works without polling
    const port = config.port || process.env.PORT || 0;
    const server = makeServer();
    server.listen(port, () => log.info('http listening', { port: server.address().port }));
    config._server = server;
    // In-app periodic tasks as a fallback for environments where the OS cron
    // cannot be installed (also invoked externally via /cron/<secret>).
    const tick = () => channel.cronTick(bot.api).catch((e) => log.error('cron tick', e.message));
    config._cronTimer = setInterval(tick, 5 * 60 * 1000);
    config._cronTimer.unref && config._cronTimer.unref();
    setTimeout(tick, 30000).unref && setTimeout(tick, 30000).unref();
  }
  // graceful shutdown
  const stop = async (sig) => {
    log.info('shutdown ' + sig);
    try { await bot.stop(); } catch (_) {}
    try { config._cronTimer && clearInterval(config._cronTimer); } catch (_) {}
    try { config._server && config._server.close(); } catch (_) {}
    try { store.close(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (require.main === module) {
  main().catch((e) => { log.error('fatal', e.message); process.exit(1); });
}
module.exports = { bot, makeServer, main };
