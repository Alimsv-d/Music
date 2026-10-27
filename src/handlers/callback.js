// Central callback_query router. callback_data is namespaced:
//   m:<action>          main-menu / misc
//   lang:<code>         set language
//   act:*               user actions (pagination, pick, lyrics, fav, artist)
//   pn:*                admin/owner panel
// Every callback is answered; every role-gated action re-verifies server-side.

import { t } from "../i18n/index.js";
import { esc, fmtDuration, shortId } from "../utils/text.js";
import { mainMenu, langMenu, trackList, kb, btn, urlBtn, trackActions, recognizedActions } from "../ui/keyboards.js";
import { deliverTrack, artistTracks, sendLyrics, storePending } from "./search.js";
import { resolveToDownloadable } from "./recognize.js";
import { handlePanelCallback } from "./admin.js";

export async function handleCallback(ctx, cq) {
  const data = String(cq.data || "");
  const msg = cq.message || {};
  const chatId = msg.chat?.id ?? cq.from.id;
  const msgId = msg.message_id;
  const userId = cq.from.id;
  const lang = await ctx.langFor(userId, chatId);

  // Always answer to clear the spinner.
  const answer = (text, alert) => ctx.tg.answerCallbackQuery(cq.id, { text, show_alert: !!alert });

  try {
    // ── group settings ───────────────────────────────────────────────────
    if (data.startsWith("gset:")) {
      const { handleGroupSettingsCallback } = await import("./commands.js");
      return handleGroupSettingsCallback(ctx, cq, data);
    }

    // ── panel namespace ──────────────────────────────────────────────────
    if (data.startsWith("pn:")) {
      return await handlePanelCallback(ctx, cq, { chatId, msgId, userId, lang, answer });
    }

    // ── main menu ────────────────────────────────────────────────────────
    if (data === "m:home") {
      await answer();
      return editOrSend(ctx, chatId, msgId, await welcomeText(ctx, cq.from), mainMenu(lang, ctx.env.BOT_USERNAME));
    }
    if (data === "m:search") {
      await answer();
      await ctx.store.put(`state:${userId}`, { wait: "search" }, 600);
      return editOrSend(ctx, chatId, msgId, t(lang, "search_prompt"), kb([[btn(t(lang, "back"), "m:home")]]));
    }
    if (data === "m:recog") {
      await answer();
      await ctx.store.put(`state:${userId}`, { wait: "recog" }, 600);
      return editOrSend(ctx, chatId, msgId, t(lang, "recognize_prompt"), kb([[btn(t(lang, "back"), "m:home")]]));
    }
    if (data === "m:insta") {
      await answer();
      await ctx.store.put(`state:${userId}`, { wait: "insta" }, 600);
      return editOrSend(ctx, chatId, msgId, t(lang, "insta_prompt"), kb([[btn(t(lang, "back"), "m:home")]]));
    }
    if (data === "m:help") {
      await answer();
      return editOrSend(ctx, chatId, msgId, t(lang, "help_text", { bot: ctx.env.BOT_USERNAME }), kb([[B(t(lang, "menu_support"), "m:support"), btn(t(lang, "back"), "m:home")]]));
    }
    if (data === "m:creator" || data === "m:about") {
      await answer();
      return editOrSend(ctx, chatId, msgId,
        t(lang, "about_text", { name: ctx.env.BOT_NAME, dev: ctx.env.OWNER_USERNAME, version: ctx.env.VERSION || "1.0.0" }),
        kb([[btn(t(lang, "back"), "m:home")]]));
    }
    if (data === "m:support") {
      await answer();
      return editOrSend(ctx, chatId, msgId, t(lang, "support_text", { dev: ctx.env.OWNER_USERNAME }), kb([[btn(t(lang, "back"), "m:home")]]));
    }
    if (data === "m:invite") {
      await answer();
      const link = `https://t.me/${ctx.env.BOT_USERNAME || "SearcherMusiic_Bot"}?start=ref_${userId}`;
      return editOrSend(ctx, chatId, msgId, t(lang, "invite_title", { bot: ctx.env.BOT_USERNAME || "SearcherMusiic_Bot", id: userId }) + `\n\n<a href="${link}">${t(lang, "invite_share")}</a>`, kb([[btn(t(lang, "back"), "m:home")]]));
    }
    if (data === "m:lang") {
      await answer();
      return editOrSend(ctx, chatId, msgId, t(lang, "lang_pick"), langMenu(lang));
    }
    if (data === "m:fav:1" || data === "m:fav") {
      await answer();
      return showFavs(ctx, chatId, msgId, userId, lang, 1);
    }

    if (data.startsWith("lang:")) {
      const code = data.split(":")[1];
      await ctx.store.upsertUser(userId, { lang: code });
      await answer(t(code, "lang_set"), true);
      return editOrSend(ctx, chatId, msgId, await welcomeText(ctx, cq.from), mainMenu(code, ctx.env.BOT_USERNAME));
    }

    // ── pagination ───────────────────────────────────────────────────────
    if (data.startsWith("act:pg:")) {
      const [, , , id, pStr] = data.split(":");
      const page = parseInt(pStr, 10) || 0;
      const rec = await ctx.store.getSearch(id);
      if (!rec) return answer(t(lang, "expired"), true);
      const pageSize = await pageSizeOf(ctx);
      const { markup } = trackList(rec.lang || lang, rec.items, id, page, pageSize, { playlists: rec.kind === "artist" });
      await answer();
      return ctx.tg.editMessageReplyMarkup(chatId, msgId, markup).catch(async () => {
        await ctx.tg.editMessageText(chatId, msgId, t(rec.lang || lang, "results_for", { q: esc(rec.q) }), { reply_markup: markup });
      });
    }
    if (data === "act:noop") return answer();

    // ── pick a track from a stored list ──────────────────────────────────
    if (data.startsWith("act:t:")) {
      const [, , , id, idxStr] = data.split(":");
      const idx = parseInt(idxStr, 10) || 0;
      const rec = await ctx.store.getSearch(id);
      if (!rec || !rec.items[idx]) return answer(t(lang, "expired"), true);
      await answer();
      return deliverTrack(ctx, { chat: { id: chatId }, from: cq.from, message_id: msgId }, rec.items[idx], rec.lang || lang);
    }

    // ── artist popular tracks ────────────────────────────────────────────
    if (data.startsWith("act:art:")) {
      const artist = decodeURIComponent(data.slice("act:art:".length));
      await answer();
      return artistTracks(ctx, { chat: { id: chatId }, from: cq.from, message_id: msgId }, artist);
    }

    // ── artist playlists ─────────────────────────────────────────────────
    if (data.startsWith("act:pl:")) {
      const [, , , id] = data.split(":");
      const rec = await ctx.store.getSearch(id);
      await answer();
      // SoundCloud worker has no dedicated playlist endpoint; reuse artist search
      // filtered is not available — show a friendly note + the artist's tracks.
      return editOrSend(ctx, chatId, msgId, t(rec?.lang || lang, "playlists_of", { artist: esc(rec?.q || "") }) + "\n\n" + t(rec?.lang || lang, "no_lyrics").replace("📝", "ℹ️"), kb([[btn(t(lang, "back"), `act:pg:${id}:0`)]]));
    }

    // ── download from a stored pending stub (recognition / insta buttons) ──
    if (data.startsWith("act:rdl:") || data.startsWith("act:fav:") || data.startsWith("act:ufav:") || data.startsWith("act:lyr:")) {
      const parts = data.split(":");
      const sub = parts[1];
      const keyId = parts.slice(2).join(":");
      const tr = await ctx.store.get(`pending:${keyId}`);
      if (!tr) return answer(t(lang, "expired"), true);

      if (sub === "rdl") {
        await answer();
        return deliverTrack(ctx, { chat: { id: chatId }, from: cq.from, message_id: msgId }, tr, lang);
      }
      if (sub === "lyr") {
        await answer();
        const ok = await sendLyrics(ctx, chatId, tr, lang);
        if (!ok) return ctx.tg.sendMessage(chatId, t(lang, "no_lyrics"));
        return;
      }
      if (sub === "fav") {
        await ctx.store.addFav(userId, { ...tr, key: tr.key || `${tr.source}:${tr.id}`, keyId });
        await answer(t(lang, "fav_added"), true);
        return refreshTrackButtons(ctx, chatId, msgId, tr, keyId, userId, lang, true);
      }
      if (sub === "ufav") {
        await ctx.store.removeFav(userId, tr.key || `${tr.source}:${tr.id}`);
        await answer(t(lang, "fav_removed"), true);
        return refreshTrackButtons(ctx, chatId, msgId, tr, keyId, userId, lang, false);
      }
    }

    // ── recognized-track actions (resolve to a downloadable first) ────────
    if (data.startsWith("act:rfind:")) {
      const keyId = data.slice("act:rfind:".length);
      const tr = await ctx.store.get(`pending:${keyId}`);
      if (!tr) return answer(t(lang, "expired"), true);
      await answer();
      const full = await resolveToDownloadable(ctx, tr);
      return deliverTrack(ctx, { chat: { id: chatId }, from: cq.from, message_id: msgId }, full, lang);
    }
    if (data.startsWith("act:rlyr:")) {
      const keyId = data.slice("act:rlyr:".length);
      const tr = await ctx.store.get(`pending:${keyId}`);
      if (!tr) return answer(t(lang, "expired"), true);
      await answer();
      const ok = await sendLyrics(ctx, chatId, tr, lang);
      if (!ok) return ctx.tg.sendMessage(chatId, t(lang, "no_lyrics"));
      return;
    }

    // ── forced-join recheck ──────────────────────────────────────────────
    if (data === "act:joined") {
      const { checkJoin } = await import("./gate.js");
      const ok = await checkJoin(ctx, userId);
      if (ok) {
        await answer(t(lang, "join_ok"), true);
        return ctx.tg.editMessageText(chatId, msgId, await welcomeText(ctx, cq.from), { reply_markup: mainMenu(lang, ctx.env.BOT_USERNAME) }).catch(() => {});
      }
      return answer(t(lang, "join_not"), true);
    }

    // ── favorites pagination ─────────────────────────────────────────────
    if (data.startsWith("act:favpg:")) {
      const page = parseInt(data.split(":")[2], 10) || 1;
      await answer();
      return showFavs(ctx, chatId, msgId, userId, lang, page);
    }

    return answer();
  } catch (e) {
    await ctx.store.logError({ where: "callback", msg: e.message, data });
    return answer(t(lang, "error_generic"), true).catch(() => {});
  }
}

