// Main message dispatcher: commands, plain text (search / lyrics / insta /
// soundcloud link), media (recognize), groups, admin state machine.

import { t } from "../i18n/index.js";
import { esc, extractInstagramUrl, extractSoundCloudUrl, looksLikeLyrics, normalize } from "../utils/text.js";
import { mainMenu, langMenu, kb, btn } from "../ui/keyboards.js";
import { handleSearch, deliverTrack, artistTracks } from "./search.js";
import { handleMedia, pickMedia, handleLyricsSnippet } from "./recognize.js";
import { handleInstaLink } from "./insta.js";
import { enforceJoin } from "./gate.js";
import { openPanel, handleAdminState } from "./admin.js";
import { welcomeText } from "./callback.js";
import { COMMANDS } from "./commands.js";

export async function handleMessage(ctx, msg) {
  if (!msg || !msg.chat) return;
  // Ignore other bots & channel posts without a from.
  if (msg.from?.is_bot) return;

  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const isGroup = ctx.isGroupChat(msg.chat.type);
  const lang = await ctx.langFor(userId, chatId);
  const text = (msg.text || msg.caption || "").trim();

  // Register user/chat (private chats create a profile; groups a chat rec).
  if (userId) {
    ctx.exec.waitUntil(ctx.store.upsertUser(userId, {
      first_name: msg.from.first_name, username: msg.from.username,
      createdAt: (await ctx.store.getUser(userId))?.createdAt || Date.now(),
    }));
  }
  if (isGroup) ctx.exec.waitUntil(ctx.store.upsertChat(chatId, { title: msg.chat.title }));

  // Banned users: silently refuse (except /start so they see the notice).
  if (userId) {
    const u = await ctx.store.getUser(userId);
    if (u?.banned) {
      if (!isGroup) await ctx.tg.sendMessage(chatId, t(lang, "banned") + (u.ban_reason ? `\n${esc(u.ban_reason)}` : ""));
      return;
    }
  }

  // Maintenance mode (owner/admin bypass).
  const maint = await ctx.cfg("maintenance", false);
  if (maint && (await ctx.roleOf(userId)) === "user") {
    if (!isGroup) {
      const mmsg = await ctx.cfg("maintenance_msg", "");
      await ctx.tg.sendMessage(chatId, t(lang, "maintenance", { msg: mmsg }));
    }
    return;
  }

  // Admin pending-input state machine (panel flows) — private only.
  if (!isGroup && userId) {
    const st = await ctx.store.get(`state:${userId}`);
    if (st && st.wait) {
      // menu waits that map to normal features
      if (st.wait === "search") { await ctx.store.del(`state:${userId}`); if (text) return handleSearch(ctx, msg, text); }
      else if (st.wait === "insta") { await ctx.store.del(`state:${userId}`); const u = extractInstagramUrl(text); if (u) return handleInstaLink(ctx, msg, u); }
      else if (st.wait === "recog") { await ctx.store.del(`state:${userId}`); if (pickMedia(msg)) return handleMedia(ctx, msg); }
      else {
        const consumed = await handleAdminState(ctx, msg, st);
        if (consumed !== false) return;
        await ctx.store.del(`state:${userId}`);
      }
    }
  }

  // ── commands ──────────────────────────────────────────────────────────
  const cmd = text.match(/^\/([A-Za-z_]+)(?:@\w+)?\s*(.*)$/);
  if (cmd) {
    const name = cmd[1].toLowerCase();
    const args = cmd[2].trim();
    switch (name) {
      case "start":
        if (!(await enforceJoin(ctx, msg, lang))) return;
        return ctx.tg.sendMessage(chatId, await welcomeText(ctx, msg.from), { reply_markup: mainMenu(lang, ctx.env.BOT_USERNAME) });
      case "help":
        return ctx.tg.sendMessage(chatId, t(lang, "help_text", { bot: ctx.env.BOT_USERNAME }));
      case "about":
        return ctx.tg.sendMessage(chatId, t(lang, "about_text", { name: ctx.env.BOT_NAME, dev: ctx.env.OWNER_USERNAME, version: ctx.env.VERSION || "1.0.0" }));
      case "lang":
        return ctx.tg.sendMessage(chatId, t(lang, "lang_pick"), { reply_markup: langMenu(lang) });
      case "fav": {
        const { showFavs } = await import("./callback.js");
        return showFavs(ctx, chatId, null, userId, lang, 1);
      }
      case "panel":
        if (isGroup) return;
        return openPanel(ctx, msg);
      case "music": case "song": case "find": case "search":
        if (name === "find" && !args && pickMedia(msg.reply_to_message || msg)) {
          // /find as a reply to media -> recognize
          const target = msg.reply_to_message || msg;
          if (!(await enforceJoin(ctx, msg, lang))) return;
          return handleMedia(ctx, target);
        }
        if (!args) return ctx.tg.sendMessage(chatId, t(lang, "search_prompt"));
        if (!(await enforceJoin(ctx, msg, lang))) return;
        return handleSearch(ctx, msg, args);
      case "settings":
        return handleGroupSettings(ctx, msg, lang);
      case "cancel":
        await ctx.store.del(`state:${userId}`);
        return;
      default:
        // unknown command -> ignore quietly (could be for another bot)
        return;
    }
  }

  // Group-specific settings UI.
  async function handleGroupSettings(c, m, l) {
    if (!isGroup) {
      return c.tg.sendMessage(chatId, t(l, "settings_title"), { reply_markup: kb([[btn(t(l, "btn_lang"), "m:lang")]]) });
    }
    // only admins can toggle group settings
    let isAdmin = false;
    try {
      const mm = await c.tg.getChatMember(chatId, userId);
      isAdmin = ["administrator", "creator"].includes(mm.status);
    } catch {}
    if (!isAdmin) return c.tg.sendMessage(chatId, t(l, "only_admin"));
    const chat = await c.store.getChat(chatId) || {};
    const mk = kb([
      [btn(`${t(l, "set_enabled")}: ${chat.enabled !== false ? t(l, "on") : t(l, "off")}`, "gset:en")],
      [btn(`${t(l, "set_lyrics")}: ${chat.auto_lyrics !== false ? t(l, "on") : t(l, "off")}`, "gset:lyr")],
      [btn(`${t(l, "set_lang")}: ${chat.lang || "fa"}`, "gset:lang")],
    ]);
    return c.tg.sendMessage(chatId, t(l, "settings_group"), { reply_markup: mk });
  }

  // ── media (voice/audio/video/document) -> recognition ────────────────
  if (pickMedia(msg)) {
    // In groups, require bot enabled + only respond when addressed? We accept
    // media recognition in private always; in groups only when /find is used
    // (handled above) to avoid noise.
    if (!isGroup) {
      if (!(await enforceJoin(ctx, msg, lang))) return;
      return handleMedia(ctx, msg);
    }
    return;
  }

  if (!text) return;

  // ── links ─────────────────────────────────────────────────────────────
  const instaUrl = extractInstagramUrl(text);
  if (instaUrl) {
    if (!(await enforceJoin(ctx, msg, lang))) return;
    return handleInstaLink(ctx, msg, instaUrl);
  }
  const scUrl = extractSoundCloudUrl(text);
  if (scUrl) {
    if (!(await enforceJoin(ctx, msg, lang))) return;
    try {
      const tr = await ctx.sc.resolve(scUrl);
      if (tr) return deliverTrack(ctx, msg, tr, lang);
    } catch {}
    return handleSearch(ctx, msg, text);
  }

  // ── plain text ────────────────────────────────────────────────────────
  if (isGroup) {
    // In groups, plain text only triggers via /music or reply — not free text,
    // to avoid the bot responding to every message.
    return;
  }

  if (!(await enforceJoin(ctx, msg, lang))) return;

  // Rate limit (private interactive use).
  if (userId) {
    const rl = await ctx.store.rateLimit(userId, +(await ctx.cfg("rate", ctx.env.RATE_LIMIT_PER_MIN || 20)));
    if (!rl.allowed) return ctx.tg.sendMessage(chatId, t(lang, "cooldown", { sec: rl.retryAfter }));
  }

  // Lyrics snippet? (≥5 words, no "A - B") -> lyric search. Otherwise search.
  if (looksLikeLyrics(text) && normalize(text).split(" ").length >= 6) {
    return handleLyricsSnippet(ctx, msg, text);
  }
  return handleSearch(ctx, msg, text);
}
