// Recognition: voice / audio / video / document -> Shazam, and lyrics-snippet
// text -> lyric search. Shows recognized track + download/lyrics buttons.

import { t } from "../i18n/index.js";
import { esc, yearOf } from "../utils/text.js";
import { sniffAudio } from "../utils/audio.js";
import { recognizedActions, kb, btn, urlBtn } from "../ui/keyboards.js";
import { storePending } from "./search.js";

const MAX_TG_FILE = 20 * 1024 * 1024; // bot API getFile limit

/** Route a media message to recognition. */
export async function handleMedia(ctx, msg) {
  const chatId = msg.chat.id;
  const lang = await ctx.langFor(msg.from?.id, msg.chat.id);
  const media = pickMedia(msg);
  if (!media) return;

  await ctx.tg.sendChatAction(chatId, "typing");
  const status = await ctx.tg.sendMessage(chatId, t(lang, "recognizing"), {
    reply_to_message_id: msg.message_id,
  }).catch(() => null);

  const tr = await recognizeMedia(ctx, media, chatId, lang);

  if (status) ctx.tg.deleteMessage(chatId, status.message_id).catch(() => {});

  if (!tr) {
    return ctx.tg.sendMessage(chatId, t(lang, "send_clearer"), { reply_to_message_id: msg.message_id });
  }
  ctx.exec.waitUntil(ctx.store.bump("recognitions"));
  await showRecognized(ctx, msg, tr, lang);
}

function pickMedia(msg) {
  const m = msg.voice || msg.audio || msg.video || msg.video_note ||
    (msg.document && /audio|ogg|mp3|wav|m4a|video/.test(msg.document.mime_type || "") ? msg.document : null);
  if (!m) return null;
  return { file_id: m.file_id, file_size: m.file_size || 0, mime: m.mime_type || "", duration: m.duration || 0 };
}
export { pickMedia };

/** Download the file and run recognition. Returns a Track or null. */
export async function recognizeMedia(ctx, media, chatId, lang) {
  if (media.file_size && media.file_size > MAX_TG_FILE) {
    await ctx.tg.sendMessage(chatId, t(lang, "file_too_big_tg"));
    return null;
  }
  let filePath;
  try {
    const f = await ctx.tg.getFile(media.file_id);
    filePath = f.file_path;
  } catch (e) {
    await ctx.store.logError({ where: "getFile", msg: e.message });
    return null;
  }
  if (!filePath) return null;

  const url = ctx.tg.fileUrl(filePath);
  let bytes = null;
  try {
    const r = await fetch(url);
    if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
  } catch {}

  const kind = bytes ? sniffAudio(bytes) : null;

  // WAV -> direct upload. OGG/mp3/video -> needs backend; try recognize/url.
  let tr = null;
  if (bytes && kind === "wav") {
    tr = await ctx.shz.recognize(bytes, "wav", "audio.wav").catch(() => null);
  }
  // Fallback: if an ffmpeg backend is wired up, pass the file URL.
  if (!tr) {
    try { tr = await ctx.shz.recognizeUrl(url); } catch {}
  }
  // Last resort: if backend absent but the file is a recognized audio we can't
  // decode, try a text search on any title metadata we have (audio filename).
  return tr;
}

/** Render a recognized track message + buttons. Also used by insta flow. */
export async function showRecognized(ctx, msg, tr, lang, editMarkupOnly = false) {
  const meta = [];
  if (tr.year) meta.push(`📅 ${tr.year}`);
  if (tr.album) meta.push(`💿 ${esc(tr.album)}`);
  if (tr.genre) meta.push(`🎼 ${esc(tr.genre)}`);
  const body = t(lang, "recognized_body", { title: esc(tr.title), artist: esc(tr.artist), meta: meta.join("  ") });

  const keyId = await storePending(ctx, tr);

  if (editMarkupOnly) {
    // Return the "add this track" button for insta flow.
    return { body, tr, keyId };
  }

  const markup = kb([
    [btn(t(lang, "btn_dl_mp3"), `act:rfind:${keyId}`)],
    [
      btn(t(lang, "btn_lyrics"), `act:rlyr:${keyId}`),
      btn(t(lang, "btn_more_artist"), `act:art:${encodeURIComponent(tr.artist || "")}`),
    ],
  ]);

  const sent = tr.artwork
    ? await ctx.tg.sendPhoto(msg.chat.id, { photo: tr.artwork, caption: body, reply_markup: markup }).catch(() => null)
    : null;
  if (!sent) await ctx.tg.sendMessage(msg.chat.id, body, { reply_markup: markup });
}

/**
 * Resolve a recognized/metadata track (Shazam) into a downloadable SoundCloud
 * track. Searches SC for "artist title" and picks the best fuzzy match.
 */
export async function resolveToDownloadable(ctx, tr) {
  const q = `${tr.artist || ""} ${tr.title || ""}`.trim();
  if (!q) return tr;
  try {
    const results = await ctx.sc.search(q, 1, 8);
    if (!results.length) return tr;
    const { matchScore } = await import("../utils/text.js");
    let best = results[0], bestScore = matchScore(q, results[0]);
    for (const r of results.slice(1)) {
      const s = matchScore(q, r);
      if (s > bestScore) { bestScore = s; best = r; }
    }
    // merge: keep SC download/stream fields, prefer recognized artwork/meta
    return { ...best, artwork: tr.artwork || best.artwork, year: tr.year || best.year, album: tr.album || best.album, lyrics: tr.lyrics };
  } catch {
    return tr;
  }
}

/** Lyrics-snippet search: try Shazam text search + LRCLIB to find the song. */
export async function handleLyricsSnippet(ctx, msg, text) {
  const chatId = msg.chat.id;
  const lang = await ctx.langFor(msg.from?.id, msg.chat.id);
  await ctx.tg.sendChatAction(chatId, "typing");

  let track = null;
  try {
    const res = await ctx.shz.search(text, 5);
    const cand = res?.results?.[0];
    if (cand && cand.title) {
      track = { title: cand.title, artist: cand.artist || "", artwork: res.artwork || null, source: "shz", id: cand.title, key: `shz:${cand.artist}::${cand.title}` };
    }
  } catch {}
  if (!track) {
    try {
      const res = await ctx.lyr.search("", "", text);
      const c = res?.find((r) => r.lyrics);
      if (c) track = { title: c.title, artist: c.artist, album: c.album, source: "shz", id: c.title, key: `shz:${c.artist}::${c.title}`, lyrics: c.lyrics };
    } catch {}
  }
  if (!track) return ctx.tg.sendMessage(chatId, t(lang, "not_found"), { reply_to_message_id: msg.message_id });

  const full = await resolveToDownloadable(ctx, track);
  await showRecognized(ctx, msg, { ...track, ...full }, lang);
}
