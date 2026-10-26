// Smart text search + track delivery.

import { t } from "../i18n/index.js";
import { esc, normalize, matchScore, splitArtistTitle, shortId, fmtDuration } from "../utils/text.js";
import { trackList, trackActions, mainMenu, kb, btn, urlBtn } from "../ui/keyboards.js";
import { trackKey } from "../services/track.js";

const HIGH_CONF = 0.82;   // deliver directly if a single result scores >= this
const AMBIG = 0.55;       // below this -> "not found"

/**
 * Entry point for a text query (private or group /music).
 * Decides: direct-deliver one track, or show a paginated list.
 */
export async function handleSearch(ctx, msg, query) {
  const lang = await ctx.langFor(msg.from?.id, msg.chat.id);
  const chatId = msg.chat.id;
  const isGroup = ctx.isGroupChat(msg.chat.type);
  query = String(query || "").trim();
  if (!query) return;

  await ctx.tg.sendChatAction(chatId, "typing");
  const status = isGroup ? await ctx.tg.sendMessage(chatId, t(lang, "searching")).catch(() => null) : null;

  let results = [];
  try {
    results = await ctx.sc.search(query, 1, 24);
  } catch (e) {
    await ctx.store.logError({ where: "sc.search", msg: e.message });
  }
  if (status) ctx.tg.deleteMessage(chatId, status.message_id).catch(() => {});

  if (!results.length) {
    return ctx.tg.sendMessage(chatId, t(lang, "not_found"), { reply_to_message_id: msg.message_id });
  }

  // Record history (private).
  if (!isGroup) ctx.exec.waitUntil(ctx.store.pushHistory(msg.from.id, query));
  ctx.exec.waitUntil(ctx.store.bump("searches"));

  // Try to detect "Artist - Title" high-confidence single match.
  const parts = splitArtistTitle(query);
  let best = null, bestScore = 0;
  for (const r of results.slice(0, 8)) {
    const s = matchScore(query, r);
    if (s > bestScore) { bestScore = s; best = r; }
  }
  if (parts) {
    const q2 = `${parts.artist} ${parts.title}`;
    for (const r of results.slice(0, 8)) {
      const s = matchScore(q2, r);
      if (s > bestScore) { bestScore = s; best = r; }
    }
  }

  // Single clear winner -> deliver directly.
  if (best && bestScore >= HIGH_CONF) {
    return deliverTrack(ctx, msg, best, lang);
  }
  if (bestScore < AMBIG && results.length < 3) {
    // weak match overall — still show what we found rather than nothing.
  }

  // Ambiguous -> paginated list (10/page) stored under a short id.
  const id = shortId();
  await ctx.store.putSearch(id, { kind: "search", q: query, items: results.map(compact), lang }, +ctx.env.RESULT_TTL || 3600);
  const pageSize = await pageSizeOf(ctx);
  const { markup } = trackList(lang, results, id, 0, pageSize, {});
  await ctx.tg.sendMessage(chatId, t(lang, "results_for", { q: esc(query) }), {
    reply_markup: markup,
    reply_to_message_id: isGroup ? msg.message_id : undefined,
  });
}

/** Artist's popular tracks (called when query matches an artist). */
export async function artistTracks(ctx, msg, artistName) {
  const lang = await ctx.langFor(msg.from?.id, msg.chat.id);
  const chatId = msg.chat.id;
  let results = [];
  try { results = await ctx.sc.search(artistName, 1, 24); } catch {}
  if (!results.length) return ctx.tg.sendMessage(chatId, t(lang, "not_found"));
  const id = shortId();
  await ctx.store.putSearch(id, { kind: "artist", q: artistName, items: results.map(compact), lang }, +ctx.env.RESULT_TTL || 3600);
  const pageSize = await pageSizeOf(ctx);
  const { markup } = trackList(lang, results, id, 0, pageSize, { playlists: true });
  await ctx.tg.sendMessage(chatId, t(lang, "popular_of", { artist: esc(artistName) }), { reply_markup: markup });
}

async function pageSizeOf(ctx) {
  return Math.max(5, Math.min(20, parseInt(await ctx.cfg("page_size", ctx.env.PAGE_SIZE || 10), 10) || 10));
}

/** Slim a Track for KV storage in a search handle. */
function compact(tr) {
  return {
    id: tr.id, source: tr.source, title: tr.title, artist: tr.artist,
    album: tr.album, year: tr.year, duration_ms: tr.duration_ms,
    artwork: tr.artwork, downloadUrl: tr.downloadUrl, streamUrl: tr.streamUrl, pageUrl: tr.pageUrl,
  };
}

/**
 * Deliver a track: file_id when cached, else URL-send only — the Worker never
 * downloads/buffers the audio bytes (Telegram fetches them from the service
 * URL directly). caption + action buttons, then auto-lyrics.
 * `trackStub` may be a compact object from KV or a live Track.
 */
