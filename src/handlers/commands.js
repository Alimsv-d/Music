// Group settings callbacks (gset:*) + the command lists used by /setup.

import { t, LANGS, langName } from "../i18n/index.js";
import { kb, btn } from "../ui/keyboards.js";

export const COMMANDS = {
  private: [
    { command: "start", description: "شروع / Start" },
    { command: "music", description: "جستجوی موزیک / Search" },
    { command: "find", description: "تشخیص آهنگ / Recognize" },
    { command: "fav", description: "علاقه‌مندی‌ها / Favorites" },
    { command: "lang", description: "زبان / Language" },
    { command: "help", description: "راهنما / Help" },
    { command: "about", description: "درباره / About" },
  ],
  group: [
    { command: "music", description: "جستجوی موزیک" },
    { command: "find", description: "تشخیص آهنگ" },
    { command: "settings", description: "تنظیمات گروه" },
  ],
};

/** Handle gset:* callbacks (group admin toggles). Returns true if handled. */
export async function handleGroupSettingsCallback(ctx, cq, data) {
  const chatId = cq.message?.chat?.id;
  const userId = cq.from.id;
  const lang = await ctx.langFor(userId, chatId);
  if (!chatId) return false;

  // verify admin
  let isAdmin = false;
  try {
    const m = await ctx.tg.getChatMember(chatId, userId);
    isAdmin = ["administrator", "creator"].includes(m.status);
  } catch {}
  if (!isAdmin) { await ctx.tg.answerCallbackQuery(cq.id, { text: t(lang, "only_admin"), show_alert: true }); return true; }

  const chat = await ctx.store.getChat(chatId) || { id: String(chatId) };
  const rebuild = async () => kb([
    [btn(`${t(lang, "set_enabled")}: ${chat.enabled !== false ? t(lang, "on") : t(lang, "off")}`, "gset:en")],
    [btn(`${t(lang, "set_lyrics")}: ${chat.auto_lyrics !== false ? t(lang, "on") : t(lang, "off")}`, "gset:lyr")],
    [btn(`${t(lang, "set_lang")}: ${langName(chat.lang || "fa")}`, "gset:lang")],
  ]);

  if (data === "gset:en") chat.enabled = chat.enabled === false;
  else if (data === "gset:lyr") chat.auto_lyrics = chat.auto_lyrics === false;
  else if (data === "gset:lang") { chat.lang = (chat.lang || "fa") === "fa" ? "en" : "fa"; }
  await ctx.store.upsertChat(chatId, chat);
  await ctx.tg.answerCallbackQuery(cq.id);
  await ctx.tg.editMessageReplyMarkup(chatId, cq.message.message_id, await rebuild()).catch(() => {});
  return true;
}
