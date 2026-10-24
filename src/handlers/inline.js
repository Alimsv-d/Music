// Inline mode: `@bot <query>` in any chat. Returns audio results that stream
// via our /dl/<signedId> proxy route. Uses cached file_id when available.
// Answers fast: aggressive caching + short timeouts.

import { t } from "../i18n/index.js";
import { signLink } from "../utils/crypto.js";
import { fmtDuration } from "../utils/text.js";

const PAGE = 20;

export async function handleInlineQuery(ctx, iq) {
  const userId = iq.from.id;
  const q = String(iq.query || "").trim();
  const offset = parseInt(iq.offset || "0", 10) || 0;
  const lang = await ctx.langFor(userId, userId);

  // Inline mode can be disabled in settings.
  const inlineOn = await ctx.cfg("inline", true);
  if (inlineOn === false) {
    return ctx.tg.answerInlineQuery(iq.id, [], { cache_time: 60 });
  }

  // Empty query -> recent searches + a hint article.
  if (!q) {
    const hist = await ctx.store.getHistory(userId);
    const results = hist.slice(0, 10).map((h, i) => ({
      type: "article",
      id: `h${i}`,
      title: h,
      description: t(lang, "inline_hint", { bot: ctx.env.BOT_USERNAME }),
      input_message_content: { message_text: `/music ${h}` },
    }));
    if (!results.length) {
      results.push({
        type: "article", id: "hint",
        title: t(lang, "btn_search"),
        description: t(lang, "inline_hint", { bot: ctx.env.BOT_USERNAME }),
        input_message_content: { message_text: t(lang, "inline_hint", { bot: ctx.env.BOT_USERNAME }) },
      });
    }
    return ctx.tg.answerInlineQuery(iq.id, results, { cache_time: 30, is_personal: true });
  }

  // Search (page derived from offset).
  const page = Math.floor(offset / PAGE) + 1;
  let items = [];
  try {
    items = await ctx.sc.search(q, page, PAGE);
  } catch (e) {
    await ctx.store.logError({ where: "inline.search", msg: e.message });
  }
  ctx.exec.waitUntil(ctx.store.bump("searches"));

  const base = ctx.publicUrl();
  const results = [];
  for (const tr of items.slice(0, PAGE)) {
    const fileId = await ctx.store.getTrackFileId(tr.key);
    if (fileId) {
      results.push({
        type: "audio",
        id: `c${tr.id}`,
        audio_file_id: fileId,
        caption: `${tr.artist ? tr.artist + " – " : ""}${tr.title}\n${t(lang, "bot_tag", { bot: ctx.env.BOT_USERNAME })}`,
      });
      continue;
    }
    if (!tr.downloadUrl) continue;
    const signed = await signLink(ctx.env.LINK_SECRET, `sc:${tr.id}`, 3600);
    results.push({
      type: "audio",
      id: `s${tr.id}`,
      audio_url: `${base}/dl/${signed}.mp3`,
      title: `${tr.artist ? tr.artist + " – " : ""}${tr.title}`.slice(0, 64),
      performer: tr.artist || "",
      audio_duration: Math.round((tr.duration_ms || 0) / 1000),
      caption: `${tr.title}\n${t(lang, "bot_tag", { bot: ctx.env.BOT_USERNAME })}`,
    });
  }

  const next_offset = items.length >= PAGE ? String(offset + PAGE) : "";
  await ctx.tg.answerInlineQuery(iq.id, results.slice(0, 50), {
    cache_time: 60,
    is_personal: false,
    next_offset,
  });
}

/** Track chosen-inline-result stats + cache the file_id once TG assigns one. */
export async function handleChosenInline(ctx, cir) {
  ctx.exec.waitUntil(ctx.store.bump("inline_uses"));
  // If Telegram already resolved to a file_id (cached audio), nothing to do.
}
