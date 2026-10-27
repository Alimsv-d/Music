// Inline keyboard builders. All buttons route through the `act:`/`cb:`
// namespace handled by handlers/callback.js. callback_data stays <= 64 bytes
// by storing result sets in KV under a short id and only putting `id:page`.

import { t, langName } from "../i18n/index.js";
import { fmtDuration } from "../utils/text.js";

export const kb = (rows) => ({ inline_keyboard: rows });

// Telegram button styles used by the cPanel version. Keep semantic helpers so
// every screen uses the same visual language as the tested host deployment.
export const btn = (text, callback_data, style = "primary") => ({ text, callback_data, style });
export const G = (text, callback_data) => btn(text, callback_data, "success");
export const B = (text, callback_data) => btn(text, callback_data, "primary");
export const R = (text, callback_data) => btn(text, callback_data, "danger");
export const urlBtn = (text, url, style = "primary") => ({ text, url, style });
export const inlineBtn = (text, query, style = "primary") => ({ text, switch_inline_query: query, style });
export const inlineCurrentBtn = (text, query, style = "primary") => ({ text, switch_inline_query_current_chat: query, style });

/** Main /start menu — matches the cPanel/grammy deployment. */
export function mainMenu(lang, bot) {
  return kb([
    [urlBtn(t(lang, "menu_addgroup"), `https://t.me/${bot || "SearcherMusiic_Bot"}?startgroup=true&admin=delete_messages+pin_messages`, "success")],
    [urlBtn(t(lang, "menu_channel"), "https://t.me/MusicMsvD"), B(t(lang, "menu_lang"), "m:lang")],
    [B("👥 دعوت دوستان", "m:invite"), B(t(lang, "menu_help"), "m:help"), B(t(lang, "menu_support"), "m:support")],
  ]);
}

/** Language picker. */
export function langMenu(lang) {
  return kb([
    [btn(langName("fa"), "lang:fa"), btn(langName("en"), "lang:en")],
    [btn(t(lang, "back"), "m:home")],
  ]);
}

/**
 * Paginated list of tracks.
 * items: Track[]; id: KV search-handle; page: 0-indexed; pageSize.
 * extra rows appended (e.g. playlists / new-search).
 */
export function trackList(lang, items, id, page, pageSize, opts = {}) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(page, pages - 1);
  const slice = items.slice(p * pageSize, (p + 1) * pageSize);
  const rows = slice.map((tr, i) => {
    const idx = p * pageSize + i;
    const label = `🎵 ${tr.artist ? tr.artist + " – " : ""}${tr.title}${tr.duration_ms ? " (" + fmtDuration(tr.duration_ms, lang) + ")" : ""}`;
    return [btn(truncate(label, 60), `act:t:${id}:${idx}`)];
  });

  const nav = [];
  if (p > 0) nav.push(btn(t(lang, "prev"), `act:pg:${id}:${p - 1}`));
  nav.push(btn(t(lang, "page_x_of_y", { cur: p + 1, total: pages }), "act:noop"));
  if (p < pages - 1) nav.push(btn(t(lang, "next"), `act:pg:${id}:${p + 1}`));
  if (nav.length) rows.push(nav);

  if (opts.playlists) rows.push([btn(t(lang, "btn_playlists"), `act:pl:${id}:0`)]);
  rows.push([btn(t(lang, "btn_search_other"), "m:search")]);
  return { markup: kb(rows), page: p, pages };
}

/** Buttons under a delivered track. */
export function trackActions(lang, tr, opts = {}) {
  const favCb = opts.isFav ? `act:ufav:${tr.keyId || tr.id}` : `act:fav:${tr.keyId || tr.id}`;
  return kb([
    [
      btn(t(lang, "btn_lyrics"), `act:lyr:${tr.keyId || tr.id}`),
      btn(t(lang, "btn_more_artist"), `act:art:${encodeURIComponent(tr.artist || "")}`),
    ],
    [
      inlineBtn(t(lang, "btn_share"), `${tr.artist} ${tr.title}`.trim()),
      btn(opts.isFav ? t(lang, "btn_fav_del") : t(lang, "btn_fav_add"), favCb),
    ],
  ]);
}

/** Recognized-track result buttons. */
export function recognizedActions(lang, tr) {
  return kb([
    [btn(t(lang, "btn_dl_mp3"), `act:rdl:${tr.keyId || tr.id}`)],
    [
      btn(t(lang, "btn_lyrics"), `act:lyr:${tr.keyId || tr.id}`),
      btn(t(lang, "btn_more_artist"), `act:art:${encodeURIComponent(tr.artist || "")}`),
    ],
  ]);
}

