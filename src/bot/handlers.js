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
const { cleanTrackMeta } = require('../services/trackMeta');
const searchEngine = require('../services/searchEngine');
const { downloadAndSend } = require('./send');
const { processAudio } = require('./audio');

const SEARCH_PAGE = 7;

function sidOf(tr) { return sc.sidOf(tr); }
// uniform bidi-safe label: artist — title · mm:ss  (isolates dynamic parts)
function card(tr) {
  const m = cleanTrackMeta(tr);
  const dur = tr.duration || fmtDur(tr.duration_ms) || '';
  const label = `⁨${m.artist || '؟'}⁩ ⁨—⁩ ⁨${m.title || '؟'}⁩`;
  return `${label}${dur ? ' · ⁨' + persianDigits(dur) + '⁩' : ''}`;
}
function fmtDur(ms) { if (!ms) return ''; const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function persianDigits(value) { return String(value).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]); }

async function editOrReply(ctx, text, extra) {
  try { return await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...(extra || {}) }); } catch (_) { return null; }
}
async function answer(ctx, text, alert) {
  if (ctx.callbackQuery) { try { await ctx.answerCallbackQuery({ text, show_alert: !!alert }); } catch (_) {} return; }
  // no callback query: surface only alert/error messages as a real reply so
  // failures are never silent (status toasts like "downloading…" stay quiet).
  if (alert && text) { try { await ctx.reply(text); } catch (_) {} }
}

