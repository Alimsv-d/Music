// Host-parity message + flow handlers (Bot-Mousavi behavior on Cloudflare).
// UI and flow semantics mirror the host version (cpanel-app); services and
// storage are reused from our Worker architecture (no grammY dependency).

import { t, esc, iso, num, vtruncate, truncateVisual, dateFmt, dateGreg } from "../i18n/index.js";
import { kb, btn, G, B, R, URLB, inlineBtn } from "../ui/keyboards.js";
import { normalize, similarity, extractInstagramUrl, extractSoundCloudUrl } from "../utils/text.js";
import { pickMedia } from "./recognize.js";

// ── tiny helpers ────────────────────────────────────────────────────────────
const SEARCH_PAGE = 10;
const enc = new TextEncoder();

function cardLabel(tr) {
  const artist = tr.artist || "؟";
  const title = tr.title || "؟";
  const dur = tr.duration || fmtDur(tr.duration_ms) || "";
  return `${artist} — ${title}${dur ? ` · ${dur}` : ""}`;
}
function chooseSoundCloudMatch(items, artist, title) {
  const list = Array.isArray(items) ? items : (items?.results || []);
  const target = normalize(`${artist || ""} ${title || ""}`);
  const scored = list.map((tr) => ({ tr, score: Math.max(similarity(target, `${tr.artist || ""} ${tr.title || ""}`), similarity(title || "", tr.title || ""), similarity(artist || "", tr.artist || "")) }))
    .filter((x) => x.tr && x.score >= 0.55)
    .sort((a, b) => (b.score - a.score) || Number(b.tr.downloadable) - Number(a.tr.downloadable) || (b.tr.plays || 0) - (a.tr.plays || 0));
  return scored.find((x) => x.tr.downloadable || x.tr.streamable) ?.tr || scored[0]?.tr || null;
}
function fmtDur(ms) { if (!ms) return ""; const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function perDigits(v) { return String(v).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]); }
function compact(tr) {
  return { id: tr.id, source: tr.source, title: tr.title, artist: tr.artist, album: tr.album,
           year: tr.year, duration_ms: tr.duration_ms, artwork: tr.artwork, cover: tr.cover,
           downloadUrl: tr.downloadUrl, streamUrl: tr.streamUrl, pageUrl: tr.pageUrl,
           plays: tr.plays, genre: tr.genre, created_at: tr.created_at, sid: tr.sid };
}
function sidOf(tr) { return String(tr.sid || String(tr.id || "").replace(/^sc_/, "")); }
function q64(q) { const b = new Uint8Array(enc.encode(q)); let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""); }
function unq64(s) { try { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); } catch { return ""; } }
const escH = esc;
async function editOrReply(ctx, chatId, msgId, text, extra = {}) {
  if (msgId) {
    try {
      if (extra.media) {
        await ctx.tg.call("editMessageMedia", { chat_id: chatId, message_id: msgId, media: { type: "photo", media: extra.media, caption: text, parse_mode: "HTML" }, reply_markup: extra.reply_markup });
        return { message_id: msgId };
      }
      await ctx.tg.editMessageText(chatId, msgId, text, { parse_mode: "HTML", reply_markup: extra.reply_markup, disable_web_page_preview: true });
      return { message_id: msgId };
    } catch {}
  }
  const m = extra.media
    ? await ctx.tg.sendPhoto(chatId, { photo: extra.media, caption: text, parse_mode: "HTML", reply_markup: extra.reply_markup }).catch(() => null)
    : await ctx.tg.sendMessage(chatId, text, { reply_markup: extra.reply_markup, reply_to_message_id: extra.reply_to_message_id });
  return m;
}
async function answer(ctx, cq, text, alert) {
  try { await ctx.tg.answerCallbackQuery(cq.id, { text: text || "", show_alert: !!alert }); } catch {}
}
async function reply(ctx, chatId, text, extra) { return ctx.tg.sendMessage(chatId, text, extra).catch(() => null); }
async function status(ctx, chatId, text) { return ctx.tg.sendMessage(chatId, text).catch(() => null); }
async function delMsg(ctx, chatId, mid) { if (mid) ctx.tg.deleteMessage(chatId, mid).catch(() => {}); }

// ── store shims (host tables -> KV prefixes) ────────────────────────────────
const H = {
  get: (ctx, table, key) => ctx.store.get(`${table}:${key}`),
  set: (ctx, table, key, v) => ctx.store.put(`${table}:${key}`, v),
  del: (ctx, table, key) => ctx.store.del(`${table}:${key}`),
  incrStat: (ctx, m) => ctx.exec.waitUntil(ctx.store.bump(m)),
};

async function favList(ctx, uid) { return (await H.get(ctx, "favorites", uid)) || []; }
async function isFav(ctx, uid, sid) { return (await favList(ctx, uid)).some((x) => String(x.sid) === String(sid)); }
async function toggleFav(ctx, uid, tr) {
  const l = await favList(ctx, uid); const sid = String(sidOf(tr));
  const i = l.findIndex((x) => String(x.sid) === sid);
  if (i >= 0) l.splice(i, 1); else l.push({ sid, title: tr.title, artist: tr.artist });
  await H.set(ctx, "favorites", uid, l.slice(-100));
}
async function pushHist(ctx, uid, tr) {
  const l = (await H.get(ctx, "history", uid)) || []; const sid = String(sidOf(tr));
  const i = l.findIndex((x) => String(x.sid) === sid); if (i >= 0) l.splice(i, 1);
  l.push({ sid, title: tr.title, artist: tr.artist });
  await H.set(ctx, "history", uid, l.slice(-50));
}

// ── rate limit (host buckets; per-user KV windows + escalation) ─────────────
const BUCKETS = { action: { limit: 8, window: 10 }, search: { limit: 1, window: 2 }, download: { limit: 6, window: 60 }, recognize: { limit: 4, window: 60 }, group: { limit: 20, window: 60 }, ticket: { limit: 3, window: 3600 } };
const PENALTIES = [60, 600, 3600, 86400];
const botIdentity = new Map();
async function isReplyToThisBot(ctx, msg) {
  const from = msg.reply_to_message?.from;
  if (!from?.is_bot) return false;
  const configured = String(ctx.env.BOT_USERNAME || "").replace(/^@/, "").toLowerCase();
  if (configured && String(from.username || "").toLowerCase() === configured) return true;
  if (from.id && botIdentity.get(ctx.env.BOT_TOKEN) === from.id) return true;
  if (!botIdentity.has(ctx.env.BOT_TOKEN)) {
    try { const me = await ctx.tg.getMe(); if (me?.id) botIdentity.set(ctx.env.BOT_TOKEN, me.id); return me?.id === from.id; } catch {}
  }
  return false;
}
async function groupAddressed(ctx, msg, text) {
  const botName = String(ctx.env.BOT_USERNAME || "").replace(/^@/, "").toLowerCase();
  return Boolean((botName && text.toLowerCase().includes(`@${botName}`)) || await isReplyToThisBot(ctx, msg));
}
async function rlCheck(ctx, uid, bucket) {
  const role = await ctx.roleOf(uid);
  if (role !== "user") return null;
  const cfg = BUCKETS[bucket] || BUCKETS.action;
  const now = Date.now();
  const key = `rlx:${uid}:${bucket}`;
  const cur = (await H.get(ctx, "rlx", `${uid}:${bucket}`)) || { n: 0, win: 0, pen: 0 };
  if (cur.pen && now < cur.pen) return Math.ceil((cur.pen - now) / 1000);
  if (cur.win !== Math.floor(now / (cfg.window * 1000))) { cur.win = Math.floor(now / (cfg.window * 1000)); cur.n = 0; }
  cur.n++;
  if (cur.n > cfg.limit) {
    cur.pen = now + PENALTIES[Math.min((cur.penCount || 0), PENALTIES.length - 1)] * 1000;
    cur.penCount = (cur.penCount || 0) + 1;
    cur.n = 0;
    await H.set(ctx, "rlx", `${uid}:${bucket}`, cur);
    return Math.ceil((cur.pen - now) / 1000);
  }
  await H.set(ctx, "rlx", `${uid}:${bucket}`, cur);
  return null;
}
function fmtWait(sec) { return sec >= 3600 ? `${Math.ceil(sec / 3600)} ساعت` : sec >= 60 ? `${Math.ceil(sec / 60)} دقیقه` : `${sec} ثانیه`; }