async function refreshTrackButtons(ctx, chatId, msgId, tr, keyId, userId, lang, isFav) {
  const markup = trackActions(lang, { ...tr, keyId }, { isFav });
  return ctx.tg.editMessageReplyMarkup(chatId, msgId, markup).catch(() => {});
}

async function welcomeText(ctx, from) {
  const lang = await ctx.langFor(from.id, from.id);
  const name = esc(from.first_name || "");
  const welcome = await ctx.cfg("welcome");
  if (welcome) return welcome.replace(/\{name\}/g, name).replace(/\{bot\}/g, ctx.env.BOT_USERNAME);
  return t(lang, "welcome", { name, bot: ctx.env.BOT_USERNAME });
}
export { welcomeText };

async function editOrSend(ctx, chatId, msgId, text, markup) {
  if (msgId) {
    try {
      return await ctx.tg.editMessageText(chatId, msgId, text, { reply_markup: markup });
    } catch (e) {
      if (!e.notFound) { /* fall through to send */ }
    }
  }
  return ctx.tg.sendMessage(chatId, text, { reply_markup: markup });
}
export { editOrSend };

async function showFavs(ctx, chatId, msgId, userId, lang, page = 1) {
  const favs = await ctx.store.getFavs(userId);
  if (!favs.length) return editOrSend(ctx, chatId, msgId, t(lang, "no_favs"), kb([[btn(t(lang, "back"), "m:home")]]));
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(favs.length / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  const slice = favs.slice((p - 1) * pageSize, p * pageSize);
  const rows = slice.map((f) => [btn(`🎵 ${f.artist ? f.artist + " – " : ""}${f.title}`.slice(0, 60), `act:rdl:${f.keyId || ""}`)]);
  const nav = [];
  if (p > 1) nav.push(btn(t(lang, "prev"), `act:favpg:${p - 1}`));
  nav.push(btn(`${p}/${pages}`, "act:noop"));
  if (p < pages) nav.push(btn(t(lang, "next"), `act:favpg:${p + 1}`));
  rows.push(nav, [btn(t(lang, "back"), "m:home")]);
  return editOrSend(ctx, chatId, msgId, "⭐ " + t(lang, "btn_fav"), kb(rows));
}
export { showFavs };

async function pageSizeOf(ctx) {
  return Math.max(5, Math.min(20, parseInt(await ctx.cfg("page_size", ctx.env.PAGE_SIZE || 10), 10) || 10));
}
export { pageSizeOf };
