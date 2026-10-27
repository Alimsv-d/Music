'use strict';
// Cloudflare Worker adapter for the Music bot.
// Reuses the service-layer logic but runs against D1 (store) + KV (cache).
// Audio fingerprinting needs more CPU than the free plan allows, so audio
// recognition is only enabled when HEAVY_AUDIO_URL points at the Node app.
const I18N = {
  menu_search: { fa: '🔍 جستجوی موزیک', en: '🔍 Search music' },
  dl: { fa: '🟢 دانلود', en: '🟢 Download' },
  welcome: { fa: n => `سلام ${n}! به Music خوش آمدی.`, en: n => `Hello ${n}! Welcome to Music.` },
};

const enc = new TextEncoder();
async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

class TG {
  constructor(token) { this.token = token; this.base = `https://api.telegram.org/bot${token}`; }
  async call(method, payload) {
    const r = await fetch(`${this.base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return r.json();
  }
  sendMessage(chat, text, extra) { return this.call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(extra || {}) }); }
  editMessageText(chat, mid, text, extra) { return this.call('editMessageText', { chat_id: chat, message_id: mid, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(extra || {}) }); }
  editMessageMedia(chat, mid, media, extra) { return this.call('editMessageMedia', { chat_id: chat, message_id: mid, media, ...(extra || {}) }); }
  answerCallbackQuery(id, extra) { return this.call('answerCallbackQuery', { callback_query_id: id, ...(extra || {}) }); }
  sendAudio(chat, audio, extra) { return this.call('sendAudio', { chat_id: chat, audio, ...(extra || {}) }); }
}

async function scCall(env, path, params) {
  const url = env.SOUNDCLOUD_API_URL + path + '?' + new URLSearchParams(params);
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  return r.json();
}
async function shazamCall(env, path, body) {
  const r = await fetch(env.SHAZAM_API_URL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

async function search(env, q, page = 1) {
  const d = await scCall(env, '/api/v1/search', { q, page });
  return d.ok ? (d.results || []) : [];
}
const sid = (t) => String(t.sid || (t.id || '').replace(/^sc_/, ''));

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function kb(rows) { return { inline_keyboard: rows.filter((r) => r && r.length) }; }
const B = (t, c) => ({ text: t, callback_data: c });
const URLB = (t, url) => ({ text: t, url });

async function handleUpdate(env, ctx, u) {
  const tg = new TG(env.BOT_TOKEN);
  const m = u.message || (u.callback_query && u.callback_query.message);
  const from = (u.message && u.message.from) || (u.callback_query && u.callback_query.from);
  if (!m || !from) return;
  const chat = m.chat, cid = chat.id, uid = from.id;
  const lang = 'fa';
  const isOwner = Number(uid) === Number(env.OWNER_ID);

  if (u.callback_query) {
    const cq = u.callback_query, data = cq.data || '';
    const answer = (t, a) => tg.answerCallbackQuery(cq.id, { text: t, show_alert: a });
    if (data === 'noop') return answer();
    if (data.startsWith('trk:')) {
      await answer();
      const tr = await scCall(env, '/api/v1/track', { id: data.slice(4) }).then((d) => d.ok && d.track);
      if (!tr) return;
      const text = `🎵 <b>${esc(tr.title)}</b>\n👤 ${esc(tr.artist)}`;
      const markup = kb([[{ text: '⬇️', callback_data: 'dl:' + sid(tr) }], [URLB('🔗', tr.page_url || 'https://soundcloud.com')], [B('🔙', 'nav:back')]]);
      if (tr.cover) {
        await tg.editMessageMedia(cid, m.message_id, { type: 'photo', media: env.SOUNDCLOUD_API_URL + '/api/v1/cover?url=' + encodeURIComponent(tr.cover), caption: text, parse_mode: 'HTML' }, { reply_markup: markup });
      } else {
        await tg.editMessageText(cid, m.message_id, text, { reply_markup: markup });
      }
      return;
    }
    if (data.startsWith('dl:')) {
      await answer('⏳');
      const tr = await scCall(env, '/api/v1/track', { id: data.slice(3) }).then((d) => d.ok && d.track);
      if (!tr) return;
      // send audio via stream URL (Telegram downloads it)
      await tg.sendAudio(cid, env.SOUNDCLOUD_API_URL + '/api/v1/stream?id=' + sid(tr), { title: tr.title, performer: tr.artist, duration: Math.round((tr.duration_ms || 0) / 1000) });
      return;
    }
    if (data === 'nav:back') { await answer(); return tg.editMessageText(cid, m.message_id, 'Music', { reply_markup: mainMenu(lang, isOwner) }); }
    if (data.startsWith('m:')) {
      await answer();
      if (data === 'm:search') return tg.editMessageText(cid, m.message_id, '🔍 نام آهنگ یا خواننده را بفرست:', { reply_markup: kb([[B('🔙 بازگشت', 'nav:back')]]) });
      if (data === 'm:help') return tg.editMessageText(cid, m.message_id, 'Music — جستجو، دانلود، شناسایی آهنگ و دانلود اینستاگرام.', { reply_markup: kb([[B('🔙 بازگشت', 'nav:back')]]) });
    }
    return answer();
  }

  const text = (m.text || '').trim();
  if (!text) {
    // media -> recognition only if HEAVY_AUDIO_URL configured
    if ((m.voice || m.audio || m.video) && env.HEAVY_AUDIO_URL) {
      await tg.sendMessage(cid, '🎤 در حال شناسایی…');
      // delegate heavy decode+fingerprint to node endpoint (secret-protected)
      const file = m.voice || m.audio || m.video;
      const gf = await tg.call('getFile', { file_id: file.file_id });
      const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`;
      const r = await fetch(env.HEAVY_AUDIO_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cron-secret': env.CRON_SECRET }, body: JSON.stringify({ file_url: fileUrl }) });
      const d = await r.json().catch(() => null);
      if (d && d.artist) {
        await tg.sendMessage(cid, `🎤 <b>${esc(d.title)}</b>\n👤 ${esc(d.artist)}`, { reply_markup: kb([[B('🔍 جستجو', 'm:search')]]) });
      } else {
        await tg.sendMessage(cid, '❌ آهنگی شناسایی نشد.');
      }
      return;
    }
    if ((m.voice || m.audio || m.video) && !env.HEAVY_AUDIO_URL) {
      return tg.sendMessage(cid, '⚠️ شناسایی صوتی در نسخه‌ی ابری فعلاً در دسترس نیست.');
    }
    return;
  }

  if (text.startsWith('/start')) {
    const arg = text.split(/\s+/)[1] || '';
    if (arg.startsWith('t_')) {
      const tr = await scCall(env, '/api/v1/track', { id: arg.slice(2) }).then((d) => d.ok && d.track);
      if (tr) {
        const text2 = `🎵 <b>${esc(tr.title)}</b>\n👤 ${esc(tr.artist)}`;
        return tg.sendMessage(cid, text2, { reply_markup: kb([[{ text: '⬇️', callback_data: 'dl:' + sid(tr) }], [URLB('🔗', tr.page_url || 'https://soundcloud.com')]]) });
      }
    }
    return tg.sendMessage(cid, I18N.welcome.fa(from.first_name || ''), { reply_markup: mainMenu(lang, isOwner) });
  }
  if (text === '/help' || text.startsWith('/help')) return tg.sendMessage(cid, 'Music — جستجو و دانلود آهنگ، شناسایی و دانلود اینستاگرام.');

  // default: search
  const results = await search(env, text);
  if (!results.length) return tg.sendMessage(cid, '❌ چیزی پیدا نشد.');
  const rows = results.slice(0, 8).map((tr) => [B(`${tr.artist} — ${tr.title}`.slice(0, 44) + ` · ${tr.duration || ''}`, 'trk:' + sid(tr))]);
  await tg.sendMessage(cid, `نتایج «${esc(text)}»`, { reply_markup: kb(rows) });
}

function mainMenu(lang, isOwner) {
  const rows = [
    [B('🔍 جستجوی موزیک', 'm:search'), B('🎤 شناسایی آهنگ', 'm:recog')],
    [B('📸 دانلود اینستاگرام', 'm:insta'), B('🔥 جدیدترین‌ها', 'm:new')],
    [B('ℹ️ راهنما', 'm:help')],
  ];
  if (isOwner) rows.push([B('🛠 پنل مدیریت', 'a:panel')]);
  return kb(rows);
}

async function cronTick(env) {
  const tg = new TG(env.BOT_TOKEN);
  // drain post queue stored in KV
  const q = await env.KV.get('post_queue', 'json') || [];
  if (!q.length) return;
  const chans = await env.KV.get('channels', 'json') || [];
  const item = q[0];
  for (const ch of chans) {
    const tr = item.tr;
    const caption = `🎵 <b>${esc(tr.title)}</b>\n👤 ${esc(tr.artist)}`;
    try {
      await tg.call('sendPhoto', { chat_id: ch.id, photo: tr.cover ? env.SOUNDCLOUD_API_URL + '/api/v1/cover?url=' + encodeURIComponent(tr.cover) : undefined, caption, parse_mode: 'HTML' });
    } catch (_) {}
  }
  q.shift();
  await env.KV.put('post_queue', JSON.stringify(q));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const whPath = '/wh/' + (await sha256Hex(env.WEBHOOK_SECRET || 'x')).slice(0, 24);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname === '/cron/' + env.CRON_SECRET) { ctx.waitUntil(cronTick(env)); return Response.json({ ok: true }); }
    if (request.method === 'POST' && url.pathname === whPath) {
      if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
      let u;
      try { u = await request.json(); } catch (_) { return new Response('bad', { status: 400 }); }
      ctx.waitUntil(handleUpdate(env, ctx, u).catch(() => {}));
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cronTick(env));
  },
};