// ── forced join (host semantics) ────────────────────────────────────────────
const FJ_CACHE = new Map();
async function missingChannels(ctx, uid) {
  const cfg = (await H.get(ctx, "settings", "global")) || {};
  let gates = cfg.forcejoin;
  if (!gates) return [];
  if (!Array.isArray(gates)) gates = [gates];
  const list = [];
  for (const g of gates) {
    if (!g || g.enabled === false) continue;
    if (g.bot_link) { list.push({ ...g, ok: false, unverifiable: true }); continue; }
    const key = `${uid}:${g.id || g.username}`;
    const hit = FJ_CACHE.get(key);
    if (hit && Date.now() - hit.at < (hit.ok ? 45000 : 5000)) { if (!hit.ok) list.push(g); continue; }
    let ok = false;
    try {
      const m = await ctx.tg.getChatMember(g.id || g.username, uid);
      ok = ["member", "administrator", "creator"].includes(m.status) || (m.status === "restricted" && m.is_member !== false);
    } catch { ok = false; }
    FJ_CACHE.set(key, { ok, at: Date.now() });
    if (!ok) list.push(g);
  }
  return list;
}
async function gateCheck(ctx, msg, lang) {
  const uid = msg.from?.id; if (!uid) return true;
  const role = await ctx.roleOf(uid);
  if (role === "owner") return true;
  const missing = await missingChannels(ctx, uid);
  if (!missing.length) return true;
  const isGroup = ctx.isGroupChat(msg.chat.type);
  const rows = missing.map((c) => {
    const url = c.invite || (c.username ? `https://t.me/${String(c.username).replace(/^@/, "")}` : `https://t.me/c/${String(c.id).replace(/^-100/, "")}`);
    return [URLB(`📢 ${c.title || c.username || c.id}`, url, "success")];
  });
  rows.push([B(t(lang, "btn_check"), "fj:check")]);
  const noticeKey = `fjnotice:${isGroup ? msg.chat.id : uid}`;
  const last = FJ_CACHE.get(noticeKey)?.at || 0;
  if (!isGroup || Date.now() - last > 600000) {
    FJ_CACHE.set(noticeKey, { at: Date.now() });
    const sent = await ctx.tg.sendMessage(msg.chat.id, t(lang, "forcejoin_msg"), { reply_markup: kb(rows) }).catch(() => null);
    if (sent && isGroup) ctx.exec.waitUntil((async () => { await new Promise((r) => setTimeout(r, 30000)); delMsg(ctx, msg.chat.id, sent.message_id); })());
  }
  return false;
}

