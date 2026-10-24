// Forced-join gate. Reads enabled channels from KV, checks membership via
// getChatMember, caches each result 60s, and FAILS OPEN on Telegram API errors
// so a transient outage never locks every user out.

import { t } from "../i18n/index.js";
import { joinButtons } from "../ui/keyboards.js";

const MEMBER_STATUSES = new Set(["member", "administrator", "creator", "restricted"]);

/** Returns true if user may proceed (member of all enabled channels, or none). */
export async function checkJoin(ctx, userId) {
  const enabled = await ctx.cfg("forced_join", false);
  if (!enabled) return true;
  const channels = (await ctx.store.getChannels()).filter((c) => c.enabled);
  if (!channels.length) return true;
  const missing = await missingChannels(ctx, userId, channels);
  return missing.length === 0;
}

/** Returns the list of channels the user hasn't joined (fail-open on error). */
export async function missingChannels(ctx, userId, channels) {
  const missing = [];
  for (const c of channels) {
    const cached = await ctx.store.getMembership(userId, c.id);
    if (cached && Date.now() - cached.at < 60000) {
      if (!cached.ok) missing.push(c);
      continue;
    }
    try {
      const m = await ctx.tg.getChatMember(c.id, userId);
      const ok = MEMBER_STATUSES.has(m.status) &&
        !(m.status === "restricted" && m.is_member === false);
      await ctx.store.putMembership(userId, c.id, ok);
      if (!ok) missing.push(c);
    } catch (e) {
      // FAIL OPEN: if Telegram errors, don't lock the user out.
      await ctx.store.logError({ where: "getChatMember", msg: e.message, ch: c.id });
    }
  }
  return missing;
}

/** Enforce the gate on an incoming message. Returns true if allowed. */
export async function enforceJoin(ctx, msg, lang) {
  const userId = msg.from?.id;
  if (!userId) return true;
  // Owner/admins bypass.
  const role = await ctx.roleOf(userId);
  if (role !== "user") return true;

  const enabled = await ctx.cfg("forced_join", false);
  if (!enabled) return true;
  const channels = (await ctx.store.getChannels()).filter((c) => c.enabled);
  if (!channels.length) return true;
  const missing = await missingChannels(ctx, userId, channels);
  if (!missing.length) return true;

  const sent = await ctx.tg.sendMessage(msg.chat.id, t(lang, "join_first"), {
    reply_markup: joinButtons(lang, missing),
    reply_to_message_id: msg.message_id,
  }).catch(() => null);

  // Auto-delete the prompt in groups after 30s to keep things tidy.
  if (ctx.isGroupChat(msg.chat.type) && sent) {
    ctx.exec.waitUntil((async () => {
      await new Promise((r) => setTimeout(r, 30000));
      ctx.tg.deleteMessage(msg.chat.id, sent.message_id).catch(() => {});
    })());
  }
  return false;
}
