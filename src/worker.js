'use strict';
// Cloudflare Worker adapter for the Music bot.
const I18N = {
  menu_search: { fa: '🔍 جستجوی موزیک', en: '🔍 Search music' },
  dl: { fa: '⬇️ دانلود', en: '⬇️ Download' },
  welcome: { fa: n => `🎧 <b>Music</b> | دستیار موزیک و دانلود\n\nسلام ${n} 👋 فقط کافیه چیزی بفرستی؛ بقیه‌اش با من 👇\n\n🔎 اسم خواننده یا آهنگ ← فایل موزیک\n🎼 یک خط از ترانه ← پیدا کردن آهنگ\n🎤 ویس، ویدیو یا فایل صوتی ← شناسایی آهنگ\n📸 لینک اینستاگرام ← ویدیو + موزیکش\n\n💡 در هر چتی نام آهنگ را برای inline جستجو کن.\n@SearcherMusiic_Bot اسم آهنگ`, en: n => `🎧 Music Bot\n\nHi ${n}!\nSend a song name/artist, voice/video to recognize or Instagram link.` },
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
  editMessageReplyMarkup(chat, mid, markup) { return this.call('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: markup }); }
  answerCallbackQuery(id, extra) { return this.call('answerCallbackQuery', { callback_query_id: id, ...(extra || {}) }); }
  sendAudio(chat, audio, extra) { return this.call('sendAudio', { chat_id: chat, parse_mode: 'HTML', ...(extra || {}) }); }
  sendVoice(chat, audio, extra) { return this.call('sendVoice', { chat_id: chat, parse_mode: 'HTML', ...(extra || {}) }); }
  sendVideo(chat, video, extra) { return this.call('sendVideo', { chat_id: chat, parse_mode: 'HTML', supports_streaming: true, ...(extra || {}) }); }
  sendPhoto(chat, photo, extra) { return this.call('sendPhoto', { chat_id: chat, parse_mode: 'HTML', ...(extra || {}) }); }
  getFile(file_id) { return this.call('getFile', { file_id }); }
}

async function scCall(env, path, params) {
  const base = (env.SOUNDCLOUD_API_URL || '').replace(/\/$/, '');
  if (!base) return { ok: false };
  const url = base + path + (params ? '?' + new URLSearchParams(params) : '');
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  try { return await r.json(); } catch { return { ok: false }; }
}

async function shCall(env, path, body, method = 'POST') {
  const base = (env.SHAZAM_API_URL || '').replace(/\/$/, '');
  if (!base) return { ok: false };
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', Accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try { return await r.json(); } catch { return { ok: false }; }
}

async function igCall(env, path, params) {
  const base = (env.INSTA_API_URL || '').replace(/\/$/, '');
  if (!base) return { ok: false };
  const url = base + path + (params ? '?' + new URLSearchParams(params) : '');
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  try { return await r.json(); } catch { return { ok: false }; }
}

async function search(env, q, page = 1) {
  const d = await scCall(env, '/api/v1/search', { q, page });
  return d.ok ? (d.results || []) : [];
}
const sid = (t) => String(t.sid || (t.id || '').replace(/^sc_/, ''));

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function kb(rows) { return { inline_keyboard: rows.filter((r) => r && r.length) }; }
const B = (t, c, style = 'primary') => ({ text: t, callback_data: c, style });
const G = (t, c) => ({ text: t, callback_data: c, style: 'success' });
const R = (t, c) => ({ text: t, callback_data: c, style: 'danger' });
const URLB = (t, url, style = 'primary') => ({ text: t, url, style });

function mainMenu(lang, isOwner) {
  const rows = [
    [URLB('➕ افزودن به گروه', `https://t.me/SEARCHERMUSIIC_BOT?startgroup=true&admin=delete_messages+pin_messages`, 'success')],
    [URLB('📢 کانال اصلی', 'https://t.me/MusicMsvD'), B('🌐 زبان', 'm:lang')],
    [B('👥 دعوت دوستان', 'm:invite'), B('ℹ️ راهنما', 'm:help'), B('📞 پشتیبانی', 'm:support')],
  ];
  if (isOwner) rows.push([R('🛠 پنل مدیریت', 'a:panel')]);
  return kb(rows);
}

async function sendTrack(env, tg, cid, tr, extra = {}) {
  const sidv = sid(tr);
  const scBase = (env.SOUNDCLOUD_API_URL || '').replace(/\/$/, '');
  const title = tr.title || '';
  const performer = tr.artist || '';
  const dur = Math.round((tr.duration_ms || tr.duration || 0) / 1000) || undefined;
  const url = scBase ? `${scBase}/api/v1/stream?id=${encodeURIComponent(sidv)}` : '';
  try {
    await tg.sendAudio(cid, url, { title, performer, duration: dur, ...extra });
    return true;
  } catch (e) {}
  try {
    const durl = scBase ? `${scBase}/api/v1/download?id=${encodeURIComponent(sidv)}` : '';
    await tg.sendAudio(cid, durl, { title, performer, duration: dur, ...extra });
    return true;
  } catch (e) {}
  return false;
}

async function recognizeViaShazam(env, tg, cid, file_id) {
  const gf = await tg.getFile(file_id);
  if (!gf.ok || !gf.result || !gf.result.file_path) throw new Error('getFile');
  const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${gf.result.file_path}`;
  const buf = await fetch(fileUrl).then(r => r.arrayBuffer());
  const u8 = new Uint8Array(buf);
  const b64 = btoa(String.fromCharCode.apply(null, u8));
  let d = await shCall(env, '/api/v1/recognize', { audio: b64, format: 'auto' });
  if (!(d.ok && d.data) && !d.found) {
    d = await shCall(env, '/api/v1/recognize', { pcm: b64, sample_rate: 16000 });
  }
  if (!(d.ok && d.data) && !d.found) {
    d = await shCall(env, '/api/v1/recognize', { url: fileUrl });
  }
  if ((d.ok && d.data && d.data.found) || d.found || (d.data && d.data.artist)) {
    const data = d.data || d;
    return { found: true, title: data.title, artist: data.artist, track: data.track };
  }
  if (d && d.track) return { found: true, title: d.track.title, artist: d.track.subtitle || d.track.artist, track: d.track };
  return { found: false };
}

async function handleUpdate(env, ctx, u) {
  const tg = new TG(env.BOT_TOKEN);
  const isOwner = Number((u.message?.from?.id) || (u.callback_query?.from?.id)) === Number(env.OWNER_ID);

  if (u.callback_query) {
    const cq = u.callback_query;
    const cid = cq.message.chat.id;
    const mid = cq.message.message_id;
    const from = cq.from;
    const data = cq.data || '';
    const answer = (t, a) => tg.answerCallbackQuery(cq.id, { text: t, show_alert: a });
    if (data === 'noop') return answer();
    if (data.startsWith('trk:')) {
      await answer('⏳');
      const tr = await scCall(env, '/api/v1/track', { id: data.slice(4) }).then(d => d.ok && d.track);
      if (!tr) return answer('خطا', true);
      await sendTrack(env, tg, cid, tr, { caption: `🎵 <b>${esc(tr.title)}</b>\n👤 ${esc(tr.artist)}`, parse_mode: 'HTML' });
      return;
    }
    if (data.startsWith('dl:')) {
      await answer('⏳ در حال ارسال مستقیم...');
      const tr = await scCall(env, '/api/v1/track', { id: data.slice(3) }).then(d => d.ok && d.track);
      if (!tr) return answer('خطا', true);
      await sendTrack(env, tg, cid, tr, { caption: `🎵 <b>${esc(tr.title)}</b>\n👤 ${esc(tr.artist)}`, parse_mode: 'HTML' });
      return;
    }
    if (data.startsWith('igf:')) {
      await answer('⏳');
      try {
        const url = Buffer.from(data.slice(4), 'base64url').toString();
        const r = await igCall(env, '/resolve', { url });
        const items = (r.ok && r.data && r.data.items) || r.items || [];
        if (!items.length) return answer('خطا', true);
        for (const it of items) {
          const v = (it.variants || [])[0];
          if (!v || !v.url) continue;
          if (it.type === 'video' || (v.mime||'').includes('video')) {
            try { await tg.sendVideo(cid, v.url, { caption: '🎬 <b>Instagram</b>' }); continue; } catch {}
            try { await tg.sendVideo(cid, env.INSTA_API_URL + '/proxy?url=' + encodeURIComponent(v.url), { caption: '🎬 <b>Instagram</b>' }); continue; } catch {}
          }
          try { await tg.sendPhoto(cid, v.url, { caption: '🖼 <b>Instagram</b>' }); } catch {
            try { await tg.sendPhoto(cid, env.INSTA_API_URL + '/proxy?url=' + encodeURIComponent(v.url), { caption: '🖼 <b>Instagram</b>' }); } catch {}
          }
        }
      } catch (e) { answer('خطا', true); }
      return;
    }
    if (data.startsWith('igm:')) {
      await answer('⏳');
      try {
        const q = Buffer.from(data.slice(4), 'base64url').toString();
        const results = await search(env, q);
        const tr = results[0];
        if (!tr) return answer('پیدا نشد', true);
        await sendTrack(env, tg, cid, tr, { caption: `🎵 <b>${esc(tr.title)}</b>\n👤 ${esc(tr.artist)}` });
      } catch { answer('خطا', true); }
      return;
    }
    if (data.startsWith('igr:')) {
      await answer('🎤 در حال شناسایی...');
      try {
        const url = Buffer.from(data.slice(4), 'base64url').toString();
        const r = await igCall(env, '/resolve', { url });
        const items = (r.ok && r.data && r.data.items) || r.items || [];
        const it = items.find(x => x.type === 'video' || (x.variants||[]).some(v=>(v.mime||'').includes('video')));
        if (!it) return answer('ویدیو پیدا نشد', true);
        const v = (it.variants||[]).find(x=>x.url) || it.variants[0];
        const vurl = v.url;
        const gf = await fetch(env.INSTA_API_URL + '/download?url=' + encodeURIComponent(vurl)).then(x=>x.arrayBuffer()).catch(()=>null);
        if (!gf) return answer('خطا در دریافت فایل', true);
        const b64 = btoa(String.fromCharCode.apply(null, new Uint8Array(gf)));
        let rec = await shCall(env, '/api/v1/recognize', { audio: b64, format: 'mp4' });
        if (!(rec.ok && rec.data && rec.data.found)) rec = await shCall(env, '/api/v1/recognize', { audio: b64, format: 'auto' });
        const data = (rec.ok && rec.data) || rec;
        if (!data.found && !data.artist) return tg.sendMessage(cid, '❌ آهنگی شناسایی نشد.');
        const q = `${data.artist||''} ${data.title||''}`.trim();
        const results = await search(env, q);
        const tr = results[0];
        if (tr) {
          await sendTrack(env, tg, cid, tr, { caption: `🎵 <b>${esc(tr.title)}</b>\n👤 ${esc(tr.artist)}` });
        } else {
          tg.sendMessage(cid, `🎤 شناسایی شد:\n<b>${esc(data.title)}</b>\n👤 ${esc(data.artist)}`);
        }
      } catch { answer('خطا', true); }
      return;
    }
    if (data === 'nav:back' || data === 'm:home') return tg.editMessageText(cid, mid, I18N.welcome.fa(from.first_name || ''), { reply_markup: mainMenu(from.language_code === 'en' ? 'en' : 'fa', isOwner) });
    if (data === 'm:lang') return tg.editMessageText(cid, mid, '🌐 زبان را انتخاب کن:', { reply_markup: kb([[B('فارسی', 'lang:fa', 'success'), B('English', 'lang:en')],[B('🔙 بازگشت', 'm:home')]]) });
    if (data === 'm:invite') return tg.editMessageText(cid, mid, `👥 <b>دعوت دوستان</b>\n\nلینک اختصاصی شما:\n<code>https://t.me/SEARCHERMUSIIC_BOT?start=ref_${from.id}</code>`, { reply_markup: kb([[URLB('📤 اشتراک‌گذاری', `https://t.me/share/url?url=${encodeURIComponent('https://t.me/SEARCHERMUSIIC_BOT?start=ref_' + from.id)}&text=${encodeURIComponent('با این ربات هر آهنگی رو پیدا و دانلود کن 🎵')}`, 'success')],[B('🔙 بازگشت', 'm:home')]]) });
    if (data === 'm:support') return tg.editMessageText(cid, mid, '💬 <b>پشتیبانی</b>\n\nبرای سوال، پیشنهاد یا گزارش مشکل:\n@AliMsvD', { reply_markup: kb([[B('🔙 بازگشت', 'm:home')]]) });
    if (data === 'm:help') return tg.editMessageText(cid, mid, 'ℹ️ <b>راهنما</b>\n\n🔎 اسم آهنگ یا خواننده بفرست\n🎤 ویس، ویدیو یا فایل صوتی بفرست تا شناسایی شه\n📸 لینک اینستاگرام بفرست\n💡 در هر چت با @SEARCHERMUSIIC_BOT جستجو کن', { reply_markup: kb([[B('🔙 بازگشت', 'm:home')]]) });
    if (data.startsWith('lang:')) { await answer('زبان تغییر کرد'); return tg.editMessageText(cid, mid, I18N.welcome.fa(from.first_name || ''), { reply_markup: mainMenu('fa', isOwner) }); }
    return answer();
  }

  const m = u.message || {};
  const cid = m.chat.id;
  const from = m.from || {};
  const text = (m.text || m.caption || '').trim();

  if (text.startsWith('/start')) {
    const arg = text.split(/\s+/)[1] || '';
    if (arg.startsWith('t_')) {
      const tr = await scCall(env, '/api/v1/track', { id: arg.slice(2) }).then(d => d.ok && d.track);
      if (tr) return sendTrack(env, tg, cid, tr, { caption: `🎵 <b>${esc(tr.title)}</b>\n👤 ${esc(tr.artist)}` });
    }
    return tg.sendMessage(cid, I18N.welcome.fa(from.first_name || ''), { reply_markup: mainMenu('fa', isOwner) });
  }
  if (text === '/help') return tg.sendMessage(cid, 'ℹ️ اسم آهنگ بفرست یا ویس/ویدیو بفرست تا شناسایی کنم.', { reply_markup: mainMenu('fa', isOwner) });

  // Instagram link
  if (/instagram\.com|instagr\.am/i.test(text)) {
    await tg.sendChatAction(cid, 'typing');
    const q64 = btoa(unescape(encodeURIComponent(text))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const rows = [[G('🎬 دریافت فایل(ها)', `igf:${q64}`)],[G('🎤 شناسایی موزیک ویدیو', `igr:${q64}`)],[B('🔍 جستجو در ساندکلود', `igm:${q64.slice(0,40)}`)]];
    return tg.sendMessage(cid, '📸 لینک اینستاگرام دریافت شد\n\nیکی از گزینه‌ها رو انتخاب کن:', { reply_markup: kb(rows) });
  }

  // Voice / Audio / Video -> recognize via Shazam worker
  if (m.voice || m.audio || m.video || m.video_note) {
    await tg.sendChatAction(cid, 'typing');
    const f = m.voice || m.audio || m.video || m.video_note;
    try {
      const rec = await recognizeViaShazam(env, tg, cid, f.file_id);
      if (rec.found && rec.artist && rec.title) {
        const q = `${rec.artist} ${rec.title}`;
        const results = await search(env, q);
        const tr = results[0];
        if (tr) {
          await tg.sendMessage(cid, `🎤 <b>شناسایی شد</b>\n🎵 ${esc(tr.title)}\n👤 ${esc(tr.artist)}`);
          return sendTrack(env, tg, cid, tr);
        }
        await tg.sendMessage(cid, `🎤 <b>شناسایی شد</b>\n🎵 ${esc(rec.title)}\n👤 ${esc(rec.artist)}`);
        const r2 = await search(env, rec.title);
        const tr2 = r2[0];
        if (tr2) return sendTrack(env, tg, cid, tr2);
        return;
      }
      return tg.sendMessage(cid, '❌ نتوانستم آهنگ رو شناسایی کنم.\nلطفاً ویس واضح‌تر یا فایل با کیفیت بهتر بفرست.');
    } catch (e) {
      return tg.sendMessage(cid, '⚠️ خطا در شناسایی. کمی بعد امتحان کن.');
    }
  }

  // Text search
  if (text) {
    await tg.sendChatAction(cid, 'typing');
    const results = await search(env, text);
    if (!results.length) return tg.sendMessage(cid, '❌ چیزی پیدا نشد.');
    const rows = results.slice(0, 10).map(tr => [G(`${tr.artist} — ${tr.title}`.slice(0, 48), 'dl:' + sid(tr))]);
    rows.push([B('🔍 جستجوی بیشتر', 'm:search')]);
    return tg.sendMessage(cid, `🔎 نتایج برای «${esc(text)}»\nروی موزیک کلیک کن تا مستقیم ارسال شه:`, { reply_markup: kb(rows) });
  }
}

function mainMenu(lang, isOwner) {
  const rows = [
    [URLB('➕ افزودن به گروه', `https://t.me/SEARCHERMUSIIC_BOT?startgroup=true&admin=delete_messages+pin_messages`, 'success')],
    [URLB('📢 کانال اصلی', 'https://t.me/MusicMsvD'), B('🌐 زبان', 'm:lang')],
    [B('👥 دعوت دوستان', 'm:invite'), B('ℹ️ راهنما', 'm:help'), B('📞 پشتیبانی', 'm:support')],
  ];
  if (isOwner) rows.push([R('🛠 پنل مدیریت', 'a:panel')]);
  return kb(rows);
}

async function cronTick(env) {
  const tg = new TG(env.BOT_TOKEN);
  const q = await env.KV.get('post_queue', 'json') || [];
  if (!q.length) return;
  const chans = await env.KV.get('channels', 'json') || [];
  const item = q[0];
  for (const ch of chans) {
    const tr = item.tr;
    const caption = `🎵 <b>${esc(tr.title)}</b>\n👤 ${esc(tr.artist)}`;
    try { await tg.call('sendPhoto', { chat_id: ch.id, photo: tr.cover, caption, parse_mode: 'HTML' }); } catch (_) {}
  }
  q.shift();
  await env.KV.put('post_queue', JSON.stringify(q));
}

module.exports = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const whPath = '/wh/' + (await sha256Hex(env.WEBHOOK_SECRET || 'x')).slice(0, 24);
    if (url.pathname === '/health') return Response.json({ ok: true, ts: Date.now() });
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