// ══ SCREENS (panel views) ══════════════════════════════════════════════════
const SCREENS = {
  menu: async (ctx, p, lang, cq) => {
    const uid = cq?.from?.id || p.uid;
    const own = (await ctx.roleOf(uid)) === "owner";
    const chan = ctx.env.CHANNEL || ctx.env.OWNER_USERNAME || "";
    const chanUser = String(chan).replace(/^@/, "");
    const rows = [
      [URLB(t(lang, "menu_addgroup"), `https://t.me/${ctx.env.BOT_USERNAME}?startgroup=true&admin=delete_messages+pin_messages`, "success")],
      [URLB(t(lang, "menu_channel"), `https://t.me/${chanUser}`), B(t(lang, "menu_lang"), "m:lang")],
      [B("👥 دعوت دوستان", "m:invite"), B(t(lang, "menu_help"), "m:help"), B(t(lang, "menu_support"), "m:support")],
    ];
    if (own) rows.push([B(t(lang, "menu_admin"), "a:panel")]);
    const name = escH(String(cq?.from?.first_name || p.name || ""));
    const welcome = String(t(lang, "welcome_host", { name, bot: ctx.env.BOT_USERNAME }));
    return { text: welcome.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>"), keyboard: kb(rows) };
  },
  help: async (ctx, p, lang) => ({ text: `${t(lang, "help_text")}\n\n${t(lang, "about_text_host", { owner: escH(ctx.env.CREATOR_NAME || "Ali Mousavi"), user: "@" + (ctx.env.OWNER_USERNAME || "AliMsvD") })}`, keyboard: kb([[R(t(lang, "back"), "nav:back")]]) }),
  lang: async (ctx, p, lang) => ({ text: t(lang, "lang_title"), keyboard: kb([[B("فارسی", "lang:fa"), B("English", "lang:en")], [R(t(lang, "back"), "nav:back")]]) }),
  invite: async (ctx, p, lang, cq) => {
    const uid = cq?.from?.id || p.uid;
    const code = `ref_${uid}`;
    const link = `https://t.me/${ctx.env.BOT_USERNAME}?start=${code}`;
    const s = (await H.get(ctx, "referral", uid)) || { invited: 0, verified: 0, points: 0 };
    const bar = "▰".repeat(Math.min(5, s.verified)) + "▱".repeat(Math.max(0, 5 - Math.min(5, s.verified)));
    const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("با این ربات هر آهنگی رو پیدا و دانلود کن 🎵")}`;
    const text = ["👥 <b>دعوت دوستان</b>", "", "🔗 لینک اختصاصی شما:", `<code>${escH(link)}</code>`, "", `📊 دعوت‌شده: ${num(lang, s.invited)} · تأییدشده: ${num(lang, s.verified)} · امتیاز: ${num(lang, s.points)}`, `پیشرفت: ${bar}`].join("\n");
    return { text, keyboard: kb([[URLB("📤 اشتراک لینک", share)], [B("🏆 برترین‌ها", "m:top")], [R(t(lang, "back"), "nav:back")]]) };
  },
  top: async (ctx, p, lang) => {
    const rows = await ctx.store.listWithPrefix("referral:");
    const users = rows.map((r) => ({ id: r.key, ...(r.value || {}) })).filter((r) => r.verified > 0).sort((a, b) => b.verified - a.verified).slice(0, 10);
    const names = await Promise.all(users.map(async (u) => { const ur = await ctx.store.getUser(u.id.replace(/^ref_/, "")); return `${ur?.first_name || u.id.replace(/^ref_/, "")}`; }));
    const lines = users.length ? users.map((u, i) => `${perDigits(i + 1)}. ${escH(names[i])} — ${num(lang, u.verified)}`) : ["هنوز دعوتی تأیید نشده است."];
    return { text: `🏆 <b>برترین دعوت‌کننده‌ها</b>\n${lines.join("\n")}`, keyboard: kb([[R(t(lang, "back"), "nav:back")]]) };
  },
  results: async (ctx, params, lang) => {
    const { q, page = 1, items, filter = "pop" } = params;
    const sorted = [...items].sort((a, b) => filter === "new" ? new Date(b.created_at || 0) - new Date(a.created_at || 0) : (b.plays || 0) - (a.plays || 0));
    const totalPages = Math.max(1, Math.ceil(sorted.length / SEARCH_PAGE));
    const pg = Math.min(Math.max(1, page), totalPages);
    const visible = sorted.slice((pg - 1) * SEARCH_PAGE, pg * SEARCH_PAGE);
    const dup = new Map();
    for (const tr of visible) { const k = tr.title || "?"; dup.set(k, (dup.get(k) || 0) + 1); }
    const rows = visible.map((tr) => {
      let label = tr.title || "؟";
      if ((dup.get(label) || 0) > 1 && tr.artist) label += ` · ${tr.artist}`;
      return [B(truncateVisual(label, 34), `pick:${sidOf(tr)}:${params.owner || 0}`)];
    });
    const nav = [];
    if (pg > 1) nav.push(B("◀️ قبلی", `pg:${pg - 1}`));
    nav.push(B(`${num(lang, pg)}/${num(lang, totalPages)}`, "noop"));
    if (pg < totalPages) nav.push(B("بعدی ▶️", `pg:${pg + 1}`));
    if (totalPages > 1) rows.push(nav);
    const filt = [filter === "pop" ? G("🔥 محبوب", "fl:pop") : B("🔥 محبوب", "fl:pop"), filter === "new" ? G("🆕 جدید", "fl:new") : B("🆕 جدید", "fl:new")];
    const artists = [...new Set(visible.map((x) => x.artist).filter(Boolean))];
    if (artists.length === 1 && similarity(q, artists[0]) < 0.9) filt.push(B("🎤 همین خواننده", "fl:artist"));
    rows.push(filt, [R("✖️ بستن", "nav:close")]);
    return { text: `🔎 <b>نتایج «${escH(q)}»</b>\n${num(lang, sorted.length)} آهنگ · صفحه ${num(lang, pg)} از ${num(lang, totalPages)}\n\n<blockquote>برای دریافت فایل، روی نام آهنگ بزن 👇</blockquote>`, keyboard: kb(rows) };
  },
  track: async (ctx, params, lang) => {
    const tr = params.tr || (await ctx.sc.track(params.sid).catch(() => null)) || {};
    const sid = sidOf(tr);
    const date = tr.created_at ? `${dateFmt(lang, new Date(tr.created_at))}  •  ${dateGreg(lang, new Date(tr.created_at))}` : null;
    const lines = [`🎵 <b>${escH(tr.title || "")}</b>`, `👤 ${escH(tr.artist || "")}`, tr.version ? `🔁 ${escH(tr.version)}` : null, date ? `📅 ${iso(escH(date))}` : null, (tr.duration || tr.duration_ms) ? `⏱ ${escH(tr.duration || fmtDur(tr.duration_ms))}` : null, tr.genre ? `🏷 ${escH(tr.genre)}` : null, tr.plays ? `🎧 ${num(lang, tr.plays)}` : null].filter(Boolean);
    const fav = await isFav(ctx, params.uid || 0, sid);
    const rows = [
      [G(t(lang, "dl"), `dl:${sid}`)],
      [B(t(lang, "lyrics"), `lyr:${sid}`), B(t(lang, "similar"), `sim:${sid}`)],
      [fav ? B(t(lang, "fav_del"), `favd:${sid}`) : B(t(lang, "fav_add"), `fava:${sid}`), URLB("🔗", tr.page_url || tr.pageUrl || "https://soundcloud.com")],
      [R(t(lang, "back"), "nav:back")],
    ];
    return { text: lines.join("\n"), keyboard: kb(rows), media: tr.cover ? ctx.sc.coverUrl(tr.cover) : tr.artwork || null };
  },
  lyrics: async (ctx, params, lang) => {
    const tr = params.tr || (await ctx.sc.track(params.sid).catch(() => null)) || {};
    let lyr = null; try { lyr = await ctx.lyr.get(tr.artist, tr.title, tr.album, (tr.duration_ms || 0) / 1000); } catch {}
    const text = lyr ? `🎼 <b>${escH(tr.title)}</b>\n\n${escH(String(lyr)).slice(0, 3800)}` : t(lang, "no_lyrics");
    return { text, keyboard: kb([[R(t(lang, "back"), "nav:back")]]) };
  },
  favorites: async (ctx, p, lang, cq) => {
    const list = await favList(ctx, cq?.from?.id || p.uid);
    if (!list.length) return { text: t(lang, "favorites_empty"), keyboard: kb([[R(t(lang, "back"), "nav:back")]]) };
    return { text: t(lang, "favorites_title"), keyboard: kb([...list.slice(-18).reverse().map((tr) => [B(vtruncate(cardLabel(tr), 42), `trk:${tr.sid}`)]), [R(t(lang, "back"), "nav:back")]]) };
  },
  history: async (ctx, p, lang, cq) => {
    const list = (await H.get(ctx, "history", cq?.from?.id || p.uid)) || [];
    if (!list.length) return { text: t(lang, "history_empty"), keyboard: kb([[R(t(lang, "back"), "nav:back")]]) };
    return { text: t(lang, "history_title"), keyboard: kb([...list.slice(-18).reverse().map((tr) => [B(vtruncate(cardLabel(tr), 42), `trk:${tr.sid}`)]), [R(t(lang, "back"), "nav:back")]]) };
  },
  recog: async (ctx, params, lang) => {
    const d = params.data || {};
    const meta = [d.album ? `💿 ${escH(d.album)}` : null, d.year ? escH(String(d.year)) : null].filter(Boolean).join(" · ");
    const lines = [`🎧 <b>${escH(d.title || "?")}</b>`, `👤 ${escH(d.artist || "?")}${d.confidence != null ? ` · 🎯 اطمینان ${num(lang, Math.round(d.confidence))}٪` : ""}`, meta || null].filter(Boolean);
    const q = `${d.artist || ""} ${d.title || ""}`.trim();
    const rows = [[G("⬇️ دریافت فایل کامل", `rdl:${q64(q)}`)], [B("🔎 مشابه", `rsim:${q64(q)}`)], [R("✖️ بستن", "nav:close")]];
    return { text: lines.join("\n"), keyboard: kb(rows), media: d.artwork || d.cover || null };
  },
};

// ══ PANEL: per-message nav stack in KV ═════════════════════════════════════
const navKey = (c, m) => `nav:${c}:${m}`;
async function navState(ctx, c, m) { return (await H.get(ctx, "nav", `${c}:${m}`)) || { stack: [], current: null, ver: 0 }; }
async function navSet(ctx, c, m, s) { await H.set(ctx, "nav", `${c}:${m}`, s); }
async function navDel(ctx, c, m) { await H.del(ctx, "nav", `${c}:${m}`); }

async function showScreen(ctx, chatId, msgId, name, params = {}, { push = true, cq = null } = {}) {
  const scr = SCREENS[name]; if (!scr) return;
  const st = msgId ? await navState(ctx, chatId, msgId) : { stack: [], current: null, ver: 0 };
  if (push && st.current && st.current.name !== name) st.stack.push(st.current);
  st.current = { name, params };
  st.ver++;
  const lang = await ctx.langFor(cq?.from?.id || params.uid || null, chatId);
  const view = await scr(ctx, params, lang, cq);
  if (!view) return;
  const extra = { reply_markup: view.keyboard, media: view.media };
  const m = await editOrReply(ctx, chatId, msgId, view.text, extra);
  if (m && m.message_id && m.message_id !== msgId) {
    await navDel(ctx, chatId, msgId);
    await navSet(ctx, chatId, m.message_id, st);
  } else if (m && !msgId) {
    await navSet(ctx, chatId, m.message_id, st);
  }
  return m?.message_id;
}
async function navBack(ctx, cq) {
  const chatId = cq.message.chat.id, mid = cq.message.message_id;
  const st = await navState(ctx, chatId, mid);
  const prev = st.stack.pop() || { name: "menu", params: {} };
  await answer(ctx, cq);
  await showScreen(ctx, chatId, mid, prev.name, prev.params || {}, { push: false, cq });
}
async function navClose(ctx, cq) {
  await answer(ctx, cq);
  await ctx.tg.deleteMessage(cq.message.chat.id, cq.message.message_id).catch(() => {});
  await navDel(ctx, cq.message.chat.id, cq.message.message_id);
}
async function navMenu(ctx, cq) { await answer(ctx, cq); await showScreen(ctx, cq.message.chat.id, cq.message.message_id, "menu", {}, { push: false, cq }); }

// ══ FLOWS ══════════════════════════════════════════════════════════════════
export async function handleMessage(ctx, msg) {
  if (!msg || !msg.chat || msg.from?.is_bot) return;
  const chatId = msg.chat.id, uid = msg.from?.id, isGroup = ctx.isGroupChat(msg.chat.type);
  const lang = await ctx.langFor(uid, chatId);
  const text = (msg.text || msg.caption || "").trim();
  if (uid) ctx.exec.waitUntil(ctx.store.upsertUser(uid, { first_name: msg.from.first_name, username: msg.from.username }));
  if (isGroup) ctx.exec.waitUntil(ctx.store.upsertChat(chatId, { title: msg.chat.title }));

  const u = uid ? await ctx.store.getUser(uid) : null;
  if (u?.banned) { if (!isGroup) await reply(ctx, chatId, t(lang, "banned")); return; }
  const maint = await ctx.cfg("maintenance", false);
  if (maint && (await ctx.roleOf(uid)) === "user") { if (!isGroup) await reply(ctx, chatId, t(lang, "maintenance", { msg: await ctx.cfg("maintenance_msg", "") })); return; }

  // awaiting-state (tickets/admin inputs)
  if (!isGroup && uid) {
    const st = await ctx.store.get(`state:${uid}`);
    if (st && st.wait) {
      if (st.wait === "search") { await ctx.store.del(`state:${uid}`); if (text) { if (!(await gateCheck(ctx, msg, lang))) return; return doSearch(ctx, msg, text, lang); } }
      else if (st.wait === "insta") { await ctx.store.del(`state:${uid}`); const u = extractInstagramUrl(text); if (u) { if (!(await gateCheck(ctx, msg, lang))) return; return doInsta(ctx, msg, u, lang); } }
      else if (st.wait === "recog") { await ctx.store.del(`state:${uid}`); if (pickMedia(msg)) return doRecognize(ctx, msg, msg, lang); }
      else if (st.wait === "ticket_reply") {
        await ctx.store.del(`state:${uid}`);
        const tk = st.ticket || {};
        if (tk.target) {
          await ctx.tg.sendMessage(tk.target, `📩 پاسخ پشتیبانی:\n\n${escH(text)}`).catch(() => {});
          return reply(ctx, chatId, "✅ پاسخ ارسال شد.");
        }
      }
      else if (st.wait === "ticket") {
        await ctx.store.del(`state:${uid}`);
        const tickets = (await H.get(ctx, "tickets", "list")) || [];
        const n = tickets.length + 1;
        tickets.push({ n, uid, name: msg.from.first_name, text, at: Date.now() });
        await H.set(ctx, "tickets", "list", tickets.slice(-50));
        const owner = ctx.ownerId;
        if (owner) await ctx.tg.sendMessage(owner, `🎫 تیکت جدید #${n} از ${msg.from.first_name} (<code>${uid}</code>):\n\n${escH(text)}`, { reply_markup: kb([[G("🟢 پاسخ", `tk:r:${n}:${uid}`)]]) }).catch(() => {});
        return reply(ctx, chatId, `✅ پیامت به پشتیبانی رسید. تیکت #${n}`);
      }
      const consumed = await adminInput(ctx, msg, st);
      if (consumed !== false) return;
      await ctx.store.del(`state:${uid}`);
    }
  }

  const cmd = text.match(/^\/([A-Za-z_]+)(?:@\w+)?\s*(.*)$/);
  if (cmd) {
    const name = cmd[1].toLowerCase(), args = cmd[2].trim();
    switch (name) {
      case "start": return start(ctx, msg, args, lang, isGroup);
      case "invite": return showScreen(ctx, chatId, null, "invite", { uid });
      case "top": return showScreen(ctx, chatId, null, "top", { uid });
      case "music": case "search": case "song": {
        if (isGroup && !(await groupPerm(ctx, msg, "search"))) return;
        if (!args) return showScreen(ctx, chatId, null, "menu", { uid });
        if (!(await gateCheck(ctx, msg, lang))) return;
        return doSearch(ctx, msg, args, lang);
      }
      case "lyrics": {
        if (!(await gateCheck(ctx, msg, lang))) return;
        const media = msg.reply_to_message && pickMedia(msg.reply_to_message);
        if (media) return handleMedia(ctx, msg.reply_to_message);
        if (args) return doLyrics(ctx, msg, args, lang);
        return reply(ctx, chatId, t(lang, "ask_query"));
      }
      case "recognize": {
        const target = (msg.reply_to_message && pickMedia(msg.reply_to_message)) ? msg.reply_to_message : (pickMedia(msg) ? msg : null);
        if (!target) return reply(ctx, chatId, t(lang, "ask_voice"));
        if (!(await gateCheck(ctx, msg, lang))) return;
        return doRecognize(ctx, msg, target, lang);
      }
      case "help": case "راهنما": return showScreen(ctx, chatId, null, "help", { uid });
      case "admin": if (!isGroup && (await ctx.roleOf(uid)) === "owner") return openAdmin(ctx, msg); return;
      case "diag": if (isGroup) return diag(ctx, msg); return;
      case "settings": return groupSettings(ctx, msg, lang);
      case "perf": if ((await ctx.roleOf(uid)) === "owner") return reply(ctx, chatId, `perf: ${new Date().toISOString()}`); return;
      default: return;
    }
  }

  // media recognition
  if (pickMedia(msg)) {
    if (isGroup) {
      const replyBot = await isReplyToThisBot(ctx, msg);
      if (!replyBot) return;
    }
    if (!(await gateCheck(ctx, msg, lang))) return;
    return doRecognize(ctx, msg, msg, lang);
  }
  if (!text) return;

  // links
  const igUrl = extractInstagramUrl(text);
  if (igUrl) {
    if (isGroup && !(await groupPerm(ctx, msg, "link"))) return;
    if (!(await gateCheck(ctx, msg, lang))) return;
    return doInsta(ctx, msg, igUrl, lang);
  }
  const scUrl = extractSoundCloudUrl(text);
  if (scUrl) {
    if (!(await gateCheck(ctx, msg, lang))) return;
    const tr = await ctx.sc.resolve(scUrl).catch(() => null);
    if (tr) return runDownload(ctx, msg, tr, lang);
    return doSearch(ctx, msg, text, lang);
  }

  // group addressing / smart detect
  if (isGroup) {
    const mentioned = await groupAddressed(ctx, msg, text);
    if (mentioned) {
      const q = text.replace(new RegExp(`@${String(ctx.env.BOT_USERNAME || "").replace(/^@/, "")}`, "ig"), "").trim();
      if (!q) return;
      if (!(await groupPerm(ctx, msg, "search"))) return;
      if (/^(متن|ترانه|lyrics?)\s+/i.test(q)) return doLyrics(ctx, msg, q.replace(/^(متن|ترانه|lyrics?)\s+/i, ""), lang);
      return doSearch(ctx, msg, q, lang);
    }
    // Do not answer ordinary group text, trigger words, or arbitrary replies.
    // Explicit commands and links are handled above/below.
    return;
  }

  // private text: lyrics-prefixed or search
  if (/^(متن|ترانه|lyrics?)\s+/i.test(text)) {
    if (!(await gateCheck(ctx, msg, lang))) return;
    return doLyrics(ctx, msg, text.replace(/^(متن|ترانه|lyrics?)\s+/i, ""), lang);
  }
  if (!(await gateCheck(ctx, msg, lang))) return;
  return doSearch(ctx, msg, text, lang);
}