/** Forced-join prompt: one button per channel + a re-check. */
export function joinButtons(lang, channels) {
  const rows = channels.map((c) => [urlBtn(`📢 ${c.title || c.username || c.id}`, c.invite || channelLink(c))]);
  rows.push([btn(t(lang, "joined_check"), "act:joined")]);
  return kb(rows);
}

function channelLink(c) {
  if (c.username) return `https://t.me/${c.username.replace(/^@/, "")}`;
  if (c.invite) return c.invite;
  return `https://t.me/c/${String(c.id).replace(/^-100/, "")}`;
}

/** Owner/admin panel root. */
export function panelMenu(lang, role) {
  const rows = [
    [btn(t(lang, "panel_stats"), "pn:stats"), btn(t(lang, "panel_broadcast"), "pn:bc")],
    [btn(t(lang, "panel_join"), "pn:join"), btn(t(lang, "panel_ban"), "pn:ban")],
  ];
  if (role === "owner") {
    rows.push([btn(t(lang, "panel_settings"), "pn:cfg"), btn(t(lang, "panel_admins"), "pn:adm")]);
    rows.push([btn(t(lang, "panel_tools"), "pn:tools")]);
  } else {
    rows.push([btn(t(lang, "panel_settings"), "pn:cfg")]);
  }
  return kb(rows);
}

export function truncate(s, n = 60) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Broadcast target picker. */
export function broadcastTargets(lang, jobId) {
  return kb([
    [btn(t(lang, "bc_all"), `pn:bcs:${jobId}:all`), btn(t(lang, "bc_groups"), `pn:bcs:${jobId}:groups`)],
    [btn(t(lang, "bc_active"), `pn:bcs:${jobId}:active`)],
    [btn(t(lang, "cancel"), `pn:bcc:${jobId}`)],
  ]);
}

/** Forced-join channel list management. */
export function joinChannelList(lang, channels, enabled) {
  const rows = [[btn(`${t(lang, "join_toggle")}: ${enabled ? t(lang, "on") : t(lang, "off")}`, "pn:jtg")]];
  channels.forEach((c) => {
    rows.push([
      btn(`${c.enabled ? "🟢" : "⚪️"} ${truncate(c.title || c.username || c.id, 22)}`, `pn:chv:${c.id}`),
      btn("🗑", `pn:chd:${c.id}`),
    ]);
  });
  rows.push([btn("➕", "pn:chadd"), btn(t(lang, "back"), "pn:home")]);
  return kb(rows);
}

export function adminList(lang, admins) {
  const rows = admins.map((a) => [btn(`👤 ${a.id}`, "act:noop"), btn("🗑", `pn:admd:${a.id}`)]);
  rows.push([btn("➕", "pn:admadd"), btn(t(lang, "back"), "pn:home")]);
  return kb(rows);
}

export function settingsMenu(lang, cfg) {
  const g = (k) => cfg[k];
  return kb([
    [btn(`🛠 ${t(lang, "maintenance").split("\n")[0].replace("🛠 ", "")}: ${g("maintenance") ? t(lang, "on") : t(lang, "off")}`, "pn:cmain")],
    [btn(`📝 auto-lyrics: ${g("auto_lyrics") !== false ? t(lang, "on") : t(lang, "off")}`, "pn:clyr")],
    [btn(`♾ inline: ${g("inline") !== false ? t(lang, "on") : t(lang, "off")}`, "pn:cinline")],
    [btn(`📄 page size: ${g("page_size") || 10}`, "pn:cpage"), btn(`⏱ rate: ${g("rate") || 20}/min`, "pn:crate")],
    [btn(`🌐 default lang: ${g("default_lang") || "fa"}`, "pn:clang")],
    [btn("💬 welcome", "pn:cwel"), btn(t(lang, "btn_support"), "pn:csup")],
    [btn(t(lang, "back"), "pn:home")],
  ]);
}

export function toolsMenu(lang) {
  return kb([
    [btn("🔗 set webhook", "pn:twhset"), btn("📋 webhook info", "pn:twhinfo")],
    [btn("🧹 clear cache", "pn:tcache"), btn("🩺 self-test", "pn:ttest")],
    [btn("📄 export users", "pn:tcsv"), btn("🧾 last errors", "pn:terrors")],
    [btn("🗑 delete webhook", "pn:twhdel"), btn(t(lang, "back"), "pn:home")],
  ]);
}

export function banMenu(lang, bannedCount) {
  return kb([
    [btn("🚫 بن کاربر", "pn:banadd"), btn("✅ آنبن", "pn:banrm")],
    [btn(`📋 لیست بن (${bannedCount})`, "pn:banlist"), btn(t(lang, "back"), "pn:home")],
  ]);
}