export async function deliverTrack(ctx, msg, trackStub, lang, editCb) {
  const chatId = msg.chat.id;
  const key = trackKey(trackStub.source || "sc", trackStub.id);
  await ctx.tg.sendChatAction(chatId, "upload_audio");

  const tr = await enrich(ctx, trackStub);
  const title = tr.title || "track";
  const artist = tr.artist || "";
  const caption = buildCaption(ctx, tr, lang);
  const keyId = await storePending(ctx, tr);
  const markup = trackActions(lang, { ...tr, keyId }, { isFav: await isFav(ctx, msg.from?.id, tr) });

  // 1) try cached file_id
  let fileId = await ctx.store.getTrackFileId(key);
  let sent = null;

  if (fileId) {
    try {
      sent = await ctx.tg.sendAudio(chatId, {
        audio: fileId, caption, title, performer: artist,
        duration: Math.round((tr.duration_ms || 0) / 1000), reply_markup: markup,
      });
      ctx.exec.waitUntil(ctx.store.bump("cache_hits"));
    } catch (e) {
      // stale file_id -> fall through to upload
      fileId = null;
    }
  }

  // 2) DIRECT URL-SEND only — zero bytes through the Worker. Candidates:
  //   a) /f/<sid>/<slug>.mp3 — validated progressive file -> real `audio`.
  //   b) tr.downloadUrl / tr.streamUrl — the worker's own media endpoints.
  // If Telegram returns a non-audio (document) or errors, try the next URL;
  // if all fail, reply with a direct-link button. Never buffer bytes here.
  if (!sent) {
    const sid0 = String(tr.sid || tr.id || "").replace(/^sc_/, "");
    const base = (ctx.env.SOUNDCLOUD_API_URL || `${ctx.publicUrl(ctx.request)}/svc/sc`).replace(/\/$/, "");
    const slug = encodeURIComponent(((artist ? artist + " - " : "") + title).replace(/[\\/:*?"<>|]/g, " ").slice(0, 80) || "track");
    const urls = [
      sid0 && base ? `${base}/f/${sid0}/${slug}.mp3` : null,
      tr.downloadUrl, tr.streamUrl,
    ].filter(Boolean);
    for (const url of urls) {
      try {
        sent = await ctx.tg.sendAudio(chatId, {
          audio: url, caption, title, performer: artist,
          duration: Math.round((tr.duration_ms || 0) / 1000), reply_markup: markup,
        });
        const fid = sent?.audio?.file_id;
        if (fid) {
          ctx.exec.waitUntil(ctx.store.putTrack(key, { file_id: fid, title, artist, duration_ms: tr.duration_ms }));
          break;
        }
        // Telegram delivered it as a document/other — delete & try next URL.
        if (sent && sent.message_id) { try { await ctx.tg.deleteMessage(chatId, sent.message_id); } catch (_) {} }
        sent = null;
      } catch (e) {
        sent = null; // try next URL
      }
    }
    if (!sent) {
      // All URL-sends failed -> give the user a direct link (still no proxying).
      const fb = kb([[urlBtn(t(lang, "dl_direct"), tr.downloadUrl || tr.pageUrl)]]);
      sent = await ctx.tg.sendMessage(chatId, caption + "\n\n" + t(lang, "file_too_big_tg"), { reply_markup: fb });
    }
  }

  ctx.exec.waitUntil(ctx.store.bump("downloads"));

  // 3) auto lyrics
  const autoLyrics = await ctx.cfg("auto_lyrics", true);
  if (autoLyrics !== false && sent) {
    ctx.exec.waitUntil(sendLyrics(ctx, chatId, tr, lang));
  }
  return sent;
}

/** Fetch a fuller track record if we only have a compact stub. */
async function enrich(ctx, stub) {
  if (stub.album !== undefined && stub.artwork !== undefined && stub.title) return stub;
  try {
    const full = await ctx.sc.track(stub.id);
    if (full) return { ...stub, ...full };
  } catch {}
  return stub;
}

function buildCaption(ctx, tr, lang) {
  const metaParts = [];
  if (tr.year && tr.album) metaParts.push(t(lang, "meta_year_album", { year: tr.year, album: esc(tr.album) }));
  else if (tr.year) metaParts.push(t(lang, "meta_year", { year: tr.year }));
  else if (tr.album) metaParts.push(t(lang, "meta_album", { album: esc(tr.album) }));
  const bot = ctx.env.BOT_USERNAME || "";
  return t(lang, "track_caption", {
    title: esc(tr.title), artist: esc(tr.artist), meta: metaParts.join("\n"),
  }) + `\n${t(lang, "bot_tag", { bot })}`;
}

/** Store a track stub so its buttons can rebuild it later (keyId in callback). */
async function storePending(ctx, tr) {
  const id = shortId();
  await ctx.store.put(`pending:${id}`, compact(tr), +ctx.env.RESULT_TTL || 3600);
  return id;
}
export { storePending, enrich };

async function isFav(ctx, userId, tr) {
  if (!userId) return false;
  const favs = await ctx.store.getFavs(userId);
  return favs.some((f) => f.key === tr.key || (f.source === tr.source && String(f.id) === String(tr.id)));
}

/** Send lyrics for a track (Shazam -> LRCLIB fallback). Split long text. */
export async function sendLyrics(ctx, chatId, tr, lang) {
  let text = tr.lyrics || null;
  if (!text && tr.title) {
    try {
      const l = await ctx.lyr.get(tr.artist, tr.title, tr.album, (tr.duration_ms || 0) / 1000);
      text = l;
    } catch {}
  }
  if (!text && tr.title) {
    try {
      const res = await ctx.lyr.search(tr.title, tr.artist);
      text = res?.[0]?.lyrics || null;
    } catch {}
  }
  if (!text) return null;
  const { splitText } = await import("../utils/text.js");
  const header = `<b>${t(lang, "lyrics_title", { title: esc(tr.title) })}</b>\n`;
  const chunks = splitText(text, 3900);
  for (let i = 0; i < chunks.length; i++) {
    const body = i === 0 ? header + `<blockquote expandable>${esc(chunks[i])}</blockquote>` : `<blockquote expandable>${esc(chunks[i])}</blockquote>`;
    await ctx.tg.sendMessage(chatId, body).catch(() => {});
  }
  return true;
}