async function groupPerm(ctx, msg, kind) {
  const w = await rlCheck(ctx, msg.from?.id, kind === "link" ? "action" : kind === "search" ? "group" : "group");
  if (w) { await ctx.tg.sendMessage(msg.chat.id, t(await ctx.langFor(msg.from?.id, msg.chat.id), "rate_limited", { wait: fmtWait(w) })).catch(() => {}); return false; }
  return true;
}
async function groupSettings(ctx, msg, lang) {
  const uid = msg.from?.id;
  let admin = (await ctx.roleOf(uid)) === "owner";
  if (!admin) { try { const m = await ctx.tg.getChatMember(msg.chat.id, uid); admin = ["administrator", "creator"].includes(m.status); } catch {} }
  if (!admin) return;
  const chat = (await ctx.store.getChat(msg.chat.id)) || {};
  const rows = [
    [B(`تشخیص هوشمند: ${chat.smart !== false ? "روشن" : "خاموش"}`, "gs:smart")],
    [B(`حذف خودکار: ${chat.autodel ? "۵ دقیقه" : "خاموش"}`, "gs:autodel")],
    [B(`زبان گروه: ${chat.lang || "fa"}`, "gs:lang")],
    [R("✖️ بستن", "nav:close")],
  ];
  return ctx.tg.sendMessage(msg.chat.id, "⚙️ تنظیمات گروه", { reply_markup: kb(rows) });
}
async function diag(ctx, msg) {
  const uid = msg.from?.id;
  let admin = (await ctx.roleOf(uid)) === "owner";
  if (!admin) { try { const m = await ctx.tg.getChatMember(msg.chat.id, uid); admin = ["administrator", "creator"].includes(m.status); } catch {} }
  if (!admin) return;
  const chat = (await ctx.store.getChat(msg.chat.id)) || {};
  return ctx.tg.sendMessage(msg.chat.id, `chat: ${msg.chat.type} · smart=${chat.smart !== false} · autodel=${chat.autodel || 0} · lang=${chat.lang || "fa"}`);
}

async function start(ctx, msg, args, lang, isGroup) {
  if (isGroup) return showScreen(ctx, msg.chat.id, null, "help", { uid: msg.from?.id });
  const ok = await gateCheck(ctx, msg, lang);
  if (!ok) return;
  const uid = msg.from?.id;
  if (args.startsWith("t_")) {
    const tr = await ctx.sc.track(args.slice(2)).catch(() => null);
    if (tr) return runDownload(ctx, msg, tr, lang);
    return showScreen(ctx, msg.chat.id, null, "menu", { uid, name: msg.from.first_name });
  }
  if (args.startsWith("s_")) return doSearch(ctx, msg, decodeURIComponent(args.slice(2)), lang);
  if (args.startsWith("ref_")) {
    const code = args.slice(4); const inviter = code.replace(/^ref_/, "");
    if (inviter && String(inviter) !== String(uid)) {
      const ref = (await H.get(ctx, "referral", inviter)) || { invited: 0, verified: 0, points: 0 };
      const already = await H.get(ctx, "referral", `${inviter}:${uid}`);
      if (!already) { ref.invited++; await H.set(ctx, "referral", inviter, ref); await H.set(ctx, "referral", `${inviter}:${uid}`, { status: "pending", at: Date.now() }); }
      await reply(ctx, msg.chat.id, "👥 دعوت شما ثبت شد؛ با عضویت در کانال و اولین استفاده تأیید می‌شود.");
    }
    return showScreen(ctx, msg.chat.id, null, "menu", { uid, name: msg.from.first_name });
  }
  if (args.startsWith("ig_")) {
    const q = unq64(args.slice(3));
    const d = await ctx.sc.search(q, 1, 3).catch(() => null);
    const tr = d?.results?.[0];
    if (tr) return runDownload(ctx, msg, tr, lang);
    return showScreen(ctx, msg.chat.id, null, "menu", { uid });
  }
  if (args === "inline") return showScreen(ctx, msg.chat.id, null, "menu", { uid, name: msg.from.first_name });
  return showScreen(ctx, msg.chat.id, null, "menu", { uid, name: msg.from.first_name });
}

async function doSearch(ctx, msg, q, lang) {
  const w = await rlCheck(ctx, msg.from?.id, "search");
  if (w) return reply(ctx, msg.chat.id, t(lang, "rate_limited", { wait: fmtWait(w) }));
  const features = (await H.get(ctx, "settings", "features")) || {};
  if (features.search === false) return reply(ctx, msg.chat.id, t(lang, "error_service"));
  let d = null;
  try { d = await ctx.sc.search(q, 1, 24); } catch { }
  if (!d) return reply(ctx, msg.chat.id, "⚠️ سرویس جستجو موقتاً در دسترس نیست؛ چند لحظه بعد دوباره تلاش کن.");
  const items = Array.isArray(d) ? d : (d.results || []);
  if (!items.length) return reply(ctx, msg.chat.id, t(lang, "no_results"));
  H.incrStat(ctx, "searches");
  // learned boost
  const learning = (await H.get(ctx, "settings", "search_learning")) || {};
  const nq = normalize(q);
  const learned = learning[nq];
  const scored = items.map((tr) => ({ tr, score: Math.max(similarity(q, tr.title || ""), similarity(q, `${tr.artist} ${tr.title}`), similarity(q, tr.artist || "")) }));
  scored.sort((a, b) => b.score - a.score);
  let best = scored[0];
  if (learned && learned.sid) scored.sort((a, b) => (sidOf(a.tr) === learned.sid ? -1 : 0) - (sidOf(b.tr) === learned.sid ? -1 : 0));
  const artistAliases = new Set(items.flatMap((x) => [x.artist]).filter(Boolean).map(normalize));
  const nonArtist = nq.split(/\s+/).filter((t0) => ![...artistAliases].some((a) => a.split(/\s+/).includes(t0)));
  const top = scored[0], second = scored[1];
  if (top && top.score >= 0.92 && (!second || top.score - second.score >= 0.15) && nonArtist.length > 0) {
    const m = { ...learning }; m[nq] = { sid: sidOf(top.tr), title: top.tr.title, artist: top.tr.artist, count: ((m[nq] && m[nq].count) || 0) + 1, at: Date.now() };
    await H.set(ctx, "settings", "search_learning", m);
    return runDownload(ctx, msg, top.tr, lang);
  }
  const id = Date.now().toString(36);
  const rec = { q, items: scored.slice(0, 10).map((x) => compact(x.tr)), lang, owner: msg.from?.id, at: Date.now(), filter: "pop" };
  await ctx.store.putSearch(id, rec, 3600);
  return showScreen(ctx, msg.chat.id, null, "results", { ...rec, page: 1, id });
}

