'use strict';
const { Bot, webhookCallback, InputFile } = require('grammy');
const http = require('node:http');
const fs = require('node:fs');
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
const sh = require('./services/shazam');
const ig = require('./services/instagram');
const { normalize, isSoundCloudUrl, similarity } = require('./services/query');
const { downloadFile } = require('./bot/send');
const mediaCache = require('./services/mediaCache');
const { cleanTrackMeta } = require('./services/trackMeta');

const bot = new Bot(config.botToken);
const memberCache = new Map();
const invalidGateAlertAt = new Map();
const groupNoticeAt = new Map();
let lastUpdateSeen = { at: 0, update_id: null, kind: 'none', chat_id: null };
let lastDrop = { at: 0, code: 'none', update_id: null };

function dropUpdate(ctx, code) {
  lastDrop = { at: Date.now(), code, update_id: ctx.update && ctx.update.update_id };
  log.info('update_dropped', { code, update_id: lastDrop.update_id, chat_id: ctx.chat && String(ctx.chat.id) });
}

// Retry exactly once only for Telegram's explicit bad-request style rejection.
bot.api.config.use((prev, method, payload, signal) => prev(method, payload, signal).catch(async (error) => {
  const description = String(error && error.description || '');
  if (!/\bstyle\b/i.test(description) || !/bad request/i.test(description)) throw error;
  const retry = structuredClone(payload);
  let removed = false;
  const strip = (markup) => {
    for (const row of (markup && markup.inline_keyboard) || []) for (const button of row) {
      if (Object.prototype.hasOwnProperty.call(button, 'style')) { delete button.style; removed = true; }
    }
  };
  strip(retry.reply_markup);
  if (!removed) throw error;
  log.warn('Telegram rejected button style; retrying once without style');
  return prev(method, retry, signal);
}));

// ---------- context middleware: lang, user tracking, force-join ----------
bot.use(async (ctx, next) => {
  lastUpdateSeen = { at: Date.now(), update_id: ctx.update && ctx.update.update_id, kind: Object.keys(ctx.update || {}).find((k) => k !== 'update_id') || 'unknown', chat_id: ctx.chat && String(ctx.chat.id) };
  if (ctx.from) trackUser(ctx.from, ctx.chat);
  ctx.lang = ctx.from ? userLang(ctx.from.id, ctx.chat) : 'fa';
  // maintenance
  const s = store.get('settings', 'global') || {};
  if (s.maintenance && !isOwner(ctx.from && ctx.from.id)) {
    if (ctx.message) await ctx.reply(t(ctx.lang, 'maintenance'));
    dropUpdate(ctx, 'maintenance');
    return;
  }
  const membershipUpdate = !!(ctx.update && (ctx.update.chat_member || ctx.update.my_chat_member));
  if (ctx.from && ctx.chat && ctx.chat.type !== 'channel' && !membershipUpdate && !(ctx.callbackQuery && ctx.callbackQuery.data === 'fj:check') && !(await checkForceJoin(ctx))) {
    dropUpdate(ctx, 'forcejoin');
    return;
  }
  return next();
});

function featureOn(name) {
  const s = store.get('settings', 'features') || {};
  return s[name] !== false;
}