// ============ SCREENS ============
panel.register('menu', async (ctx, p, lang) => {
  const own = isOwner(ctx.from.id);
  const rows = [
    [URLB(t(lang, 'menu_addgroup'), `https://t.me/${config.botUsername}?startgroup=true&admin=delete_messages+pin_messages`, 'success')],
    [URLB(t(lang, 'menu_channel'), `https://t.me/${String(config.channel).replace('@', '')}`), B(t(lang, 'menu_lang'), 'm:lang')],
    [B('👥 دعوت دوستان', 'm:invite'), B(t(lang, 'menu_help'), 'm:help'), B(t(lang, 'menu_support'), 'm:support')],
  ];
  if (own) rows.push([B(t(lang, 'menu_admin'), 'a:panel')]);
  const welcome = String(t(lang, 'welcome', { name: '' })).replace('{bot}', ctx.botUsername || config.botUsername);
  const name = String(ctx.from.first_name || '').trim();
  return { text: fmt(welcome.replace('{name}', e(name))), keyboard: kb(rows) };
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

panel.register('invite', async (ctx, p, lang) => {
  const REF = require('../services/referral');
  const code = REF.codeFor(ctx.from.id);
  const link = REF.linkFor(ctx.from.id, config.botUsername);
  const s = REF.statsFor(ctx.from.id);
  const bar = '▰'.repeat(Math.min(5, s.verified % 6)) + '▱'.repeat(Math.max(0, 5 - Math.min(5, s.verified)));
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('با این ربات هر آهنگی رو پیدا و دانلود کن 🎵')}`;
  const text = [
    '👥 <b>دعوت دوستان</b>',
    '',
    '🔗 لینک اختصاصی شما:',
    `<code>${esc(link)}</code>`,
    '',
    `📊 دعوت‌شده: ${num(lang, s.invited)} · تأییدشده: ${num(lang, s.verified)} · امتیاز: ${num(lang, s.points)}`,
    s.tier && s.tier.name ? `🏅 سطح: ${s.tier.name} ${bar}` : `پیشرفت: ${bar}`,
  ].join('\n');
  return { text, keyboard: kb([[URLB('📤 اشتراک لینک', share)], [B('🏆 برترین‌ها', 'm:top')], [R(t(lang, 'back'), 'nav:back')]]) };
});

panel.register('top', async (ctx, p, lang) => {
  const REF = require('../services/referral');
  const list = REF.top(10);
  const lines = list.length ? list.map((x, i) => `${persianDigits(i + 1)}. ${esc(x.name)} — ${num(lang, x.n)}`) : ['هنوز دعوتی تأیید نشده است.'];
  return { text: `🏆 <b>برترین دعوت‌کننده‌ها</b>\n${lines.join('\n')}`, keyboard: kb([[R(t(lang, 'back'), 'nav:back')]]) };
});

panel.register('results', async (ctx, params, lang) => {
  const { q, page = 1, items, filter = 'pop' } = params;
  // sort by filter: pop = plays desc, new = created_at desc
  const sorted = [...items].sort((a, b) => filter === 'new'
    ? new Date(b.created_at || 0) - new Date(a.created_at || 0)
    : (b.plays || 0) - (a.plays || 0));
  const totalPages = Math.max(1, Math.ceil(sorted.length / SEARCH_PAGE));
  const pg = Math.min(Math.max(1, page), totalPages);
  const visible = sorted.slice((pg - 1) * SEARCH_PAGE, pg * SEARCH_PAGE);

  // buttons: title-only, full width; on duplicate titles within the page append
  // " · artist" to just the colliding ones.
  const metas = visible.map((tr) => cleanTrackMeta(tr));
  const dup = new Map();
  for (const m of metas) { const k = m.title || '?'; dup.set(k, (dup.get(k) || 0) + 1); }
  const rows = visible.map((tr, i) => {
    const m = metas[i];
    let label = m.title || tr.title || '؟';
    if ((dup.get(label) || 0) > 1 && m.artist) label += ` · ${m.artist}`;
    return [B(truncateVisual(label, 34), 'pick:' + sidOf(tr))];
  });

  // pagination row
  const nav = [];
  if (pg > 1) nav.push(B('◀️ قبلی', `pg:${pg - 1}`));
  nav.push(B(`${num(lang, pg)}/${num(lang, totalPages)}`, 'noop'));
  if (pg < totalPages) nav.push(B('بعدی ▶️', `pg:${pg + 1}`));
  if (totalPages > 1) rows.push(nav);

  // filter row
  const filtRow = [];
  const popBtn = filter === 'pop' ? G('🔥 محبوب', 'fl:pop') : B('🔥 محبوب', 'fl:pop');
  const newBtn = filter === 'new' ? G('🆕 جدید', 'fl:new') : B('🆕 جدید', 'fl:new');
  filtRow.push(popBtn, newBtn);
  const artists = [...new Set(metas.map((m) => m.artist).filter(Boolean))];
  if (artists.length === 1 && artists[0] && similarity(q, artists[0]) < 0.9) filtRow.push(B('🎤 همین خواننده', 'fl:artist'));
  rows.push(filtRow);
  rows.push([R('✖️ بستن', 'nav:close')]);

  const text = `🔎 <b>نتایج «${esc(q)}»</b>\n${num(lang, sorted.length)} آهنگ · صفحه ${num(lang, pg)} از ${num(lang, totalPages)}\n\n<blockquote>برای دریافت فایل، روی نام آهنگ بزن 👇</blockquote>`;
  return { text, keyboard: kb(rows) };
});

function truncateVisual(value, max) {
  const chars = Array.from(String(value));
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

panel.register('track', async (ctx, params, lang) => {
  const tr = await sc.track(params.sid);
  const meta = cleanTrackMeta(tr);
  const date = tr.created_at ? dateFmt(lang, new Date(tr.created_at)) + '  •  ' + dateGreg(lang, new Date(tr.created_at)) : null;
  const lines = [
    `🎵 <b>${esc(meta.title)}</b>`,
    `👤 ${esc(meta.artist)}`,
    meta.version ? `🔁 ${esc(meta.version)}` : null,
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
  const meta = [];
  if (d.album) meta.push(`💿 ${esc(d.album)}`);
  if (d.year) meta.push(`${esc(String(d.year))}`);
  const lines = [
    `🎧 <b>${esc(d.title || '?')}</b>`,
    `👤 ${esc(d.artist || '?')}${d.confidence != null ? ` · 🎯 اطمینان ${num(lang, Math.round(d.confidence))}٪` : ''}`,
    meta.length ? meta.join(' · ') : null,
  ].filter(Boolean);
  const q = `${d.artist || ''} ${d.title || ''}`.trim();
  const q64 = Buffer.from(q).toString('base64url').slice(0, 44);
  const rows = [
    [G('⬇️ دریافت فایل کامل', 'rdl:' + q64)],
    [B('🔎 مشابه', 'rsim:' + q64)],
    [R('✖️ بستن', 'nav:close')],
  ];
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

function featureOn(name) {
  const s = store.get('settings', 'features') || {};
  return s[name] !== false;
}

// ============ FLOWS ============
async function doSearch(ctx, q) {
  const t0 = Date.now();
  try { return await _doSearch(ctx, q); }
  finally { require('../core/perf').record('search', Date.now() - t0); }
}
async function _doSearch(ctx, q) {
  const lang = ctx.lang;
  if (!featureOn('search')) return editOrReply(ctx, t(lang, 'error_service'));
  const w = rl.check(ctx.from.id, 'search');
  if (w) { await editOrReply(ctx, t(lang, 'rate_limited', { wait: rl.fmtWait(w, lang, t) })); return; }
  const result = await searchEngine.search(q, lang);
  if (result.kind === 'invalid') return editOrReply(ctx, 'لطفاً نام آهنگ یا یک خط کوتاه از ترانه را بفرست.');
  if (result.kind === 'error') return editOrReply(ctx, '⚠️ سرویس جستجو موقتاً در دسترس نیست؛ چند لحظه بعد دوباره تلاش کن.');
  if (!result.items || !result.items.length) {
    if (result.query.lyric) return editOrReply(ctx, 'از روی این خط ترانه نتونستم آهنگ رو پیدا کنم؛ ویس یا ویدیوی آهنگ رو بفرست تا شناسایی کنم 🎤');
    return editOrReply(ctx, t(lang, 'no_results'));
  }
  let items = result.items.map((x) => ({ ...x.tr, _score: x.score }));
  // learned manual/previous picks get a small ranking boost
  const learning = store.get('settings', 'search_learning') || {};
  const learned = learning[normalize(q)];
  if (learned && learned.sid) items.sort((a,b) => (sc.sidOf(a) === learned.sid ? -1 : 0) - (sc.sidOf(b) === learned.sid ? -1 : 0));
  store.incrStats('search');
  const artistAliases = new Set((result.items || []).flatMap((x) => [cleanTrackMeta(x.tr).artist, x.tr.artist]).filter(Boolean).map((v) => normalize(v)));
  const queryTokens = normalize(q).split(/\s+/).filter(Boolean);
  const nonArtistTokens = queryTokens.filter((token) => ![...artistAliases].some((alias) => alias.split(/\s+/).includes(token)));
  const top = items[0], second = items[1];
  const exactDirect = top && sc.isPlayable(top) && top._score >= 0.92 && (!second || top._score - second._score >= 0.15) && nonArtistTokens.length > 0;
  if (exactDirect) {
    store.set('settings', 'search_learning', learnPick(learning, normalize(q), top));
    return runDownload(ctx, sc.sidOf(top));
  }
  await panel.show(ctx, 'results', { q, page: 1, items: items.slice(0, 15), owner: ctx.from.id, at: Date.now() }, { push: false });
}

function learnPick(map, q, tr) {
  const m = { ...map };
  const sid = sc.sidOf(tr);
  m[q] = { sid, artist: tr.artist, title: tr.title, count: ((m[q] && m[q].count) || 0) + 1, at: Date.now() };
  const keys = Object.keys(m);
  if (keys.length > 2000) delete m[keys[0]];
  return m;
}

// Rank results: playable (unencrypted mp3/progressive) first, then fuzzy relevance + popularity.
function rankResults(q, items) {
  const scored = items.map((tr) => {
    const meta = cleanTrackMeta(tr);
    const sim = Math.max(similarity(q, meta.title), similarity(q, `${meta.artist} ${meta.title}`), similarity(q, meta.artist));
    let s = sim * 10;
    if (sc.isPlayable(tr)) s += 6;                    // prefer actually-playable sources
    if (meta.isRemix && !/remix|ریمیکس/i.test(q)) s -= 2;
    const dur = tr.duration_ms || 0;
    if (dur && (dur < 45000 || dur > 15 * 60 * 1000)) s -= 1;
    s += Math.min(3, Math.log10((tr.plays || 0) + 1) / 2); // popularity, small weight
    return { tr, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.tr);
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
    require('../services/referral').maybeVerify(uid, (inviter, s) => ctx.api.sendMessage(inviter, `✅ یک دعوت شما تأیید شد! مجموع تأییدشده: ${s.verified}`));
  } catch (e) {
    log.warn('dl fail', e.code);
    // auto-alternate: if the source was encrypted/undecodable, try the next playable result.
    if (['ENCRYPTED', 'DURATION_MISMATCH', 'SILENT_AUDIO', 'PAYLOAD_TOO_LARGE'].includes(e.code) || /decod|encrypt|unusable|incomplete|silent|duration mismatch/.test(String(e.message))) {
      const ok = await tryAlternate(ctx, sid, lang);
      if (ok) return;
    }
    const msg = e.code === 'NOT_DOWNLOADABLE' ? t(lang, 'error_not_downloadable')
      : (e.code === 'PAYLOAD_TOO_LARGE' || e.code === 'TRACK_TOO_LONG') ? t(lang, 'error_too_large') : t(lang, 'error_generic');
    await answer(ctx, msg, true);
  } finally { globalDl.n--; userDl.set(uid, Math.max(0, (userDl.get(uid) || 1) - 1)); }
}

// Try alternate playable results for the same artist/title.
async function tryAlternate(ctx, failedSid, lang) {
  try {
    const failed = await sc.track(failedSid).catch(() => null);
    if (!failed) return false;
    const failedMeta = cleanTrackMeta(failed);
    const q = `${failedMeta.artist} ${failedMeta.title}`.trim();
    const d = await sc.search(q, 1, lang);
    const alts = (d.results || []).filter((r) => sc.isPlayable(r) && sc.sidOf(r) !== failedSid)
      .filter((r) => similarity(q, `${cleanTrackMeta(r).artist} ${cleanTrackMeta(r).title}`) >= 0.82);
    for (const alt of alts.slice(0, 4)) {
      try { await downloadAndSend(ctx, alt, lang); return true; } catch (_) { continue; }
    }
  } catch (_) {}
  return false;
}

async function doRecognize(ctx, fileRef) {
  const lang = ctx.lang;
  if (!featureOn('recog')) return editOrReply(ctx, t(lang, 'error_service'));
  const w = rl.check(ctx.from.id, 'recognize');
  if (w) { await editOrReply(ctx, t(lang, 'rate_limited', { wait: rl.fmtWait(w, lang, t) })); return; }
  const status = await editOrReply(ctx, t(lang, 'recognizing'));
  try {
    const d = await processAudio(ctx, fileRef, lang);
    if (!d || !d.found) { await editOrReply(ctx, t(lang, 'recognize_none')); return; }
    store.incrStats('rec');
    ctx.panelMsgId = status && status.message_id;
    if (Number(d.confidence || 0) >= 70) {
      const q = `${d.artist || ''} ${d.title || ''}`.trim();
      try {
        const found = await sc.search(q, 1, lang);
        const tr = (found.results || [])[0];
        if (tr) {
          if (status && status.message_id) await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
          return runDownload(ctx, sc.sidOf(tr));
        }
      } catch (_) {}
    }
    await panel.show(ctx, 'recog', { data: d }, { push: false });
  } catch (e) {
    log.warn('recog fail', e.code);
    const msg =
      e.code === 'NO_FFMPEG' ? t(lang, 'error_service')
      : e.code === 'NO_AUDIO' ? '⚠️ صدای قابل تشخیصی در این فایل پیدا نشد.'
      : e.code === 'UNSUPPORTED' ? t(lang, 'recognize_badformat')
      : e.code === 'BUSY' ? t(lang, 'processing')
      : t(lang, 'recognize_none');
    await editOrReply(ctx, msg);
  }
}

// INSTAGRAM: auto-download all items + a music button card.
async function doInsta(ctx, url) {
  const lang = ctx.lang;
  if (!featureOn('insta')) return editOrReply(ctx, t(lang, 'error_service'));
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
  ].filter((row) => row.length));
  setPanel(ctx.chat.id, ctx.from.id, { igData: d, igQuery: q });

  let sent = 0;
  const { InputFile } = require('grammy');
  // Send media directly by URL when small enough; otherwise relay in memory
  // (no disk). The worker's /download endpoint serves the real media bytes.
  for (const it of items.slice(0, 10)) {
    try {
      const v = pickVariant(it);
      if (!v) continue;
      const sel = { quality: v.quality, index: it.index };
      const mediaUrl = ig.downloadUrlFor(d.source_url, sel);
      const isVideo = it.type === 'video' || (v.mime || '').startsWith('video');
      const caption = it.type === 'video' ? '🎬 <b>Instagram</b>' : '🖼 <b>Instagram</b>';
      const size = Number(v.size || v.filesize || 0);
      // try direct URL first (<=20MB); fall back to in-memory relay (<=48MB)
      let sentOk = false;
      if (!size || size <= 20 * 1024 * 1024) {
        try {
          if (isVideo) await ctx.api.sendVideo(ctx.chat.id, mediaUrl, { caption, parse_mode: 'HTML', supports_streaming: true, reply_markup: control });
          else await ctx.api.sendPhoto(ctx.chat.id, mediaUrl, { caption, parse_mode: 'HTML', reply_markup: control });
          sentOk = true;
        } catch (e) { log.debug('ig url send failed, relaying', e.message); }
      }
      if (!sentOk) {
        const { buf } = await ig.fetchBuffer(d.source_url, sel, 48 * 1024 * 1024);
        const fname = v.filename || `instagram_${it.index}`;
        if (isVideo) await ctx.api.sendVideo(ctx.chat.id, new InputFile(buf, fname), { caption, parse_mode: 'HTML', supports_streaming: true, reply_markup: control });
        else await ctx.api.sendPhoto(ctx.chat.id, new InputFile(buf, fname), { caption, parse_mode: 'HTML', reply_markup: control });
      }
      sent++;
    } catch (e) { log.warn('ig item', e.message); }
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
  try {
    const v = pickVariant(item);
    const { buf } = await ig.fetchBuffer(d.source_url, { quality: v && v.quality, index: item.index }, 48 * 1024 * 1024);
    const { decodeMedia } = require('./audio');
    const pcm = await decodeMedia(buf, { ext: 'mp4', mime: 'video/mp4' });
    const rec = await sh.recognizeBySignature(pcm, { lyrics: true });
    if (!rec || !rec.found) { await ctx.reply(t(lang, 'recognize_none')); return; }
    store.incrStats('rec');
    ctx.panelMsgId = ctx.callbackQuery && ctx.callbackQuery.message && ctx.callbackQuery.message.message_id;
    await panel.show(ctx, 'recog', { data: rec }, { push: false });
  } catch (e) {
    log.warn('ig recognize fail', e.code || e.message);
    await ctx.reply(t(lang, 'recognize_none'));
  }
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