async function runDownload(ctx, msg, tr, lang) {
  const uid = msg.from?.id;
  const w = await rlCheck(ctx, uid, "download");
  if (w) return reply(ctx, msg.chat.id, t(lang, "rate_limited", { wait: fmtWait(w) }));
  await ctx.tg.sendChatAction(msg.chat.id, "upload_audio").catch(() => {});
  const full = await ctx.sc.track(sidOf(tr)).catch(() => tr);
  const meta = full || tr;
  await pushHist(ctx, uid, meta);
  H.incrStat(ctx, "downloads");
  const key = `sc:${sidOf(meta)}`;
  let fileId = await ctx.store.getTrackFileId(key);
  const dur = Math.round((meta.duration_ms || 0) / 1000);
  const title = meta.title || "track", artist = meta.artist || "";
  const caption = `🎵 <b>${escH(title)}</b>${artist ? `\n👤 ${escH(artist)}` : ""}${dur ? `\n⏱ ${fmtDur(meta.duration_ms)}` : ""}`;
  const share = `https://t.me/share/url?url=${encodeURIComponent(`https://t.me/${ctx.env.BOT_USERNAME}?start=t_${sidOf(meta)}`)}`;
  const markup = kb([
    artist ? [G(`🔎 آهنگ‌های بیشتر از ${artist}`, `art:${q64(artist)}`)] : [],
    [URLB("📤 اشتراک‌گذاری", share)],
  ].filter((r) => r.length));
  let sent = null;
  if (fileId) { try { sent = await ctx.tg.sendAudio(msg.chat.id, { audio: fileId, caption, title, performer: artist, duration: dur, reply_markup: markup }); H.incrStat(ctx, "cache_hits"); } catch { fileId = null; } }
  if (!sent) {
    const base = (ctx.env.SOUNDCLOUD_API_URL || `${ctx.publicUrl(ctx.request)}/svc/sc`).replace(/\/$/, "");
    const slug = encodeURIComponent(((artist ? artist + " - " : "") + title).replace(/[\\/:*?"<>|]/g, " ").slice(0, 80) || "track");
    const urls = [meta.downloadUrl, meta.streamUrl, `${base}/f/${sidOf(meta)}/${slug}.m4a`].filter(Boolean);
    for (const url of urls) {
      try {
        sent = await ctx.tg.sendAudio(msg.chat.id, { audio: url, caption, title, performer: artist, duration: dur, reply_markup: markup });
        const fid = sent?.audio?.file_id;
        if (fid) { ctx.exec.waitUntil(ctx.store.putTrack(key, { file_id: fid, title, artist, duration_ms: meta.duration_ms })); break; }
        if (sent?.message_id) delMsg(ctx, msg.chat.id, sent.message_id);
        sent = null;
      } catch { sent = null; }
    }
    if (!sent) {
      const fb = kb([[URLB(t(lang, "dl_direct"), meta.downloadUrl || meta.pageUrl || `https://soundcloud.com`)]]);
      sent = await ctx.tg.sendMessage(msg.chat.id, caption + "\n\n" + t(lang, "file_too_big_tg"), { reply_markup: fb });
    }
  }
  const autoLyrics = await ctx.cfg("auto_lyrics", true);
  if (autoLyrics !== false && sent) ctx.exec.waitUntil(sendLyrics(ctx, msg.chat.id, meta, lang));
  // referral verify on successful download
  const refs = await ctx.store.listWithPrefix("referral:");
  for (const r of refs) {
    const parts = String(r.key).split(":");
    if (parts.length === 2 && parts[1] === String(uid) && r.value?.status === "pending") {
      const inviter = parts[0].replace(/^ref_/, "");
      const ref = (await H.get(ctx, "referral", inviter)) || { invited: 0, verified: 0, points: 0 };
      ref.verified++; ref.points += 10;
      await H.set(ctx, "referral", inviter, ref);
      await H.set(ctx, "referral", `${inviter}:${uid}`, { status: "verified", at: Date.now() });
      await ctx.tg.sendMessage(inviter, `✅ یک دعوت شما تأیید شد! مجموع تأییدشده: ${ref.verified}`).catch(() => {});
    }
  }
  return sent;
}

async function sendLyrics(ctx, chatId, tr, lang) {
  let text = tr.lyrics || null;
  if (!text && tr.title) { try { text = await ctx.lyr.get(tr.artist, tr.title, tr.album, (tr.duration_ms || 0) / 1000); } catch {} }
  if (!text && tr.title) { try { const res = await ctx.lyr.search(tr.title, tr.artist); text = res?.[0]?.lyrics || null; } catch {} }
  if (!text) return null;
  const { splitText } = await import("../utils/text.js");
  for (const c of splitText(String(text), 3900)) await ctx.tg.sendMessage(chatId, `<blockquote expandable>${escH(c)}</blockquote>`).catch(() => {});
  return true;
}
async function doLyrics(ctx, msg, q, lang) {
  const w = await rlCheck(ctx, msg.from?.id, "action");
  if (w) return reply(ctx, msg.chat.id, t(lang, "rate_limited", { wait: fmtWait(w) }));
  try {
    const d = await ctx.shz.searchText(q, 4, true);
    const card = d?.artist ? d : d?.results?.[0];
    if (card) {
      const lyr = await ctx.lyr.get(card.artist, card.title).catch(() => null);
      if (lyr) return ctx.tg.sendMessage(msg.chat.id, `🎼 <b>${escH(card.title)}</b>\n\n${escH(String(lyr)).slice(0, 3800)}`);
    }
  } catch {}
  return reply(ctx, msg.chat.id, t(lang, "no_lyrics"));
}

async function doRecognize(ctx, msg, target, lang) {
  const w = await rlCheck(ctx, msg.from?.id, "recognize");
  if (w) return reply(ctx, msg.chat.id, t(lang, "rate_limited", { wait: fmtWait(w) }));
  const statusMsg = await status(ctx, msg.chat.id, t(lang, "recognizing"));
  try {
    const { recognizeMedia } = await import("./recognize.js");
    const d = await recognizeMedia(ctx, pickMedia(target), target.chat.id, lang);
    if (!d) { await delMsg(ctx, msg.chat.id, statusMsg?.message_id); return reply(ctx, msg.chat.id, t(lang, "recognize_none")); }
    H.incrStat(ctx, "rec");
    const conf = d.confidence != null && d.confidence <= 1 ? d.confidence * 100 : (d.confidence || 0);
    d.confidence = conf;
    if (conf >= 70) {
      const q = `${d.artist || ""} ${d.title || ""}`.trim();
      const s = await ctx.sc.search(q, 1, 3).catch(() => null);
      const tr = chooseSoundCloudMatch(s, d.artist, d.title);
      if (tr) { await delMsg(ctx, msg.chat.id, statusMsg?.message_id); return runDownload(ctx, msg, tr, lang); }
    }
    await delMsg(ctx, msg.chat.id, statusMsg?.message_id);
    return showScreen(ctx, msg.chat.id, null, "recog", { data: d }, { push: false });
  } catch (e) {
    await delMsg(ctx, msg.chat.id, statusMsg?.message_id);
    return reply(ctx, msg.chat.id, e?.code === "NO_AUDIO" ? "⚠️ صدای قابل تشخیصی در این فایل پیدا نشد." : e?.code === "UNSUPPORTED" ? t(lang, "recognize_badformat") : t(lang, "recognize_none"));
  }
}

async function doInsta(ctx, msg, url, lang) {
  const statusMsg = await status(ctx, msg.chat.id, t(lang, "processing_status"));
  let d = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3 && !d; attempt++) {
    try { d = await ctx.insta.resolve(url); }
    catch (e) { lastErr = e; if (attempt < 2) await new Promise((r) => setTimeout(r, 700 * (attempt + 1))); }
  }
  if (!d || !(d.items || []).length) {
    await delMsg(ctx, msg.chat.id, statusMsg?.message_id);
    const upstream = /UPSTREAM|502|TIMEOUT|unavailable/i.test(String(lastErr?.message || lastErr || ""));
    return reply(ctx, msg.chat.id, upstream ? "⚠️ سرویس اینستاگرام موقتاً پاسخ نداد؛ چند ثانیه بعد دوباره همین لینک را بفرست." : t(lang, "insta_none"));
  }
  const items = d.items.slice(0, 10);
  const hasVideo = items.some((i) => i.type === "video" || /video/i.test(i.mime || ""));
  const q = guessMusicQuery(d);
  const control = kb([
    hasVideo ? [G(`🎵 ${t(lang, "ig_recognize")}`, "igx")] : [],
    q ? [B(`🔍 ${t(lang, "ig_search_sc")}`, `igm:${q64(q)}`)] : [],
  ].filter((r) => r.length));
  await H.set(ctx, "panel", `${msg.chat.id}:${msg.from?.id}`, { igData: compactIg(d), igQuery: q });
  let sent = 0;
  for (const it of items) {
    try {
      const v = { url: it.url || it.proxyUrl, mime: it.mime || "", quality: "best", index: it.index, size: it.size };
      if (!v.url) continue;
      const mediaUrl = it.proxyUrl || it.url || (ctx.insta.downloadUrl ? ctx.insta.downloadUrl(d.source_url || url, it.index, "best") : null);
      const isVideo = it.type === "video" || /video/i.test(v.mime);
      const caption = isVideo ? "🎬 <b>Instagram</b>" : "🖼 <b>Instagram</b>";
      const size = Number(v.size || v.filesize || 0);
      let ok = false;
      if (!size || size <= 20 * 1024 * 1024) {
        try {
          if (isVideo) await ctx.tg.sendVideo(msg.chat.id, { video: mediaUrl, caption, supports_streaming: true, reply_markup: control });
          else await ctx.tg.sendPhoto(msg.chat.id, { photo: mediaUrl, caption, reply_markup: control });
          ok = true;
        } catch {}
      }
      if (!ok) {
        const buf = await fetchBytes(mediaUrl, 48 * 1024 * 1024).catch(() => null);
        if (!buf) continue;
        const fname = v.filename || `instagram_${it.index}`;
        if (isVideo) await ctx.tg.upload("sendVideo", { chat_id: msg.chat.id, caption, parse_mode: "HTML", supports_streaming: true, reply_markup: control }, "video", { data: buf, name: fname, type: v.mime || "video/mp4" }).catch(() => null);
        else await ctx.tg.upload("sendPhoto", { chat_id: msg.chat.id, caption, parse_mode: "HTML", reply_markup: control }, "photo", { data: buf, name: fname + ".jpg", type: v.mime || "image/jpeg" }).catch(() => null);
      }
      sent++;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  H.incrStat(ctx, "downloads");
  await delMsg(ctx, msg.chat.id, statusMsg?.message_id);
  if (!sent) return reply(ctx, msg.chat.id, t(lang, "insta_none"));
}
function pickVariant(it) { const vs = it.variants || []; return vs.find((v) => v.has_audio !== false) || vs[0]; }
function compactIg(d) { return { source_url: d.source_url, type: d.type, author: d.author, caption: d.caption, thumbnail: d.thumbnail, items: (d.items || []).slice(0, 10) }; }
function guessMusicQuery(d) { const c = (d.caption || "").split("\n")[0].trim(); const a = (d.author && (d.author.username || d.author.full_name)) || ""; let q = ""; const m = c.match(/([\p{L} .'-]{3,40})\s[-–—|]\s([\p{L} .'-]{3,40})/u); if (m) q = `${m[1]} ${m[2]}`; else if (c && c.length < 60 && /[\p{L}]/u.test(c)) q = c; else if (a) q = a; return normalize(q) || ""; }

// ══ CALLBACKS ══════════════════════════════════════════════════════════════
export async function handleCallback(ctx, cq) {
  const data = String(cq.data || "");
  const msg = cq.message || {};
  const chatId = msg.chat?.id ?? cq.from.id, mid = msg.message_id, uid = cq.from.id;
  const lang = await ctx.langFor(uid, chatId);
  const okGate = async () => (await missingChannels(ctx, uid)).length === 0 || (await ctx.roleOf(uid)) === "owner";
  try {
    if (data === "noop") return answer(ctx, cq);
    if (data === "nav:back") return navBack(ctx, cq);
    if (data === "nav:close") return navClose(ctx, cq);
    if (data === "nav:menu") return navMenu(ctx, cq);
    if (data === "fj:check") {
      const missing = await missingChannels(ctx, uid);
      if (!missing.length) { await answer(ctx, cq, t(lang, "join_ok"), true); return showScreen(ctx, chatId, mid, "menu", { uid, name: cq.from.first_name }, { push: false, cq }); }
      return answer(ctx, cq, t(lang, "not_member"), true);
    }
    if (data.startsWith("m:")) {
      if (!(await okGate())) return answer(ctx, cq, t(lang, "join_not"), true);
      const name = data.slice(2);
      if (name === "home") { await answer(ctx, cq); return showScreen(ctx, chatId, mid, "menu", { uid, name: cq.from.first_name }, { push: false, cq }); }
      if (name === "search") { await answer(ctx, cq); await ctx.store.put(`state:${uid}`, { wait: "search" }, 600); return showScreen(ctx, chatId, mid, "input", { text: t(lang, "ask_query"), next: "search" }, { push: true, cq }); }
      if (name === "help") { await answer(ctx, cq); return showScreen(ctx, chatId, mid, "help", {}, { push: true, cq }); }
      if (name === "lang") { await answer(ctx, cq); return showScreen(ctx, chatId, mid, "lang", {}, { push: true, cq }); }
      if (name === "invite") { await answer(ctx, cq); return showScreen(ctx, chatId, mid, "invite", { uid }, { push: true, cq }); }
      if (name === "top") { await answer(ctx, cq); return showScreen(ctx, chatId, mid, "top", { uid }, { push: true, cq }); }
      if (name === "support") { await answer(ctx, cq); await ctx.store.put(`state:${uid}`, { wait: "ticket" }, 300); return editOrReply(ctx, chatId, mid, t(lang, "support_ask"), { reply_markup: kb([[R(t(lang, "back"), "nav:back")]]) }); }
      return answer(ctx, cq);
    }
    if (data === "a:panel") {
      if ((await ctx.roleOf(uid)) !== "owner") return answer(ctx, cq, t(lang, "admin_only"), true);
      await answer(ctx, cq);
      return showScreen(ctx, chatId, mid, "admin", { uid }, { push: true, cq });
    }
    if (data.startsWith("lang:")) {
      const code = data.slice(5);
      await ctx.store.upsertUser(uid, { lang: code });
      if (msg.chat?.type && ctx.isGroupChat(msg.chat.type)) await ctx.store.upsertChat(chatId, { lang: code });
      await answer(ctx, cq, t(code, "lang_set"), true);
      return showScreen(ctx, chatId, mid, "menu", { uid, name: cq.from.first_name }, { push: false, cq });
    }
    if (data.startsWith("pick:")) {
      const parts = data.split(":"); const sid = parts[1], owner = parts[2] || "";
      const st = await navState(ctx, chatId, mid);
      const rec = st.current && st.current.name === "results" ? st.current.params : null;
      if (rec?.at && Date.now() - rec.at > 600000) { await answer(ctx, cq, "این پنل منقضی شده است", true); return navClose(ctx, cq); }
      if (ctx.isGroupChat(msg.chat.type) && rec?.owner && String(rec.owner) !== String(uid)) return answer(ctx, cq, "این پنل برای کاربر دیگری است", true);
      if (!(await okGate())) return answer(ctx, cq, t(lang, "join_not"), true);
      const tr = (rec?.items || []).find((x) => sidOf(x) === sid) || (await ctx.sc.track(sid).catch(() => null));
      await answer(ctx, cq);
      const learning = (await H.get(ctx, "settings", "search_learning")) || {};
      const nq = normalize(rec?.q || "");
      if (tr) { const m = { ...learning }; m[nq] = { sid, title: tr.title, artist: tr.artist, count: ((m[nq] && m[nq].count) || 0) + 1, at: Date.now() }; await H.set(ctx, "settings", "search_learning", m); }
      return runDownload(ctx, { chat: { id: chatId }, from: cq.from, message_id: mid }, tr || { sid }, lang);
    }
    if (data.startsWith("pg:")) {
      const st = await navState(ctx, chatId, mid);
      const rec = st.current && st.current.name === "results" ? st.current.params : null;
      if (!rec) return answer(ctx, cq, t(lang, "expired"), true);
      const pg = parseInt(data.slice(3), 10) || 1;
      await answer(ctx, cq);
      return showScreen(ctx, chatId, mid, "results", { ...rec, page: pg }, { push: false, cq });
    }
    if (data.startsWith("fl:")) {
      const st = await navState(ctx, chatId, mid);
      const rec = st.current && st.current.name === "results" ? st.current.params : null;
      if (!rec) return answer(ctx, cq, t(lang, "expired"), true);
      const f = data.slice(3);
      await answer(ctx, cq);
      if (f === "artist") { const artist = rec.items[0]?.artist || rec.q; return doSearch(ctx, { chat: { id: chatId, type: msg.chat?.type || "private" }, from: cq.from }, artist, lang); }
      return showScreen(ctx, chatId, mid, "results", { ...rec, filter: f, page: 1 }, { push: false, cq });
    }
    if (data.startsWith("dl:")) { const tr = await ctx.sc.track(data.slice(3)).catch(() => null); await answer(ctx, cq); if (!tr) return; return runDownload(ctx, { chat: { id: chatId }, from: cq.from, message_id: mid }, tr, lang); }
    if (data.startsWith("trk:")) { await answer(ctx, cq); return showScreen(ctx, chatId, mid, "track", { sid: data.slice(4), uid }, { push: true, cq }); }
    if (data.startsWith("lyr:")) { await answer(ctx, cq); return showScreen(ctx, chatId, mid, "lyrics", { sid: data.slice(4) }, { push: true, cq }); }
    if (data.startsWith("sim:")) {
      const tr = await ctx.sc.track(data.slice(4)).catch(() => null);
      await answer(ctx, cq);
      const q = `${tr?.artist || ""} ${(tr?.title || "").split(" ").slice(0, 3).join(" ")}`.trim();
      return doSearch(ctx, { chat: { id: chatId, type: "private" }, from: cq.from }, q, lang);
    }
    if (data.startsWith("fava:")) { const tr = await ctx.sc.track(data.slice(5)).catch(() => null); await answer(ctx, cq, t(lang, "fav_added"), true); if (tr) { await toggleFav(ctx, uid, tr); return showScreen(ctx, chatId, mid, "track", { sid: data.slice(5), uid }, { push: false, cq }); } return; }
    if (data.startsWith("favd:")) { await answer(ctx, cq, t(lang, "fav_removed"), true); const sid = data.slice(5); const list = await favList(ctx, uid); const tr = list.find((x) => String(x.sid) === sid) || { sid }; await toggleFav(ctx, uid, tr); return showScreen(ctx, chatId, mid, "track", { sid, uid }, { push: false, cq }); }
    if (data.startsWith("art:")) { await answer(ctx, cq); return doSearch(ctx, { chat: { id: chatId, type: "private" }, from: cq.from }, unq64(data.slice(4)), lang); }
    if (data.startsWith("rdl:") || data.startsWith("rsim:")) {
      const b64 = data.startsWith("rdl:") ? data.slice(4) : data.slice(5);
      await answer(ctx, cq, t(lang, "searching"));
      const q = unq64(b64); const s = await ctx.sc.search(q, 1, 5).catch(() => null);
      const list = Array.isArray(s) ? s : (s?.results || []);
      const tr = list.find((r) => sidOf(r)) || list[0];
      if (!tr) return reply(ctx, chatId, t(lang, "no_results"));
      return runDownload(ctx, { chat: { id: chatId }, from: cq.from, message_id: mid }, tr, lang);
    }
    if (data === "igx") {
      await answer(ctx, cq, t(lang, "recognizing"));
      const p = (await H.get(ctx, "panel", `${chatId}:${uid}`)) || {};
      const d = p.igData; if (!d) return reply(ctx, chatId, t(lang, "error_generic"));
      const item = (d.items || []).find((i) => i.type === "video" || /video/i.test(i.mime || ""));
      if (!item) return reply(ctx, chatId, t(lang, "recognize_none"));
      try {
        const mediaUrl = item.url || item.proxyUrl || (ctx.insta.downloadUrl ? ctx.insta.downloadUrl(d.source_url, item.index, "best") : null);
        const buf = await fetchBytes(mediaUrl, 48 * 1024 * 1024);
        const { recognizeBytes } = await import("./recognize.js");
        const d2 = await recognizeBytes(ctx, buf, `recog:ig:${d.source_url}`);
        if (!d2) return reply(ctx, chatId, t(lang, "recognize_none"));
        const conf = d2.confidence != null && d2.confidence <= 1 ? d2.confidence * 100 : (d2.confidence || 0);
        d2.confidence = conf;
        return showScreen(ctx, chatId, mid, "recog", { data: d2 }, { push: false, cq });
      } catch { return reply(ctx, chatId, t(lang, "recognize_none")); }
    }
    if (data.startsWith("igm:")) { await answer(ctx, cq, t(lang, "searching")); const q = unq64(data.slice(4)); const s = await ctx.sc.search(q, 1, 3).catch(() => null); const tr = (Array.isArray(s) ? s : s?.results || [])[0]; if (!tr) return reply(ctx, chatId, t(lang, "no_results")); return runDownload(ctx, { chat: { id: chatId }, from: cq.from, message_id: mid }, tr, lang); }
    if (data.startsWith("tk:r:")) {
      const parts = data.split(":"); const n = parts[2], target = parts[3];
      if ((await ctx.roleOf(uid)) !== "owner") return answer(ctx, cq, "⛔", true);
      await ctx.store.put(`state:${uid}`, { wait: "ticket_reply", ticket: { n, target } }, 600);
      await answer(ctx, cq);
      return ctx.tg.sendMessage(chatId, `پاسخ به تیکت #${n} را بفرست:`);
    }
    if (data.startsWith("gs:")) {
      const chat = (await ctx.store.getChat(chatId)) || {};
      const uid2 = uid; let admin = (await ctx.roleOf(uid2)) === "owner";
      if (!admin) { try { const m = await ctx.tg.getChatMember(chatId, uid2); admin = ["administrator", "creator"].includes(m.status); } catch {} }
      if (!admin) return answer(ctx, cq, "⛔", true);
      const k = data.slice(3);
      if (k === "smart") chat.smart = !(chat.smart !== false);
      if (k === "autodel") chat.autodel = chat.autodel ? 0 : 300;
      if (k === "lang") chat.lang = chat.lang === "fa" ? "en" : "fa";
      await ctx.store.upsertChat(chatId, chat);
      await answer(ctx, cq);
      const rows = [[B(`تشخیص هوشمند: ${chat.smart !== false ? "روشن" : "خاموش"}`, "gs:smart")], [B(`حذف خودکار: ${chat.autodel ? "۵ دقیقه" : "خاموش"}`, "gs:autodel")], [B(`زبان گروه: ${chat.lang || "fa"}`, "gs:lang")], [R("✖️ بستن", "nav:close")]];
      return ctx.tg.editMessageReplyMarkup(chatId, mid, kb(rows)).catch(() => {});
    }
    if (data.startsWith("adm:")) return adminCb(ctx, cq, data.slice(4));
    if (data === "adm:close") return navClose(ctx, cq);
    return answer(ctx, cq);
  } catch (e) {
    try { await ctx.store.logError({ where: "callback", msg: e.message }); } catch {}
    return answer(ctx, cq, t(lang, "error_generic"), true);
  }
}

// helpers shared by callbacks
async function fetchBytes(url, cap) { if (!url) throw new Error("no url"); const r = await fetch(url); if (!r.ok) throw new Error("http " + r.status); const buf = await r.arrayBuffer(); if (buf.byteLength > cap) throw new Error("too big"); return new Uint8Array(buf); }

// ══ ADMIN (host-parity subset) ═════════════════════════════════════════════
async function openAdmin(ctx, msg) { return showScreen(ctx, msg.chat.id, null, "admin", { uid: msg.from?.id }); }

async function adminInput(ctx, msg, st) {
  const uid = msg.from?.id, chatId = msg.chat.id, text = (msg.text || "").trim();
  const lang = await ctx.langFor(uid, chatId);
  switch (st.wait) {
    case "ban": {
      const id = text.replace(/\D/g, "");
      if (!id) { await reply(ctx, chatId, t(lang, "ban_prompt")); return true; }
      const u = (await ctx.store.getUser(id)) || {};
      u.banned = true;
      await ctx.store.upsertUser(id, u);
      await reply(ctx, chatId, t(lang, "banned_done", { id }));
      return true;
    }
    case "unban": {
      const id = text.replace(/\D/g, "");
      if (!id) return true;
      const u = (await ctx.store.getUser(id)) || {};
      delete u.banned;
      await ctx.store.upsertUser(id, u);
      await reply(ctx, chatId, t(lang, "unbanned_done", { id }));
      return true;
    }
    case "fj_add": {
      const ch = text.match(/^@?([a-zA-Z0-9_]+)$/) ? { username: text.replace(/^@/, ""), id: `@${text.replace(/^@/, "")}` }
        : /^t\.me\/([a-zA-Z0-9_]+)/.test(text) ? { username: text.match(/^t\.me\/([a-zA-Z0-9_]+)/)[1], id: text }
        : text.startsWith("-100") ? { id: text } : null;
      if (!ch) { await reply(ctx, chatId, t(lang, "channel_add_prompt")); return true; }
      await ctx.store.putChannel(ch.id, { username: ch.username, title: ch.username || ch.id, enabled: true });
      await reply(ctx, chatId, t(lang, "channel_added", { id: ch.id }));
      return true;
    }
    case "bc": {
      await reply(ctx, chatId, `📣 ارسال به کاربران آغاز شد…`);
      const users = await ctx.store.listUsers();
      let ok = 0, fail = 0;
      for (const u of users) {
        try {
          if (u.inactive || u.banned) { fail++; continue; }
          await ctx.tg.sendMessage(u.id, text, { parse_mode: "HTML" });
          ok++;
        } catch { fail++; }
        await new Promise((r) => setTimeout(r, 40));
      }
      await reply(ctx, chatId, `✅ ارسال شد: ${ok} موفق، ${fail} ناموفق`);
      return true;
    }
    default: return false;
  }
}

async function adminCb(ctx, cq, sub) {
  const uid = cq.from.id, chatId = cq.message?.chat?.id, mid = cq.message?.message_id;
  const lang = await ctx.langFor(uid, chatId);
  if ((await ctx.roleOf(uid)) !== "owner") return answer(ctx, cq, t(lang, "admin_only"), true);
  const settings = (await H.get(ctx, "settings", "global")) || {};
  switch (true) {
    case sub === "stats": {
      await answer(ctx, cq);
      const users = await ctx.store.countUsers().catch(() => 0);
      const groups = (await ctx.store.listChats().catch(() => [])).length;
      const text = `📊 <b>آمار</b>\n👥 کاربران: ${num(lang, users)}\n👥 گروه‌ها: ${num(lang, groups)}\n🔍 جستجو: ${num(lang, await ctx.store.getStatTotal("searches"))} (امروز ${num(lang, await ctx.store.getStat("searches"))})\n⬇️ دانلود: ${num(lang, await ctx.store.getStatTotal("downloads"))} (امروز ${num(lang, await ctx.store.getStat("downloads"))})\n🎤 شناسایی: ${num(lang, await ctx.store.getStatTotal("rec"))} (امروز ${num(lang, await ctx.store.getStat("rec"))})`;
      return editOrReply(ctx, chatId, mid, text, { reply_markup: kb([[R(t(lang, "back"), "nav:back")]]) });
    }
    case sub === "health": {
      await answer(ctx, cq);
      const t0 = Date.now();
      const line = async (name, fn) => { try { await fn(); return `✅ ${name}: ${Date.now() - t0}ms`; } catch (e) { return `❌ ${name}: ${e.message}`; } };
      const [sc, sh, ig] = await Promise.all([
        line("SoundCloud", () => ctx.sc.search("test", 1, 1)),
        line("Shazam", () => ctx.shz.search("test", 1)),
        line("Instagram", () => ctx.insta.ping ? ctx.insta.ping() : Promise.resolve()),
      ]);
      return editOrReply(ctx, chatId, mid, `🧪 <b>سلامت</b>\n🎵 ${sc}\n🎤 ${sh}\n📸 ${ig}`, { reply_markup: kb([[R(t(lang, "back"), "nav:back")]]) });
    }
    case sub === "features": {
      const feat = (await H.get(ctx, "settings", "features")) || {};
      const keys = ["search", "insta", "recog", "inline", "groups", "channel"];
      const rows = keys.map((k) => [B(`${feat[k] !== false ? "✅" : "❌"} ${k}`, `adm:ft:${k}`)]);
      rows.push([R(t(lang, "back"), "nav:back")]);
      await answer(ctx, cq);
      return editOrReply(ctx, chatId, mid, "🔌 سرویس‌ها", { reply_markup: kb(rows) });
    }
    case sub.startsWith("ft:"): {
      const k = sub.slice(3);
      const feat = (await H.get(ctx, "settings", "features")) || {};
      feat[k] = feat[k] === false;
      await H.set(ctx, "settings", "features", feat);
      await answer(ctx, cq);
      return adminCb(ctx, cq, "features");
    }
    case sub === "fj": {
      const chans = (await ctx.store.getChannels()) || [];
      const rows = chans.map((c) => [B(`${c.enabled !== false ? "🟢" : "⚪️"} ${c.title || c.username || c.id}`, `adm:fjt:${c.id}`), R("🗑", `adm:fjd:${c.id}`)]);
      rows.push([G("➕ افزودن کانال", "adm:fjadd"), R(t(lang, "back"), "nav:back")]);
      await answer(ctx, cq);
      return editOrReply(ctx, chatId, mid, "📢 کانال‌ها", { reply_markup: kb(rows) });
    }
    case sub === "fjadd": {
      await ctx.store.put(`state:${uid}`, { wait: "fj_add" }, 600);
      await answer(ctx, cq);
      return ctx.tg.sendMessage(chatId, t(lang, "channel_add_prompt"));
    }
    case sub.startsWith("fjt:"): {
      const id = sub.slice(4); const c = await ctx.store.getChannel(id);
      if (c) { c.enabled = !(c.enabled !== false); await ctx.store.putChannel(id, c); }
      await answer(ctx, cq); return adminCb(ctx, cq, "fj");
    }
    case sub.startsWith("fjd:"): {
      await ctx.store.removeChannel(sub.slice(4));
      await answer(ctx, cq); return adminCb(ctx, cq, "fj");
    }
    case sub === "bans": {
      const users = (await ctx.store.listUsers()) || [];
      const banned = users.filter((u) => u.banned).slice(0, 20);
      const rows = banned.map((u) => [B(`🚫 ${u.id}`, "noop"), G("✅ آنبن", `adm:unban:${u.id}`)]);
      rows.push([G("🚫 بن کاربر", "adm:banadd"), R(t(lang, "back"), "nav:back")]);
      await answer(ctx, cq);
      return editOrReply(ctx, chatId, mid, `🚫 مسدودی‌ها (${banned.length})`, { reply_markup: kb(rows) });
    }
    case sub === "banadd": {
      await ctx.store.put(`state:${uid}`, { wait: "ban" }, 600);
      await answer(ctx, cq);
      return ctx.tg.sendMessage(chatId, t(lang, "ban_prompt"));
    }
    case sub.startsWith("unban:"): {
      const id = sub.slice(6);
      const u = (await ctx.store.getUser(id)) || {}; delete u.banned;
      await ctx.store.upsertUser(id, u);
      await answer(ctx, cq, t(lang, "unbanned_done", { id }), true);
      return adminCb(ctx, cq, "bans");
    }
    case sub === "tickets": {
      const tickets = (await H.get(ctx, "tickets", "list")) || [];
      const last = tickets.slice(-15);
      const text = last.length ? last.map((x) => `#${x.n} ${x.name} (${x.uid}):\n${x.text}`).join("\n\n") : "بدون تیکت";
      await answer(ctx, cq);
      return editOrReply(ctx, chatId, mid, `🎫 تیکت‌ها:\n\n${text}`, { reply_markup: kb([[R(t(lang, "back"), "nav:back")]]) });
    }
    case sub === "refs": {
      const rows = await ctx.store.listWithPrefix("referral:");
      const stats = rows.filter((r) => !String(r.key).includes(":")).map((r) => ({ id: r.key, ...r.value }));
      const text = stats.length ? stats.map((s) => `${s.id}: ${s.invited}/${s.verified}`).join("\n") : "بدون دعوت";
      await answer(ctx, cq);
      return editOrReply(ctx, chatId, mid, `👥 دعوت‌ها:\n\n${text}`, { reply_markup: kb([[R(t(lang, "back"), "nav:back")]]) });
    }
    case sub === "settings": {
      const rows = [
        [B(`ضد اسپم: ${settings.antispam !== false ? "روشن" : "خاموش"}`, "adm:st:antispam")],
        [B(`حالت نگهداری: ${settings.maintenance ? "روشن" : "خاموش"}`, "adm:st:maintenance")],
        [B(`عضویت اجباری: ${settings.forcejoin ? "روشن" : "خاموش"}`, "adm:st:forcejoin")],
        [B(`فرمت صوت: ${settings.audio_format === "m4a" ? "m4a" : "mp3"}`, "adm:st:audio")],
        [R(t(lang, "back"), "nav:back")],
      ];
      await answer(ctx, cq);
      return editOrReply(ctx, chatId, mid, "⚙️ تنظیمات", { reply_markup: kb(rows) });
    }
    case sub.startsWith("st:"): {
      const k = sub.slice(3);
      if (k === "antispam") settings.antispam = settings.antispam === false;
      else if (k === "maintenance") { settings.maintenance = !settings.maintenance; await ctx.store.setCfg("maintenance", settings.maintenance); }
      else if (k === "forcejoin") settings.forcejoin = !settings.forcejoin;
      else if (k === "audio") settings.audio_format = settings.audio_format === "m4a" ? "mp3" : "m4a";
      await H.set(ctx, "settings", "global", settings);
      await answer(ctx, cq);
      return adminCb(ctx, cq, "settings");
    }
    case sub === "bc": {
      await ctx.store.put(`state:${uid}`, { wait: "bc" }, 600);
      await answer(ctx, cq);
      return ctx.tg.sendMessage(chatId, "📣 پیام همگانی را بفرست:");
    }
    case sub === "langs": {
      await answer(ctx, cq);
      return showScreen(ctx, chatId, mid, "lang", {}, { push: true, cq });
    }
    case sub === "channels": {
      await answer(ctx, cq);
      return editOrReply(ctx, chatId, mid, "📢 کانال‌ها\n(انتشار خودکار کانال در این نسخه روی Worker پیاده‌سازی نشده است)", { reply_markup: kb([[R(t(lang, "back"), "nav:back")]]) });
    }
    case sub === "panel": {
      await answer(ctx, cq);
      return showScreen(ctx, chatId, mid, "admin", { uid }, { push: false, cq });
    }
    default: return answer(ctx, cq);
  }
}

SCREENS.admin = async (ctx, p, lang) => {
  const users = await ctx.store.countUsers().catch(() => 0);
  const groups = (await ctx.store.listChats().catch(() => [])).length;
  const s = await ctx.store.getStatTotal("searches").catch(() => 0);
  const d0 = await ctx.store.getStat("searches").catch(() => 0);
  const d = await ctx.store.getStatTotal("downloads").catch(() => 0);
  const dToday = await ctx.store.getStat("downloads").catch(() => 0);
  const r = await ctx.store.getStatTotal("rec").catch(() => 0);
  const rToday = await ctx.store.getStat("rec").catch(() => 0);
  const text = `🛠 <b>پنل مدیریت</b>\n👥 کاربران: ${num(lang, users)} · گروه‌ها: ${num(lang, groups)}\n🔍 جستجو: ${num(lang, s)} (امروز ${num(lang, d0)})\n⬇️ دانلود: ${num(lang, d)} (امروز ${num(lang, dToday)})\n🎤 شناسایی: ${num(lang, r)} (امروز ${num(lang, rToday)})`;
  const rows = [
    [B("📊 آمار", "adm:stats"), B("📢 کانال‌ها", "adm:channels")],
    [B("🔒 قفل عضویت", "adm:fj"), B("📣 پیام همگانی", "adm:bc")],
    [B("🎫 تیکت‌ها", "adm:tickets"), B("🚫 مسدودی‌ها", "adm:bans")],
    [B("🩺 سلامت", "adm:health"), B("⚙️ تنظیمات", "adm:settings")],
    [B("🌐 زبان‌ها", "adm:langs"), B("🔌 سرویس‌ها", "adm:features")],
    [B("👥 دعوت‌ها", "adm:refs")],
    [R("✖️ بستن", "nav:close"), B("🔄 تازه‌سازی", "adm:panel")],
  ];
  return { text, keyboard: kb(rows) };
};

export { doSearch, runDownload, showScreen, missingChannels, gateCheck, groupPerm };