// force-join check (multi-channel). Returns true if member of ALL required channels.
async function checkForceJoin(ctx, options = {}) {
  const s = store.get('settings', 'global') || {};
  const fj = Array.isArray(s.forcejoin) ? s.forcejoin : (s.forcejoin ? [s.forcejoin] : []);
  const testUntil = store.get('settings', 'gatetest:' + String(ctx.from && ctx.from.id)) || 0;
  const testMode = testUntil > Date.now();
  if (!fj.length || (isOwner(ctx.from.id) && !testMode)) return true;
  const missing = [];
  const uid = String(ctx.from.id);
  for (const raw of fj) {
    const gate = typeof raw === 'object' ? raw : { id: raw, type: 'chat', enabled: true };
    if (gate.enabled === false) continue;
    if (gate.type === 'bot_link') { missing.push({ gate, unverifiable: true }); continue; }
    const key = `${String(gate.id)}:${uid}`;
    const cached = !options.bypass && !options.simulate && memberCache.get(key);
    if (cached && cached.until > Date.now()) { if (!cached.member) missing.push({ gate }); continue; }
    try {
      const m = (options.simulate || testMode) ? { status: 'left', is_member: false } : await ctx.api.getChatMember(gate.id, ctx.from.id);
      const member = ['creator', 'administrator', 'member'].includes(m.status) || (m.status === 'restricted' && m.is_member === true);
      memberCache.set(key, { member, until: Date.now() + (member ? 45000 : 5000) });
      if (!member) missing.push({ gate });
    } catch (e) {
      gate.invalid = true;
      missing.push({ gate, invalid: true });
      const throttle = String(gate.id), prior = invalidGateAlertAt.get(throttle) || 0;
      if (Date.now() - prior > 3600000) {
        invalidGateAlertAt.set(throttle, Date.now());
        ctx.api.sendMessage(config.ownerId, `⚠️ بررسی gate عضویت ناموفق است: ${String(gate.id)}`).catch(() => {});
      }
    }
  }
  if (!missing.length) return true;
  if (testMode) {
    const sent = await ctx.reply(t(ctx.lang, 'forcejoin_msg'), { reply_markup: kb([[G(t(ctx.lang, 'btn_check'), 'fj:check')]]) });
    if (sent) setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {}), 30000).unref?.();
    return false;
  }
  if (ctx.chat.type !== 'private') {
    const nkey = `${ctx.chat.id}:${uid}`, prior = groupNoticeAt.get(nkey) || 0;
    if (Date.now() - prior >= 600000) {
      groupNoticeAt.set(nkey, Date.now());
      const sent = await ctx.reply(t(ctx.lang, 'forcejoin_msg')).catch(() => null);
      if (sent) setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {}), 30000).unref?.();
    }
    return false;
  }
  const rows = missing.map(({ gate, unverifiable, invalid }) => {
    const label = unverifiable ? 'عضویت غیرقابل تأیید' : invalid ? '⚠️ نامعتبر' : t(ctx.lang, 'btn_join');
    const target = String(gate.url || gate.id || '').replace(/^@/, '');
    return [URLB(label, /^-?\d+$/.test(target) || !target ? `https://t.me/${config.botUsername}` : `https://t.me/${target}`)];
  });
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
    await H.runDownload(ctx, sid);
    return;
  }
  if (arg.startsWith('s_')) {
    await H.doSearch(ctx, decodeURIComponent(arg.slice(2)));
    return;
  }
  if (arg.startsWith('ig_')) {
    // deep-link from an inline instagram music button after the user starts the bot
    const q = Buffer.from(arg.slice(3), 'base64url').toString();
    if (q) { try { const d = await sc.search(q, 1, ctx.lang); const tr = d.results && d.results[0]; if (tr) return H.runDownload(ctx, sc.sidOf(tr)); } catch (_) {} }
    return panel.freshMenu(ctx);
  }
  await panel.freshMenu(ctx);
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
bot.hears(/^(?:راهنما|help)$/i, async (ctx) => panel.show(ctx, 'help', {}, { push: false }));
bot.command('admin', async (ctx) => {
  if (!isOwner(ctx.from.id) || ctx.chat.type !== 'private') return;
  await panel.show(ctx, 'admin', {}, { push: false });
});
bot.command('gatetest', async (ctx) => {
  if (!isOwner(ctx.from.id) || ctx.chat.type !== 'private') return;
  store.set('settings', 'gatetest:' + String(ctx.from.id), Date.now() + 300000);
  await ctx.reply('آزمایش gate برای ۵ دقیقه فعال شد؛ اجرای درخواست شما به‌صورت غیرعضو بررسی می‌شود.');
});
bot.command('diag', async (ctx) => {
  if (ctx.chat.type === 'private') return;
  if (!(await isGroupAdmin(ctx))) return;
  const me = await bot.api.getMe().catch(() => null);
  let member = null;
  try { member = await bot.api.getChatMember(ctx.chat.id, me.id); } catch (_) {}
  const gs = chatSettings(ctx.chat.id);
  const isAdmin = member && ['administrator', 'creator'].includes(member.status);
  const lines = [
    `🩺 <b>تشخیص گروه</b>`,
    `🤖 وضعیت ربات: ${member ? member.status : 'نامشخص'}`,
    `👁 دیدن پیام‌ها: ${isAdmin ? 'همه (ادمین)' : 'فقط فرمان/منشن/ریپلای — برای دیدن همه، ادمین کن یا /setprivacy را خاموش کن'}`,
    `🧠 تشخیص هوشمند: ${gs.smart !== false ? 'روشن' : 'خاموش'}`,
    `💬 نوع چت: ${ctx.chat.type}${ctx.message && ctx.message.message_thread_id ? ' · topic ' + ctx.message.message_thread_id : ''}`,
    `🛰 آخرین آپدیت: ${lastUpdateSeen.update_id ?? '—'} · ${lastUpdateSeen.kind}`,
    `🧹 آخرین حذف: ${lastDrop.code} · ${lastDrop.update_id ?? '—'}`,
    `✉️ دسترسی ارسال: ${member && member.status !== 'kicked' && member.status !== 'left' ? '✅' : '❌'}`,
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});
bot.command('settings', async (ctx) => {
  if (ctx.chat.type === 'private') return;
  if (!(await isGroupAdmin(ctx))) return;
  await showGroupSettings(ctx);
});

async function simulateGateForOwner(ctx) {
  const s = store.get('settings', 'global') || {};
  const fj = Array.isArray(s.forcejoin) ? s.forcejoin : (s.forcejoin ? [s.forcejoin] : []);
  if (!fj.length) { await ctx.reply('gate برای آزمایش تعریف نشده است.'); return false; }
  const oldFrom = ctx.from;
  try {
    const fake = { ...ctx, from: { ...oldFrom, id: -1 }, chat: { ...ctx.chat, type: 'private' } };
    return !(await checkForceJoin(fake, { simulate: true, bypass: true }));
  } finally { ctx.from = oldFrom; }
}

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

bot.on('my_chat_member', () => { memberCache.clear(); });
bot.on('chat_member', () => { memberCache.clear(); });

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
  if (ctx.chat.type !== 'private' && text && !/^\/(?:start|help|music|search|song|recognize|diag|settings)(?:@\w+)?(?:\s|$)/i.test(text) && !text.toLowerCase().includes('@' + config.botUsername.toLowerCase()) && !(msg.reply_to_message && (await isReplyToBot(ctx, msg))) && !/^(?:راهنما|help)$/i.test(text) && !ig.isInstaUrl(text)) {
    const gs = chatSettings(ctx.chat.id);
    if (gs.smart === false || text.length >= 80 || /[@#]/.test(text) || containsLink(msg) || text.split(/\s+/).length > 6) return;
  }

  // awaiting state (search query, insta link, ticket, admin inputs)
  const aw = H.getAwait(uid);
  if (aw && ctx.chat.type === 'private') {
    H.clearAwait(uid);
    return handleAwait(ctx, aw, msg, text);
  }

  if (!text) return;

  // INSTAGRAM link — auto resolve + download media + music button
  if (ig.isInstaUrl(text)) {
    const addressed = ctx.chat.type === 'private' || (await isReplyToBot(ctx, msg));
    if (addressed) return H.doInsta(ctx, ig.cleanUrl(text));
    return;
  }
  // SOUNDCLOUD link -> direct download of the resolved track
  if (isSoundCloudUrl(text)) {
    const addressed = ctx.chat.type === 'private' || (await isReplyToBot(ctx, msg));
    if (addressed) {
      try {
        const tr = await sc.resolveUrl(text);
        return H.runDownload(ctx, sc.sidOf(tr));
      } catch (_) { return ctx.reply(t(lang, 'error_generic')); }
    }
    return;
  }

  if (ctx.chat.type === 'private') {
    if (!(await checkForceJoin(ctx))) return;
    if (/^(متن|ترانه|lyrics?)\s+/i.test(text)) return H.doLyrics(ctx, text.replace(/^(متن|ترانه|lyrics?)\s+/i, ''));
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
      const ok = await checkForceJoin(ctx, { bypass: true });
      if (ok) {
        await answer('✅');
        memberCache.clear();
        const prior = getPanel(ctx.chat.id, uid);
        const pending = prior && prior.pendingRequest;
        if (pending && pending.type === 'download') { setPanel(ctx.chat.id, uid, { pendingRequest: null }); return H.runDownload(ctx, pending.sid); }
        if (pending && pending.type === 'search') { setPanel(ctx.chat.id, uid, { pendingRequest: null }); return H.doSearch(ctx, pending.query); }
        return panel.show(ctx, 'menu', {}, { push: false });
      }
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
    if (data.startsWith('pick:')) {
      const sid = data.slice(5);
      const st = panel.stateFor(ctx.chat.id, cq.message.message_id);
      const q = st && st.current && st.current.params && st.current.params.q;
      if (q) {
        const learned = store.get('settings', 'search_learning') || {};
        const tr = await sc.track(sid).catch(() => null);
        if (tr) {
          const k = normalize(q);
          const old = learned[k] || {};
          learned[k] = { sid, artist: tr.artist, title: tr.title, count: (old.count || 0) + 1, at: Date.now() };
          store.set('settings', 'search_learning', learned);
        }
      }
      return H.runDownload(ctx, sid);
    }
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
    if (data.startsWith('igi:')) return inlineInstaMusic(ctx, data.slice(4));
    // ----- admin -----
    if (data === 'a:panel') { await answer(); return panel.show(ctx, 'admin'); }
    if (data === 'a:stats') { await answer(); return panel.show(ctx, 'admin_stats'); }
    if (data === 'a:health') { await answer(); return panel.show(ctx, 'admin_health'); }
    if (data === 'a:chans') { await answer(); return panel.show(ctx, 'admin_channels'); }
    if (data === 'a:bans') { await answer(); return panel.show(ctx, 'admin_bans'); }
    if (data === 'a:set') { await answer(); return panel.show(ctx, 'admin_settings'); }
    if (data === 'a:langs') { await answer(); return panel.show(ctx, 'admin_langs'); }
    if (data === 'a:tickets') { await answer(); return panel.show(ctx, 'admin_tickets'); }
    if (data === 'a:features') { await answer(); return panel.show(ctx, 'admin_features'); }
    if (data.startsWith('feat:')) {
      const key = data.slice(5);
      const s = store.get('settings', 'features') || {};
      s[key] = !(s[key] !== false);
      store.set('settings', 'features', s);
      await answer(s[key] ? '✅' : '❌');
      return panel.show(ctx, 'admin_features', {}, { push: false });
    }
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

// inline instagram music button: resolve -> recognize -> send music to user's PM
async function inlineInstaMusic(ctx, b64) {
  const lang = ctx.lang, uid = ctx.from.id;
  const url = Buffer.from(b64, 'base64url').toString();
  try { await ctx.answerCallbackQuery({ text: t(lang, 'recognizing') }); } catch (_) {}
  // Need the user's private chat to send the file. If they never started the bot, deep-link.
  try {
    const d = await ig.resolve(ig.cleanUrl(url));
    const item = (d.items || []).find((i) => i.type === 'video');
    if (!item) { await ctx.answerCallbackQuery({ text: t(lang, 'recognize_none'), show_alert: true }); return; }
    const path = require('node:path'), fs = require('node:fs');
    const tmp = path.join(config.tmpDir, `igv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    const v = item.variants && item.variants[0];
    await ig.downloadFile(d.source_url, { quality: v && v.quality, index: item.index }, tmp, 80 * 1024 * 1024);
    const { decodeWithFfmpeg } = require('./bot/audio');
    const pcm = await decodeWithFfmpeg(fs.readFileSync(tmp), 'mp4');
    try { fs.unlinkSync(tmp); } catch (_) {}
    const rec = await sh.recognizeBySignature(pcm, { lyrics: false });
    if (!rec || !rec.found) { await ctx.api.sendMessage(uid, t(lang, 'recognize_none')); return; }
    // find downloadable soundcloud match and send
    const q = `${rec.artist || ''} ${rec.title || ''}`.trim();
    const s = await sc.search(q, 1, lang);
    const tr = s.results && s.results[0];
    if (!tr) { await ctx.api.sendMessage(uid, t(lang, 'no_results')); return; }
    await H.runDownload({ ...ctx, chat: { id: uid, type: 'private' }, from: ctx.from, lang }, sc.sidOf(tr));
    await ctx.answerCallbackQuery({ text: '🎧 ' + t(lang, 'sent_pm') }).catch(() => {});
  } catch (e) {
    log.warn('inline insta music', e.code || e.message);
    // fallback: deep-link so user starts bot then gets the song
    try { await ctx.answerCallbackQuery({ url: `https://t.me/${config.botUsername}?start=ig_${Buffer.from((e.q || '')).toString('base64url')}` }); } catch (_) {}
  }
}

// ---------- inline mode: answer only with validated, locally prepared media ----------
bot.on('inline_query', async (ctx) => {
  const q = (ctx.inlineQuery.query || '').trim();
  const base = config.publicUrl;
  const lang = ctx.lang;
  const noQueryButton = { text: '▶️ شروع ربات', start_parameter: 'inline' };

  if (!q) {
    return ctx.answerInlineQuery([{ type: 'article', id: 'hint', title: '🎧 Music', description: 'نام آهنگ، خواننده یا لینک اینستاگرام را بنویس', input_message_content: { message_text: t(lang, 'inline_hint', { bot: config.botUsername }) } }], { cache_time: 30, is_personal: true, button: noQueryButton });
  }
  if (ig.isInstaUrl(q)) {
    try {
      const d = await ig.resolve(ig.cleanUrl(q));
      const it = (d.items || []).find((x) => x.type === 'video') || (d.items || [])[0];
      if (!it) return ctx.answerInlineQuery([], { cache_time: 10 });
      const v = it.variants.find((x) => it.type === 'video' ? (/video/i.test(x.mime || '') || x.has_audio) : /image/i.test(x.mime || '')) || it.variants[0];
      if (!v) return ctx.answerInlineQuery([], { cache_time: 10 });
      // prepare mp4 before exposing it to Telegram; return article until ready.
      const preparing = mediaCache.warmVideo(d.source_url, it, v, ig);
      const ready = await Promise.race([preparing, new Promise((r) => setTimeout(() => r(null), 1300))]);
      if (!ready) {
        preparing.catch(() => {});
        return ctx.answerInlineQuery([{ type: 'article', id: 'ig-preparing', title: '⏳ در حال آماده‌سازی ویدیو', description: 'چند لحظه دیگر لینک را دوباره جستجو کن', input_message_content: { message_text: '⏳ ویدیو در حال آماده‌سازی است. چند لحظه دیگر جستجو را تکرار کن.' } }], { cache_time: 2, is_personal: true, button: noQueryButton });
      }
      const token = signMedia('v', ready.key, 1800);
      const thumb = it.thumbnail || d.thumbnail || v.url;
      const videoResult = it.type === 'video' ? {
        type: 'video', id: 'igv' + it.index,
        video_url: `${base}/v/${encodeURIComponent(token)}.mp4`, mime_type: 'video/mp4',
        thumbnail_url: thumb, title: (d.author && d.author.username) || 'Instagram',
        video_width: ready.width, video_height: ready.height, video_duration: ready.duration,
        caption: '📸 Instagram',
        reply_markup: kb([[G('🎵 تشخیص و دریافت موزیک', 'igi:' + Buffer.from(q).toString('base64url').slice(0, 50))]]),
      } : {
        type: 'photo', id: 'igp' + it.index,
        photo_url: `${base}/v/${encodeURIComponent(token)}.mp4`, thumbnail_url: thumb,
        photo_width: ready.width, photo_height: ready.height, title: 'Instagram',
        reply_markup: kb([[B('🎵 جستجوی موزیک', 'igm:' + Buffer.from(guessCaptionQuery(d)).toString('base64url').slice(0, 48))]]),
      };
      return ctx.answerInlineQuery([videoResult], { cache_time: 30, is_personal: true, button: noQueryButton });
    } catch (e) { log.warn('inline instagram', e.code || 'resolve'); return ctx.answerInlineQuery([], { cache_time: 5 }); }
  }

  if (q.length < 2) return ctx.answerInlineQuery([], { cache_time: 30, button: noQueryButton });
  try {
    const d = await sc.search(q, 1, lang);
    const tracks = (d.results || []).slice(0, 10);
    // Try to make the strongest candidates immediately playable, then answer.
    const prep = tracks.slice(0, 8).map((tr) => mediaCache.warmAudio(tr).catch(() => null));
    await Promise.race([Promise.all(prep), new Promise((r) => setTimeout(r, 1800))]);
    const results = [];
    for (const [i, tr] of tracks.entries()) {
      const sid = sc.sidOf(tr), meta = cleanTrackMeta(tr), cachedKey = `${sid}|${meta.artist}|${meta.title}|cleanTrackMeta-v2`;
      const cached = store.get('file_id_cache', cachedKey);
      if (cached && cached.file_id && cached.v === 'v4' && cached.validated && cached.metaVersion === 'cleanTrackMeta-v2' && cached.artist === meta.artist && cached.title === meta.title) {
        results.push({ type: 'audio', id: 'c' + sid, audio_file_id: cached.file_id, title: meta.title, performer: meta.artist, caption: `🎵 ${esc(meta.artist)} — ${esc(meta.title)}` });
        continue;
      }
      const audioKey = mediaCache.audioCacheKey(tr);
      const ready = mediaCache.cached(audioKey, 'mp3');
      if (!ready) continue;
      const token = signMedia('a', audioKey, 1800);
      results.push({ type: 'audio', id: 'a' + sid + '_' + i, audio_url: `${base}/m/${encodeURIComponent(token)}.mp3`, title: meta.title || 'Music', performer: meta.artist || '', audio_duration: ready.duration, caption: `🎵 ${esc(meta.artist)} — ${esc(meta.title)} · ${ready.duration}s` });
    }
    if (!results.length) results.push({ type: 'article', id: 'preparing', title: '⏳ در حال آماده‌سازی آهنگ', description: 'چند لحظه دیگر همین عبارت را دوباره جستجو کن', input_message_content: { message_text: `🎧 ${esc(q)}\n⏳ فایل در حال آماده‌سازی است؛ دوباره جستجو کن.` } });
    return ctx.answerInlineQuery(results.slice(0, 8), { cache_time: results[0].type === 'article' ? 2 : 30, is_personal: true, button: noQueryButton });
  } catch (e) { log.warn('inline search', e.code || 'service'); return ctx.answerInlineQuery([], { cache_time: 5 }); }
});

function guessCaptionQuery(d) {
  const caption = String(d.caption || '').split('\n')[0].trim();
  const m = caption.match(/([\p{L} .'-]+)\s*[-–—|]\s*([\p{L} .'-]+)/u);
  return m ? `${m[1]} ${m[2]}` : caption.slice(0, 64);
}

// ── signed media proxy (/m/ = audio, /v/ = insta video) ────────────────────
const cryptoMod = require('node:crypto');
function signMedia(kind, id, ttl = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = `${kind}.${id}.${exp}`;
  const sig = cryptoMod.createHmac('sha256', config.inlineSignSecret).update(payload).digest('base64url');
  return `${id}.${exp}.${sig}`;
}
function verifyMedia(kind, token) {
  const parts = token.split('.');
  if (parts.length < 3) return null;
  const sig = parts.pop(), exp = parts.pop(), id = parts.join('.');
  if (Date.now() / 1000 > Number(exp)) return null;
  const expect = cryptoMod.createHmac('sha256', config.inlineSignSecret).update(`${kind}.${id}.${exp}`).digest('base64url');
  return cryptoMod.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)) ? { id } : null;
}

async function serveSignedMedia(req, res, urlPath) {
  const started = Date.now();
  const kind = urlPath.startsWith('/m/') ? 'a' : 'v';
  const token = decodeURIComponent(urlPath.slice(3)).replace(/\.(mp3|m4a|mp4)$/, '');
  const signed = verifyMedia(kind, token);
  if (!signed) { res.writeHead(403); return res.end(); }
  const hit = kind === 'a' ? mediaCache.cached(signed.id, 'mp3') : mediaCache.getVideo(signed.id);
  if (!hit) { res.writeHead(503, { 'retry-after': '2', 'cache-control': 'no-store' }); return res.end('media is still preparing'); }
  const size = hit.size;
  const type = kind === 'a' ? 'audio/mpeg' : 'video/mp4';
  let start = 0, end = size - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const m = String(range).match(/^bytes=(\d*)-(\d*)$/);
    if (!m) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
    if (m[1]) start = Number(m[1]);
    if (m[2]) end = Math.min(end, Number(m[2]));
    if (start >= size || end < start) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
    status = 206;
  }
  const length = end - start + 1;
  const headers = { 'content-type': type, 'content-length': String(length), 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=600', 'content-disposition': 'inline' };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  const ua = String(req.headers['user-agent'] || '').slice(0,80);
  res.writeHead(status, headers);
  const streamStarted = Date.now();
  log.info('inline media', { kind, id: signed.id, method: req.method, status, ua, range: range ? 'yes':'no', ttfb_ms: streamStarted-started, content_type: type, content_length: length, total: size });
  if (req.method === 'HEAD') { res.end(); return; }
  await new Promise((resolve) => {
    const rs = fs.createReadStream(hit.path, { start, end });
    let sent = 0;
    rs.once('open', () => log.debug('inline file opened', { kind, start, end }));
    rs.on('data', (chunk) => { sent += chunk.length; });
    rs.on('error', (e) => { log.error('inline file read error', { kind, message: e.message }); if (!res.headersSent) res.writeHead(500); res.destroy(); resolve(); });
    rs.on('end', () => { log.info('inline media complete', { kind, id: signed.id, sent, total_ms: Date.now()-started }); resolve(); });
    rs.pipe(res);
  });
}

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
    // ── signed media proxies for inline mode ───────────────────────────────
    if (url.startsWith('/m/') || url.startsWith('/v/')) {
      return serveSignedMedia(req, res, url).catch(() => { if (!res.headersSent) reply(502, { ok: false }); });
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
