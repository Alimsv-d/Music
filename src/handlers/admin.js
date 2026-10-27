// Owner/admin panel: stats, forced-join, broadcast, ban, settings, tools.
// Every callback re-verifies role server-side. Owner-only sections are gated.

import { t } from "../i18n/index.js";
import { esc } from "../utils/text.js";
import { secret } from "../utils/secrets.js";
import {
  panelMenu, joinChannelList, adminList, settingsMenu, toolsMenu, banMenu,
  broadcastTargets, kb, btn,
} from "../ui/keyboards.js";

const OWNER_ONLY = new Set(["adm", "cfg", "tools", "twhset", "twhinfo", "twhdel", "tcache", "ttest", "tcsv", "terrors", "cmain", "clyr", "cinline", "cpage", "crate", "clang", "cwel", "csup", "admadd", "admd"]);

export async function openPanel(ctx, msg) {
  const userId = msg.from.id;
  const role = await ctx.roleOf(userId);
  if (role === "user") return; // silent: not for normal users
  const lang = await ctx.langFor(userId, msg.chat.id);
  return ctx.tg.sendMessage(msg.chat.id, t(lang, "panel_title", { role }), { reply_markup: panelMenu(lang, role) });
}

export async function handlePanelCallback(ctx, cq, { chatId, msgId, userId, lang, answer }) {
  const role = await ctx.roleOf(userId);
  if (role === "user") return answer(t(lang, "panel_denied"), true);
  const parts = cq.data.split(":");
  const section = parts[1];
  const arg = parts.slice(2).join(":");

  const isOwner = role === "owner";
  const needsOwner = [...OWNER_ONLY].some((s) => section === s || section.startsWith(s));
  const ownerSections = ["adm", "tools", "admadd", "admd", "twhset", "twhinfo", "twhdel", "tcache", "ttest", "tcsv", "terrors", "cmain", "clyr", "cinline", "cpage", "crate", "clang", "cwel", "csup"];
  if (ownerSections.includes(section) && !isOwner) return answer(t(lang, "owner_only"), true);

  const edit = (text, markup) => ctx.tg.editMessageText(chatId, msgId, text, { reply_markup: markup }).catch(() => {});
  const back = kb([[btn(t(lang, "back"), "pn:home")]]);

  switch (section) {
    case "home":
      await answer();
      return edit(t(lang, "panel_title", { role }), panelMenu(lang, role));

    case "stats": {
      await answer();
      const html = await buildStats(ctx, lang);
      return edit(html, back);
    }

    // ── forced join ─────────────────────────────────────────────────────
    case "join": {
      await answer();
      const chans = await ctx.store.getChannels();
      const enabled = await ctx.cfg("forced_join", false);
      const list = chans.length
        ? chans.map((c, i) => `${i + 1}. ${c.enabled ? "🟢" : "⚪️"} ${esc(c.title || c.username || c.id)}`).join("\n")
        : "—";
      return edit(t(lang, "channel_list", { list }), joinChannelList(lang, chans, enabled));
    }
    case "jtg": {
      const cur = await ctx.cfg("forced_join", false);
      await ctx.store.setCfg("forced_join", !cur);
      await answer();
      const chans = await ctx.store.getChannels();
      const list = chans.length ? chans.map((c, i) => `${i + 1}. ${c.enabled ? "🟢" : "⚪️"} ${esc(c.title || c.username || c.id)}`).join("\n") : "—";
      return edit(t(lang, "channel_list", { list }), joinChannelList(lang, chans, !cur));
    }
    case "chadd": {
      await ctx.store.put(`state:${userId}`, { wait: "ch_add" }, 600);
      await answer();
      return edit(t(lang, "channel_add_prompt"), back);
    }
    case "chd": {
      await ctx.store.removeChannel(arg);
      await answer(t(lang, "channel_removed"));
      const chans = await ctx.store.getChannels();
      const enabled = await ctx.cfg("forced_join", false);
      const list = chans.length ? chans.map((c, i) => `${i + 1}. ${c.enabled ? "🟢" : "⚪️"} ${esc(c.title || c.username || c.id)}`).join("\n") : "—";
      return edit(t(lang, "channel_list", { list }), joinChannelList(lang, chans, enabled));
    }
    case "chv": { // toggle channel enabled
      const c = await ctx.store.getChannel(arg);
      if (c) { c.enabled = !c.enabled; await ctx.store.putChannel(arg, c); }
      await answer();
      const chans = await ctx.store.getChannels();
      const enabled = await ctx.cfg("forced_join", false);
      const list = chans.length ? chans.map((c2, i) => `${i + 1}. ${c2.enabled ? "🟢" : "⚪️"} ${esc(c2.title || c2.username || c2.id)}`).join("\n") : "—";
      return edit(t(lang, "channel_list", { list }), joinChannelList(lang, chans, enabled));
    }

    // ── broadcast ────────────────────────────────────────────────────────
    case "bc": {
      await ctx.store.put(`state:${userId}`, { wait: "broadcast" }, 600);
      await answer();
      return edit(t(lang, "broadcast_prompt"), back);
    }
    case "bcs": { // start broadcast: pn:bcs:<jobId>:<target>
      const [jobId, target] = arg.split(":");
      const job = await ctx.store.getJob(jobId);
      if (!job) return answer(t(lang, "expired"), true);
      job.target = target; job.status = "queued"; job.progress = { sent: 0, blocked: 0, failed: 0, total: 0 };
      await ctx.store.putJob(jobId, job);
      await answer(t(lang, "broadcast_started"), true);
      ctx.exec.waitUntil(runBroadcastChunk(ctx, jobId));
      return edit(t(lang, "broadcast_started"), kb([[btn("🛑", `pn:bcc:${jobId}`), btn(t(lang, "back"), "pn:home")]]));
    }
    case "bcc": { // cancel broadcast
      await ctx.store.deleteJob(arg);
      await answer(t(lang, "cancel"));
      return edit(t(lang, "cancel"), back);
    }

    // ── ban ──────────────────────────────────────────────────────────────
    case "ban": {
      await answer();
      const banned = await bannedCount(ctx);
      return edit("🚫", banMenu(lang, banned));
    }
    case "banadd":
      await ctx.store.put(`state:${userId}`, { wait: "ban_add" }, 600);
      await answer();
      return edit(t(lang, "ban_prompt"), back);
    case "banrm":
      await ctx.store.put(`state:${userId}`, { wait: "ban_rm" }, 600);
      await answer();
      return edit(t(lang, "ban_prompt"), back);
    case "banlist": {
      const users = await ctx.store.listUsers();
      const banned = users.filter((u) => u.banned);
      const list = banned.length ? banned.map((u) => `• <code>${u.id}</code> ${u.ban_reason ? "— " + esc(u.ban_reason) : ""}`).join("\n") : "—";
      await answer();
      return edit(list, back);
    }

    // ── admins (owner) ───────────────────────────────────────────────────
    case "adm": {
      await answer();
      const admins = await ctx.store.getAdmins();
      const list = admins.length ? admins.map((a) => `• <code>${a.id}</code>`).join("\n") : "—";
      return edit(t(lang, "admins_list", { list }), adminList(lang, admins));
    }
    case "admadd":
      await ctx.store.put(`state:${userId}`, { wait: "admin_add" }, 600);
      await answer();
      return edit(t(lang, "ask_admin_id"), back);
    case "admd": {
      await ctx.store.removeAdmin(arg);
      await answer(t(lang, "admin_removed", { id: arg }));
      const admins = await ctx.store.getAdmins();
      const list = admins.length ? admins.map((a) => `• <code>${a.id}</code>`).join("\n") : "—";
      return edit(t(lang, "admins_list", { list }), adminList(lang, admins));
    }

    // ── settings ─────────────────────────────────────────────────────────
    case "cfg": {
      await answer();
      return edit(t(lang, "settings_title"), settingsMenu(lang, await allCfg(ctx)));
    }
    case "cmain": {
      const cur = await ctx.cfg("maintenance", false);
      await ctx.store.setCfg("maintenance", !cur);
      await answer(t(lang, !cur ? "maintenance_on" : "maintenance_off"));
      return edit(t(lang, "settings_title"), settingsMenu(lang, await allCfg(ctx)));
    }
    case "clyr": {
      const cur = await ctx.cfg("auto_lyrics", true);
      await ctx.store.setCfg("auto_lyrics", !cur);
      await answer();
      return edit(t(lang, "settings_title"), settingsMenu(lang, await allCfg(ctx)));
    }
    case "cinline": {
      const cur = await ctx.cfg("inline", true);
      await ctx.store.setCfg("inline", !cur);
      await answer();
      return edit(t(lang, "settings_title"), settingsMenu(lang, await allCfg(ctx)));
    }
    case "cpage": await ask(ctx, userId, "cfg_page", t(lang, "pagesize_prompt"), edit, back, answer);
      return;
    case "crate": await ask(ctx, userId, "cfg_rate", t(lang, "rate_prompt"), edit, back, answer);
      return;
    case "clang": await ask(ctx, userId, "cfg_lang", t(lang, "deflang_prompt"), edit, back, answer);
      return;
    case "cwel": await ask(ctx, userId, "cfg_welcome", t(lang, "welcome_edit_prompt"), edit, back, answer);
      return;
    case "csup": await ask(ctx, userId, "cfg_support", t(lang, "support_prompt"), edit, back, answer);
      return;

    // ── tools (owner) ────────────────────────────────────────────────────
    case "tools":
      await answer();
      return edit("🛠", toolsMenu(lang));
    case "twhinfo": {
      await answer();
      const info = await ctx.tg.getWebhookInfo().catch(() => null);
      return edit(t(lang, "webhook_info", {
        url: esc(info?.url || "—"), pending: info?.pending_update_count ?? "—",
        err: esc(info?.last_error_message || "—"),
      }), back);
    }
    case "twhset": {
      await answer();
      const r = await setupWebhook(ctx);
      return edit(esc(r), back);
    }
    case "twhdel": {
      await ctx.tg.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
      await answer();
      return edit("🗑 webhook deleted", back);
    }
    case "tcache": {
      // Clear search/track caches by deleting the prefixes we own.
      for (const p of ["srch:", "track:", "pending:", "mem:"]) {
        let cursor;
        do {
          const page = await ctx.env.KV.list({ prefix: p, cursor, limit: 1000 });
          for (const k of page.keys) await ctx.env.KV.delete(k.name).catch(() => {});
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
      }
      await answer(t(lang, "cache_cleared"));
      return edit(t(lang, "cache_cleared"), back);
    }
    case "ttest": {
      await answer();
      const r = await selfTest(ctx);
      return edit(t(lang, "selftest", { results: r }), back);
    }
    case "tcsv": {
      await answer();
      const users = await ctx.store.listUsers();
      const csv = "id,first_name,username,lang,lastSeen,banned,inactive\n" +
        users.map((u) => `${u.id},${csvCell(u.first_name)},${csvCell(u.username)},${u.lang || ""},${u.lastSeen || ""},${u.banned ? 1 : 0},${u.inactive ? 1 : 0}`).join("\n");
      return ctx.tg.sendDocument(chatId, {
        document: `data:text/csv;base64,${btoa(unescape(encodeURIComponent(csv)))}`,
        caption: t(lang, "csv_caption", { count: users.length }),
      });
    }
    case "terrors": {
      await answer();
      const errs = await ctx.store.getErrors();
      const list = errs.length
        ? errs.map((e) => `• <code>${esc(e.where || "")}</code> ${esc((e.msg || "").slice(0, 80))}`).join("\n")
        : t(lang, "no_errors");
      return edit(t(lang, "last_errors", { list }), back);
    }

    default:
      return answer();
  }
}

async function ask(ctx, userId, wait, prompt, edit, back, answer) {
  await ctx.store.put(`state:${userId}`, { wait }, 600);
  await answer();
  return edit(prompt, back);
}

async function allCfg(ctx) {
  return {
    maintenance: await ctx.cfg("maintenance", false),
    auto_lyrics: await ctx.cfg("auto_lyrics", true),
    inline: await ctx.cfg("inline", true),
    page_size: await ctx.cfg("page_size", ctx.env.PAGE_SIZE || 10),
    rate: await ctx.cfg("rate", ctx.env.RATE_LIMIT_PER_MIN || 20),
    default_lang: await ctx.cfg("default_lang", "fa"),
  };
}

async function bannedCount(ctx) {
  const users = await ctx.store.listUsers();
  return users.filter((u) => u.banned).length;
}

async function buildStats(ctx, lang) {
  const users = await ctx.store.listUsers();
  const chats = await ctx.store.listChats();
  const now = Date.now();
  const day = 86400000;
  const dau = users.filter((u) => now - (u.lastSeen || 0) < day).length;
  const wau = users.filter((u) => now - (u.lastSeen || 0) < 7 * day).length;
  const mau = users.filter((u) => now - (u.lastSeen || 0) < 30 * day).length;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const newToday = users.filter((u) => new Date(u.createdAt || u.lastSeen || 0).toISOString().slice(0, 10).replace(/-/g, "") === today).length;

  const [sT, sTot, dT, dTot, rT, rTot, ch, errs] = await Promise.all([
    ctx.store.getStat("searches"), ctx.store.getStatTotal("searches"),
    ctx.store.getStat("downloads"), ctx.store.getStatTotal("downloads"),
    ctx.store.getStat("recognitions"), ctx.store.getStatTotal("recognitions"),
    ctx.store.getStatTotal("cache_hits"), ctx.store.getErrors(),
  ]);
  const cacheRatio = sTot ? Math.min(100, Math.round((ch / sTot) * 100)) : 0;
  const health = await apiHealth(ctx);
  return t(lang, "stats_text", {
    users: users.length, dau, wau, mau, new_today: newToday, groups: chats.length,
    s_today: sT, s_total: sTot, d_today: dT, d_total: dTot, r_today: rT, r_total: rTot,
    cache: cacheRatio, errors: errs.length, health,
  });
}

async function apiHealth(ctx) {
  const [sc, shz, insta, lyr] = await Promise.all([
    ctx.sc.ping(), ctx.shz.ping(), ctx.insta.ping(), ctx.lyr.ping(),
  ]);
  const line = (n, ms) => `${ms >= 0 ? "🟢" : "🔴"} ${n}: ${ms >= 0 ? ms + "ms" : "down"}`;
  return [line("SoundCloud", sc), line("Shazam", shz), line("Instagram", insta), line("LRCLIB", lyr)].join("\n");
}

async function selfTest(ctx) {
  const lines = [];
  const t0 = Date.now();
  try {
    const me = await ctx.tg.getMe();
    lines.push(`🟢 Telegram: @${me.username} (${Date.now() - t0}ms)`);
  } catch (e) { lines.push(`🔴 Telegram: ${esc(e.message)}`); }
  try {
    const r = await ctx.sc.search("test", 1, 1);
    lines.push(`🟢 SoundCloud search: ${r.length} results`);
  } catch (e) { lines.push(`🔴 SoundCloud: ${esc(e.message)}`); }
  lines.push(await apiHealth(ctx));
  return lines.join("\n");
}

export async function setupWebhook(ctx) {
  const base = ctx.env.PUBLIC_URL || "";
  const url = `${base.replace(/\/$/, "")}/webhook`;
  try {
    await ctx.tg.setWebhook(url, {
      secret_token: await secret(ctx.env, "WEBHOOK_SECRET"),
      allowed_updates: ["message", "edited_message", "callback_query", "inline_query", "chosen_inline_result", "my_chat_member", "chat_member"],
      drop_pending_updates: true,
      max_connections: 40,
    });
    return `webhook set -> ${url}`;
  } catch (e) {
    return `webhook failed: ${e.message}`;
  }
}
export { selfTest, apiHealth, buildStats, setupWebhook as doSetupWebhook };

// ── broadcast engine ─────────────────────────────────────────────────────────
// Processes ~25 msgs/sec in chunks; self-chains via ctx.waitUntil + also runs
// from the cron trigger so it survives a single-request timeout.
export async function runBroadcastChunk(ctx, jobId) {
  const job = await ctx.store.getJob(jobId);
  if (!job || job.status === "done" || job.status === "cancelled") return;
  job.status = "running";

  // Build recipient list once.
  if (!job.recipients) {
    let users = await ctx.store.listUsers();
    if (job.target === "groups") {
      const chats = await ctx.store.listChats();
      job.recipients = chats.map((c) => c.id);
    } else {
      if (job.target === "active") users = users.filter((u) => !u.inactive && Date.now() - (u.lastSeen || 0) < 30 * 86400000);
      job.recipients = users.map((u) => u.id);
    }
    job.progress.total = job.recipients.length;
    job.cursor = 0;
  }

  const chunk = job.recipients.slice(job.cursor, job.cursor + 20);
  for (const rid of chunk) {
    try {
      await ctx.tg.copyMessage(rid, job.fromChatId, job.messageId);
      job.progress.sent++;
    } catch (e) {
      if (e.blocked || e.code === 403) { job.progress.blocked++; await ctx.store.setUserInactive(rid).catch(() => {}); }
      else if (e.retryAfter) { await new Promise((r) => setTimeout(r, e.retryAfter * 1000)); job.recipients.push(rid); }
      else job.progress.failed++;
    }
    await new Promise((r) => setTimeout(r, 40)); // ~25 msg/sec
  }
  job.cursor += chunk.length;
  await ctx.store.putJob(jobId, job);

  if (job.cursor >= job.recipients.length) {
    job.status = "done";
    await ctx.store.putJob(jobId, job);
    const lang = await ctx.langFor(job.by, job.by);
    await ctx.tg.sendMessage(job.by, t(lang, "broadcast_done", job.progress)).catch(() => {});
    await ctx.store.deleteJob(jobId);
  } else {
    // continue in background
    ctx.exec.waitUntil(runBroadcastChunk(ctx, jobId));
  }
}

// ── state machine for admin text input (called from message handler) ────────
// Returns true if the message was consumed as panel input.
export async function handleAdminState(ctx, msg, state) {
  const lang = await ctx.langFor(msg.from.id, msg.chat.id);
  const uid = msg.from.id;
  const text = (msg.text || "").trim();
  const done = () => ctx.store.del(`state:${uid}`);

  const getTargetId = async () => {
    if (msg.reply_to_message?.from?.id) return String(msg.reply_to_message.from.id);
    if (msg.forward_from?.id) return String(msg.forward_from.id);
    const m = text.match(/@([A-Za-z0-9_]{5,})/);
    if (text.match(/^\d+$/)) return text;
    return null;
  };

  switch (state.wait) {
    case "admin_add": {
      const id = await getTargetId();
      await done();
      if (!id) return ctx.tg.sendMessage(msg.chat.id, t(lang, "error_generic"));
      await ctx.store.addAdmin(id, { by: uid });
      return ctx.tg.sendMessage(msg.chat.id, t(lang, "admin_added", { id }));
    }
    case "ban_add": {
      const id = await getTargetId();
      if (!id) { await done(); return ctx.tg.sendMessage(msg.chat.id, t(lang, "error_generic")); }
      await ctx.store.put(`state:${uid}`, { wait: "ban_reason", target: id }, 600);
      return ctx.tg.sendMessage(msg.chat.id, t(lang, "ban_reason_prompt"));
    }
    case "ban_reason": {
      const reason = text === "-" ? "" : text;
      await done();
      const u = await ctx.store.upsertUser(state.target, { banned: true, ban_reason: reason });
      return ctx.tg.sendMessage(msg.chat.id, t(lang, "banned_done", { id: state.target }));
    }
    case "ban_rm": {
      const id = await getTargetId();
      await done();
      if (!id) return ctx.tg.sendMessage(msg.chat.id, t(lang, "error_generic"));
      await ctx.store.upsertUser(id, { banned: false, ban_reason: "" });
      return ctx.tg.sendMessage(msg.chat.id, t(lang, "unbanned_done", { id }));
    }
    case "ch_add": {
      await done();
      return addChannel(ctx, msg, text, lang);
    }
    case "broadcast": {
      // Store the message to copy, ask target.
      const jobId = `bc${Date.now().toString(36)}`;
      await ctx.store.putJob(jobId, {
        id: jobId, by: uid, fromChatId: msg.chat.id, messageId: msg.message_id,
        status: "pending",
      });
      await done();
      return ctx.tg.sendMessage(msg.chat.id, t(lang, "broadcast_who"), { reply_markup: broadcastTargets(lang, jobId) });
    }
    case "cfg_page": {
      const n = parseInt(text, 10);
      await done();
      if (isFinite(n) && n >= 5 && n <= 20) await ctx.store.setCfg("page_size", n);
      return ctx.tg.sendMessage(msg.chat.id, t(lang, "setting_saved"));
    }
    case "cfg_rate": {
      const n = parseInt(text, 10);
      await done();
      if (isFinite(n) && n >= 1 && n <= 100) await ctx.store.setCfg("rate", n);
      return ctx.tg.sendMessage(msg.chat.id, t(lang, "setting_saved"));
    }
    case "cfg_lang": {
      await done();
      if (["fa", "en"].includes(text)) await ctx.store.setCfg("default_lang", text);
      return ctx.tg.sendMessage(msg.chat.id, t(lang, "setting_saved"));
    }
    case "cfg_welcome": {
      await done();
      await ctx.store.setCfg("welcome", text);
      return ctx.tg.sendMessage(msg.chat.id, t(lang, "setting_saved"));
    }
    case "cfg_support": {
      await done();
      await ctx.store.setCfg("support_url", text);
      return ctx.tg.sendMessage(msg.chat.id, t(lang, "setting_saved"));
    }
  }
  return false;
}

async function addChannel(ctx, msg, text, lang) {
  let id = null, username = null, invite = null;
  const user = text.match(/@([A-Za-z0-9_]{5,})/);
  const link = text.match(/t\.me\/(?:\+|joinchat\/)?([A-Za-z0-9_-]+)/);
  const numId = text.match(/-100\d+/);
  if (numId) id = numId[0];
  else if (user) { username = "@" + user[1]; id = username; }
  else if (link) {
    if (text.includes("+") || text.includes("joinchat")) { invite = text; }
    else { username = "@" + link[1]; id = username; }
  }
  if (!id && !invite) return ctx.tg.sendMessage(msg.chat.id, t(lang, "error_generic"));

  // resolve a numeric id + title + verify bot is admin where possible
  let title = username || id || "";
  let warn = "";
  try {
    const chat = await ctx.tg.getChat(id);
    if (chat?.id) { id = String(chat.id); title = chat.title || chat.username || title; }
    const me = await ctx.tg.getMe();
    const m = await ctx.tg.getChatMember(id, me.id).catch(() => null);
    if (m && !["administrator", "creator"].includes(m.status)) warn = "\n" + t(lang, "not_admin_channel");
  } catch (e) {
    if (!invite) warn = "\n" + t(lang, "not_admin_channel");
  }

  const key = id || invite;
  await ctx.store.putChannel(key, { id: key, title, username, invite, enabled: true });
  return ctx.tg.sendMessage(msg.chat.id, t(lang, "channel_added", { id: esc(key) }) + warn);
}

function csvCell(s) {
  s = String(s ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
