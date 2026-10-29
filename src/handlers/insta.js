// Instagram link flow: resolve the post/reel, send the media (video/photo or
// media group), then run recognition on the audio and (if found) edit the
// reply markup to add a "🎵 Artist – Title" button that delivers the MP3.

import { t } from "../i18n/index.js";
import { esc, extractInstagramUrl } from "../utils/text.js";
import { kb, btn } from "../ui/keyboards.js";
import { storePending, deliverTrack } from "./search.js";
import { resolveToDownloadable, recognizeBytes } from "./recognize.js";

const RECOG_MAX_BYTES = 30 * 1024 * 1024;

export async function handleInstaLink(ctx, msg, url) {
  const chatId = msg.chat.id;
  const lang = await ctx.langFor(msg.from?.id, msg.chat.id);
  const isGroup = ctx.isGroupChat(msg.chat.type);

  await ctx.tg.sendChatAction(chatId, "typing");
  const status = isGroup ? await ctx.tg.sendMessage(chatId, t(lang, "downloading"), { reply_to_message_id: msg.message_id }).catch(() => null) : null;

  let resolved = null;
  try {
    resolved = await ctx.insta.resolve(url);
  } catch (e) {
    await ctx.store.logError({ where: "insta.resolve", msg: e.message });
  }

  if (status) ctx.tg.deleteMessage(chatId, status.message_id).catch(() => {});
  if (!resolved || !resolved.items?.length) {
    return ctx.tg.sendMessage(chatId, t(lang, "not_found"), { reply_to_message_id: msg.message_id });
  }
  ctx.exec.waitUntil(ctx.store.bump("insta"));

  const caption = buildInstaCaption(ctx, resolved, lang);
  const support = await ctx.cfg("support_url", ctx.env.DEFAULT_SUPPORT_URL);
  const baseMarkup = kb([[{ text: "📢 " + (ctx.env.OWNER_USERNAME || "channel"), url: `https://t.me/${(ctx.env.OWNER_USERNAME || "AliMsvD").replace(/^@/, "")}` }]]);

  const items = resolved.items;
  // Prefer a video item (not its preview image) as the primary delivery.
  const videoItem = items.find((i) => i.type === "video" && i.has_audio);
  const primary = videoItem || items.find((i) => i.type === "video") || items[0];
  // The service often reports has_audio:null — still try recognition on any video.
  const recogItem = videoItem || items.find((i) => i.type === "video");

  let sent = null;
  if (items.length > 1) {
    const group = items.slice(0, 10).map((it, i) => ({
      type: it.type === "video" ? "video" : "photo",
      media: it.url || it.proxyUrl,
      caption: it === primary ? caption : undefined,
      parse_mode: "HTML",
    }));
    sent = await ctx.tg.sendMediaGroup(chatId, group).catch(() => null);
    if (!sent) sent = await sendSingle(ctx, chatId, primary, caption, baseMarkup, msg);
  } else {
    sent = await sendSingle(ctx, chatId, primary, caption, baseMarkup, msg);
  }

  // Background: try to recognize the audio of the first video item.
  if (recogItem && sent) {
    ctx.exec.waitUntil(recognizeAndPatch(ctx, msg, sent, recogItem, lang));
  }
}

async function sendSingle(ctx, chatId, item, caption, markup, msg) {
  const mediaUrl = item.url || item.proxyUrl;
  if (item.type === "video") {
    return ctx.tg.sendVideo(chatId, { video: mediaUrl, caption, reply_markup: markup, supports_streaming: true }).catch(() => null);
  }
  return ctx.tg.sendPhoto(chatId, { photo: mediaUrl, caption, reply_markup: markup }).catch(() => null);
}

function buildInstaCaption(ctx, resolved, lang) {
  const author = resolved.author?.username ? `@${resolved.author.username}` : "";
  const cap = (resolved.caption || "").slice(0, 300);
  return `${author ? "👤 " + esc(author) + "\n" : ""}${esc(cap)}\n\n${t(lang, "bot_tag", { bot: ctx.env.BOT_USERNAME })}`.trim();
}

/**
 * Background: pull the reel video bytes, decode+recognize via the bundled
 * pipeline, and AUTO-DELIVER the matching SoundCloud track. If recognition
 * works but delivery fails, patch the video's markup with a music button.
 */
async function recognizeAndPatch(ctx, msg, sent, videoItem, lang) {
  const chatId = msg.chat.id;
  const messageId = Array.isArray(sent) ? sent[0]?.message_id : sent.message_id;
  if (!messageId) return;

  const mediaUrl = videoItem.url || videoItem.proxyUrl;
  if (!mediaUrl) return;

  let bytes = null;
  try {
    const r = await fetch(mediaUrl);
    if (r.ok) {
      const len = +(r.headers.get("content-length") || 0);
      if (len <= RECOG_MAX_BYTES) bytes = new Uint8Array(await r.arrayBuffer());
    }
  } catch (e) { }
  if (!bytes) return;

  const cacheKey = `recog:ig:${mediaUrl.slice(0, 256)}`;
  const tr = await recognizeBytes(ctx, bytes, cacheKey).catch(() => null);
  if (!tr || !tr.title) return;

  const full = await resolveToDownloadable(ctx, tr).catch(() => null);
  if (full && full.streamUrl && full.artist) {
    const delivered = await deliverTrack(ctx, msg, full, lang).catch(() => null);
    if (delivered) return;
  }

  // Fallback: patch the video's markup with a "add this track" button.
  const keyId = await storePending(ctx, full || tr);
  const existing = kb([[{ text: "📢 " + (ctx.env.OWNER_USERNAME || "channel"), url: `https://t.me/${(ctx.env.OWNER_USERNAME || "AliMsvD").replace(/^@/, "")}` }]]);
  existing.inline_keyboard.unshift([btn(t(lang, "add_track_btn", { artist: tr.artist || "", title: (tr.title || "").slice(0, 30) }), `act:rfind:${keyId}`)]);
  await ctx.tg.editMessageReplyMarkup(chatId, messageId, existing).catch(() => {});
}
