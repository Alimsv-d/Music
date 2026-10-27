'use strict';
// Music Bot — single-file Cloudflare Worker (ES module).
// Feature parity with the cPanel grammY bot, incl. *colored* inline buttons
// (Telegram Bot API 9.x `style`: success|primary|danger). If the Bot API
// deployment rejects `style`, each call retries once without it.
//
// Routes:
//   GET  /            -> landing page
//   GET  /activate    -> (re)point webhook to this worker + notify owner
//   GET  /health      -> { ok, webhook info }
//   POST /wh/<hash>   -> Telegram webhook (secret-token verified)
//   Cron              -> keep-alive / pending jobs (optional KV)

const FB = {
  SOUNDCLOUD_API_URL: 'https://soundcloud-worker.alighost5920.workers.dev',
  SHAZAM_API_URL: 'https://shazam-worker.alighost5920.workers.dev',
  INSTA_API_URL: 'https://insta-worker.alighost5920.workers.dev',
  WEBHOOK_SECRET: 'MUSIC_AUTO_FALLBACK_2026_X9fK82vTq',
  BOT_USERNAME: 'SearcherMusiic_Bot',
  CHANNEL: 'MusicMsvD',
  OWNER_USERNAME: 'AliMsvD',
};

const enc = new TextEncoder();
const v = (e, k, d) => (e && e[k] != null && String(e[k]).trim() !== '' ? String(e[k]).trim() : d);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sid = (t) => String((t && (t.sid || t.id)) || '').replace(/^sc_/, '');
const kb = (rows) => ({ inline_keyboard: (rows || []).filter((r) => r && r.length) });
const btn = (text, callback_data, style = 'primary') => ({ text, callback_data, style });
const G = (t, c) => btn(t, c, 'success');
const B = (t, c) => btn(t, c, 'primary');
const R = (t, c) => btn(t, c, 'danger');
const URLB = (t, u, style = 'primary') => ({ text: t, url: u, style });

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(String(s)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

class TG {
  constructor(token) { this.b = `https://api.telegram.org/bot${token}`; }
  async call(method, payload, _retried) {
    try {
      const r = await fetch(`${this.b}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
      });
      const j = await r.json().catch(() => ({ ok: false }));
      if (!j.ok && !_retried && /style/i.test(String(j.description || '')) && /bad request/i.test(String(j.description || ''))) {
        const clone = JSON.parse(JSON.stringify(payload || {}));
        let removed = false;
        const strip = (mk) => {
          for (const row of (mk && mk.inline_keyboard) || [])
            for (const b of row) if ('style' in b) { delete b.style; removed = true; }
        };
        strip(clone.reply_markup);
        if (removed) return this.call(method, clone, true);
      }
      return j;
    } catch (e) { return { ok: false, error: String(e) }; }
  }
  sendMessage(c, t, ex = {}) { return this.call('sendMessage', { chat_id: c, text: t, parse_mode: 'HTML', disable_web_page_preview: true, ...ex }); }
  editMessageText(c, mid, t, ex = {}) { return this.call('editMessageText', { chat_id: c, message_id: mid, text: t, parse_mode: 'HTML', disable_web_page_preview: true, ...ex }); }
  answerCallbackQuery(id, ex = {}) { return this.call('answerCallbackQuery', { callback_query_id: id, ...ex }); }
  sendChatAction(c, a = 'typing') { return this.call('sendChatAction', { chat_id: c, action: a }); }
  sendAudio(c, audio, ex = {}) { return this.call('sendAudio', { chat_id: c, audio, ...ex }); }
  sendVideo(c, video, ex = {}) { return this.call('sendVideo', { chat_id: c, video, supports_streaming: true, ...ex }); }
  sendPhoto(c, photo, ex = {}) { return this.call('sendPhoto', { chat_id: c, photo, ...ex }); }
  sendVoice(c, voice, ex = {}) { return this.call('sendVoice', { chat_id: c, voice, ...ex }); }
  getFile(file_id) { return this.call('getFile', { file_id }); }
  setWebhook(url, ex = {}) { return this.call('setWebhook', { url, ...ex }); }
  deleteWebhook() { return this.call('deleteWebhook', { drop_pending_updates: true }); }
  getWebhookInfo() { return this.call('getWebhookInfo'); }
  getMe() { return this.call('getMe'); }
}

async function scCall(env, p, params) {
  const base = v(env, 'SOUNDCLOUD_API_URL', FB.SOUNDCLOUD_API_URL).replace(/\/$/, '');
  const url = base + p + (params && Object.keys(params).length ? '?' + new URLSearchParams(params) : '');
  try { const r = await fetch(url, { headers: { Accept: 'application/json' } }); return await r.json(); }
  catch (e) { return { ok: false }; }
}
async function shCall(env, p, body) {
  const base = v(env, 'SHAZAM_API_URL', FB.SHAZAM_API_URL).replace(/\/$/, '');
  try { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}) }); return await r.json(); }
  catch (e) { return { ok: false }; }
}
async function igCall(env, p, params) {
  const base = v(env, 'INSTA_API_URL', FB.INSTA_API_URL).replace(/\/$/, '');
  const url = base + p + (params ? '?' + new URLSearchParams(params) : '');
  try { const r = await fetch(url, { headers: { Accept: 'application/json' } }); return await r.json(); }
  catch (e) { return { ok: false }; }
}

const welcomeText = (env, name) =>
  `🎧 <b>Music</b> | دستیار موزیک و دانلود\n\nسلام ${esc(name)} 👋 فقط کافیه چیزی بفرستی؛ بقیه‌اش با من 👇\n\n` +
  `🔎 <b>اسم خواننده یا آهنگ</b> ← فایل موزیک\n🎼 <b>یک خط از ترانه</b> ← پیدا کردن آهنگ\n` +
  `🎤 <b>ویس، ویدیو یا فایل صوتی</b> ← شناسایی آهنگ\n📸 <b>لینک اینستاگرام</b> ← ویدیو + موزیکش\n\n` +
  `💡 در هر چتی نام آهنگ را برای inline جستجو کن.\n@${v(env, 'BOT_USERNAME', FB.BOT_USERNAME)} اسم آهنگ`;

function menu(env, isOwner) {
  const user = v(env, 'BOT_USERNAME', FB.BOT_USERNAME);
  const chan = v(env, 'CHANNEL', FB.CHANNEL).replace('@', '');
  const rows = [
    [URLB('➕ افزودن به گروه', `https://t.me/${user}?startgroup=true&admin=delete_messages+pin_messages`, 'success')],
    [URLB('📢 کانال اصلی', `https://t.me/${chan}`, 'primary'), B('🌐 زبان', 'm:lang')],
    [B('👥 دعوت دوستان', 'm:invite'), B('ℹ️ راهنما', 'm:help'), B('📞 پشتیبانی', 'm:support')],
  ];
  if (isOwner) rows.push([R('🛠 پنل مدیریت', 'a:panel')]);
  return kb(rows);
}

async function sendTrack(env, tg, cid, tr) {
  const sv = sid(tr), sb = v(env, 'SOUNDCLOUD_API_URL', FB.SOUNDCLOUD_API_URL).replace(/\/$/, '');
  const title = tr.title || '', perf = tr.artist || '', dur = Math.round((tr.duration_ms || 0) / 1000) || undefined;
  const cap = `🎵 <b>${esc(title)}</b>\n👤 <b>${esc(perf)}</b>`;
  for (const ep of ['/api/v1/stream', '/api/v1/download']) {
    const r = await tg.sendAudio(cid, `${sb}${ep}?id=${encodeURIComponent(sv)}`, { title, performer: perf, duration: dur, caption: cap });
    if (r && r.ok) return true;
  }
  return false;
}

const igButtons = (text) => {
  const q = b64url(enc.encode(text));
  return kb([[G('🎬 دریافت فایل(ها)', `igf:${q}`)], [G('🎤 شناسایی موزیک ویدیو', `igr:${q}`)]]);
};

async function igFetch(env, tg, cid, urlb) {
  const url = new TextDecoder().decode(fromB64url(urlb));
  const r = await igCall(env, '/resolve', { url });
  const items = (r && r.ok && r.data && r.data.items) || (r && r.items) || [];
  let sent = 0;
  for (const it of items) {
    const vit = (it.variants || []).find((x) => x && x.url);
    if (!vit) continue;
    const isVid = it.type === 'video' || /video/i.test(vit.mime || '');
    const r2 = isVid ? await tg.sendVideo(cid, vit.url, { caption: '🎬 Instagram' })
                     : await tg.sendPhoto(cid, vit.url, { caption: '🖼 Instagram' });
    if (r2 && r2.ok) sent++;
  }
  if (!sent) await tg.sendMessage(cid, '❌ چیزی برای ارسال پیدا نشد');
}

async function igRecognize(env, tg, cid, urlb) {
  const url = new TextDecoder().decode(fromB64url(urlb));
  const r = await igCall(env, '/resolve', { url });
  const items = (r && r.ok && r.data && r.data.items) || (r && r.items) || [];
  const it = items.find((x) => x.type === 'video' || (x.variants || []).some((vv) => /video/i.test(vv.mime || '')));
  if (!it) return tg.sendMessage(cid, '❌ ویدیو پیدا نشد');
  const vit = (it.variants || []).find((x) => x.url);
  const ab = await fetch(vit.url).then((x) => x.arrayBuffer());
  const b64 = b64url(ab);
  let rec = await shCall(env, '/api/v1/recognize', { audio: b64 });
  const d2 = (rec && rec.data) || rec;
  if (d2 && (d2.found || d2.artist)) {
    const q2 = `${d2.artist || ''} ${d2.title || ''}`.trim();
    const sr = await scCall(env, '/api/v1/search', { q: q2 });
    const tr2 = (sr && sr.ok && sr.results || [])[0];
    if (tr2) {
      await tg.sendMessage(cid, `🎤 <b>شناسایی شد</b>\n🎵 ${esc(tr2.title)}\n👤 ${esc(tr2.artist)}`);
      await sendTrack(env, tg, cid, tr2);
      return;
    }
    return tg.sendMessage(cid, `🎤 شناسایی شد\n<b>${esc(d2.title)}</b>\n👤 ${esc(d2.artist)}`);
  }
  await tg.sendMessage(cid, '❌ شناسایی نشد');
}

async function recognizeMedia(env, tg, cid, token, f) {
  const gf = await tg.getFile(f.file_id);
  if (!gf || !gf.ok) return tg.sendMessage(cid, '❌ خطا در دریافت فایل');
  const fileUrl = `https://api.telegram.org/file/bot${token}/${gf.result.file_path}`;
  const ab = await fetch(fileUrl).then((x) => x.arrayBuffer());
  let rec = await shCall(env, '/api/v1/recognize', { audio: b64url(ab) });
  if (!(rec && (rec.data || rec).found)) rec = await shCall(env, '/api/v1/recognize', { url: fileUrl });
  const d2 = (rec && rec.data) || rec;
  if (d2 && (d2.found || d2.artist || d2.track)) {
    const trk = d2.track || d2;
    const q2 = `${trk.artist || d2.artist || ''} ${trk.title || d2.title || ''}`.trim();
    const sr = await scCall(env, '/api/v1/search', { q: q2 });
    const tr3 = (sr && sr.ok && sr.results || [])[0];
    if (tr3) {
      await tg.sendMessage(cid, `🎤 <b>شناسایی شد</b>\n🎵 ${esc(tr3.title)}\n👤 ${esc(tr3.artist)}`);
      return sendTrack(env, tg, cid, tr3);
    }
  }
  return tg.sendMessage(cid, '❌ نتوانستم شناسایی کنم');
}

async function searchAndList(env, tg, cid, q) {
  const sr = await scCall(env, '/api/v1/search', { q });
  const res = (sr && sr.ok && sr.results) || [];
  if (!res.length) return tg.sendMessage(cid, '❌ چیزی پیدا نشد');
  const rows = res.slice(0, 10).map((tr) =>
    [G(`${(tr.artist || '')} — ${tr.title || ''}`.slice(0, 60), `dl:${sid(tr)}`)]);
  return tg.sendMessage(cid, `🔎 نتایج «${esc(q)}»\nروی موزیک کلیک کن تا مستقیم ارسال شه:`, { reply_markup: kb(rows) });
}

async function handle(env, u) {
  const token = v(env, 'BOT_TOKEN', '');
  if (!token) return;
  const tg = new TG(token);
  const owner = Number(v(env, 'OWNER_ID', '0'));

  if (u.callback_query) {
    const cq = u.callback_query, cid = cq.message.chat.id, mid = cq.message.message_id;
    const from = cq.from || {}, data = cq.data || '';
    const ans = (t, a) => tg.answerCallbackQuery(cq.id, { text: t, show_alert: !!a });

    if (data.startsWith('dl:')) {
      await ans('⏳ در حال ارسال...');
      const tr = await scCall(env, '/api/v1/track', { id: data.slice(3) }).then((d) => d && d.ok && d.track);
      if (!tr) return ans('خطا', true);
      await sendTrack(env, tg, cid, tr);
      return;
    }
    if (data.startsWith('igf:')) { await ans('⏳'); await igFetch(env, tg, cid, data.slice(4)).catch(() => ans('خطا', true)); return; }
    if (data.startsWith('igr:')) { await ans('🎤 شناسایی...'); await igRecognize(env, tg, cid, data.slice(4)).catch(() => ans('خطا', true)); return; }

    if (data === 'm:home' || data === 'nav:back')
      return tg.editMessageText(cid, mid, welcomeText(env, from.first_name || ''), { reply_markup: menu(env, from.id === owner) });
    if (data === 'm:lang')
      return tg.editMessageText(cid, mid, '🌐 زبان را انتخاب کن:', { reply_markup: kb([[G('فارسی', 'lang:fa'), B('English', 'lang:en')], [R('🔙 بازگشت', 'm:home')]]) });
    if (data === 'lang:fa' || data === 'lang:en')
      return tg.editMessageText(cid, mid, welcomeText(env, from.first_name || ''), { reply_markup: menu(env, from.id === owner) });
    if (data === 'm:invite') {
      const link = `https://t.me/${v(env, 'BOT_USERNAME', FB.BOT_USERNAME)}?start=ref_${from.id}`;
      const share = `https://t.me/share/url?url=${encodeURIComponent(link)}`;
      return tg.editMessageText(cid, mid, `👥 <b>دعوت دوستان</b>\n\n<code>${esc(link)}</code>`,
        { reply_markup: kb([[URLB('📤 اشتراک لینک', share, 'success')], [R('🔙 بازگشت', 'm:home')]]) });
    }
    if (data === 'm:support')
      return tg.editMessageText(cid, mid, `💬 <b>پشتیبانی</b>\n\n@${v(env, 'OWNER_USERNAME', FB.OWNER_USERNAME)}`, { reply_markup: kb([[R('🔙 بازگشت', 'm:home')]]) });
    if (data === 'm:help')
      return tg.editMessageText(cid, mid, 'ℹ️ <b>راهنما</b>\n\n🔎 اسم آهنگ بفرست\n🎤 ویس/ویدیو بفرست تا شناسایی و ارسال شه\n📸 لینک اینستاگرام بفرست و فایل یا شناسایی رو انتخاب کن', { reply_markup: kb([[R('🔙 بازگشت', 'm:home')]]) });
    if (data === 'a:panel' && from.id === owner)
      return tg.editMessageText(cid, mid, '🛠 <b>پنل مدیریت</b>\n\nربات روی Cloudflare فعال است.', { reply_markup: kb([[R('🔙 بازگشت', 'm:home')]]) });
    return ans();
  }

  const m = u.message || {};
  if (!m.chat) return;
  const cid = m.chat.id, from = m.from || {};
  const text = String(m.text || m.caption || '').trim();

  if (text.startsWith('/start'))
    return tg.sendMessage(cid, welcomeText(env, from.first_name || ''), { reply_markup: menu(env, from.id === owner) });

  if (/instagram\.com|instagr\.am/i.test(text))
    return tg.sendMessage(cid, '📸 لینک اینستاگرام\n\nانتخاب کن:', { reply_markup: igButtons(text) });

  if (m.voice || m.audio || m.video || m.video_note) {
    await tg.sendChatAction(cid, 'typing');
    return recognizeMedia(env, tg, cid, token, m.voice || m.audio || m.video || m.video_note);
  }

  if (text) {
    await tg.sendChatAction(cid, 'typing');
    return searchAndList(env, tg, cid, text);
  }
}

async function activate(env, origin) {
  const token = v(env, 'BOT_TOKEN', '');
  if (!token) return { ok: false, error: 'BOT_TOKEN missing' };
  const tg = new TG(token);
  const secret = v(env, 'WEBHOOK_SECRET', FB.WEBHOOK_SECRET);
  const whp = '/wh/' + (await sha256Hex(secret)).slice(0, 24);
  const wh = origin.replace(/\/$/, '') + whp;
  try { await tg.deleteWebhook(); } catch (e) {}
  const res = await tg.setWebhook(wh, { secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
  const owner = Number(v(env, 'OWNER_ID', '0'));
  if (owner) try { await tg.sendMessage(owner, `✅ فعال شد\n${wh}`); } catch (e) {}
  return { ok: !!res.ok, wh, result: res };
}

const INDEX_HTML = `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Music Bot</title><body style="font-family:system-ui,Tahoma;text-align:center;margin-top:12%;background:#0d1117;color:#e6edf3"><h2>🎧 Music Bot</h2><p>Telegram music bot on Cloudflare Workers.</p><p><a style="color:#58a6ff" href="/activate">فعال‌سازی وب‌هوک /activate</a> · <a style="color:#58a6ff" href="/health">/health</a></p></body></html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let p = url.pathname.replace(/\/+$/, ''); if (p === '') p = '/';
    const token = v(env, 'BOT_TOKEN', '');
    const secret = v(env, 'WEBHOOK_SECRET', FB.WEBHOOK_SECRET);
    const whp = '/wh/' + (await sha256Hex(secret)).slice(0, 24);

    if (p === '/activate' || p === '/init' || p === '/setup')
      return new Response(JSON.stringify(await activate(env, url.origin), null, 2), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

    if (p === '/health') {
      try {
        const tg = new TG(token);
        const wi = await tg.getWebhookInfo();
        const me = await tg.getMe();
        return new Response(JSON.stringify({ ok: true, token: !!token, me: me.result || null, webhook: wi.result || wi }), { headers: { 'content-type': 'application/json' } });
      } catch (e) { return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { 'content-type': 'application/json' } }); }
    }

    if (p === '/')
      return new Response(INDEX_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });

    if (p === whp) {
      if (request.method === 'GET') return new Response('ok', { status: 200 });
      if (request.method !== 'POST') return new Response('method', { status: 405 });
      const tok = request.headers.get('x-telegram-bot-api-secret-token') || '';
      if (tok !== secret) return new Response('forbidden', { status: 403 });
      try {
        const u = await request.json();
        ctx.waitUntil(handle(env, u).catch(() => {}));
        return new Response('ok', { status: 200 });
      } catch (e) { return new Response('bad', { status: 400 }); }
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // Keep-alive: re-assert webhook if it drifted (cheap getWebhookInfo).
    try {
      const token = v(env, 'BOT_TOKEN', '');
      if (!token) return;
      const tg = new TG(token);
      const wi = await tg.getWebhookInfo();
      const secret = v(env, 'WEBHOOK_SECRET', FB.WEBHOOK_SECRET);
      const want = '/wh/' + (await sha256Hex(secret)).slice(0, 24);
      const pub = v(env, 'PUBLIC_URL', '');
      if (pub && wi && wi.result && !String(wi.result.url || '').includes(want))
        await activate(env, pub);
    } catch (e) {}
  },
};
