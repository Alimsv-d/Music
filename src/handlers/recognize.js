// Recognition: voice / audio / video / document -> Shazam, and lyrics-snippet
// text -> lyric search. Shows recognized track + download/lyrics buttons.

import { t } from "../i18n/index.js";
import { esc } from "../utils/text.js";
import { sniffAudio } from "../utils/audio.js";
import { parseOggPages, oggChunkRanges, parseMp4Audio, bytesToB64, b64ToBytes } from "../utils/audioparse.js";
import { kb, btn, urlBtn } from "../ui/keyboards.js";
import { storePending, deliverTrack } from "./search.js";

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

  // Auto-deliver the SoundCloud match when we can resolve one; otherwise
  // fall back to the recognized-info card with action buttons.
  const full = await resolveToDownloadable(ctx, tr).catch(() => null);
  if (full && full.streamUrl && full.artist) {
    const sent = await deliverTrack(ctx, msg, full, lang).catch(() => null);
    if (sent) return sent;
  }
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

  // 1) result cache: same file re-sent -> answer without any upstream call.
  const cacheKey = `recog:tg:${media.file_id}`;
  const cached = await cacheGetJson(ctx, cacheKey);
  if (cached) {
    if (cached.found) return cached.track;
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

  if (!bytes) return null;
  const tr = await recognizeBytes(ctx, bytes, cacheKey);
  if (!tr) return null;
  return tr;
}

/**
 * Recognize arbitrary media bytes (Telegram media or Instagram CDN file).
 * Detects the container, decodes to 16 kHz mono PCM in CPU-budgeted chunks
 * (self-subrequests to /svc/dec), and asks the Shazam worker to fingerprint.
 * Cached by `cacheKey` when provided.
 */
export async function recognizeBytes(ctx, bytes, cacheKey) {
  const kind = sniffAudio(bytes);
  if (!kind) return null;

  let tr = null;
  if (kind === "wav") {
    // WAV goes straight to the Shazam worker.
    tr = await ctx.shz.recognize(bytes, "wav", "audio.wav").catch(() => null);
  } else {
    const pcm = await decodeToPcm(ctx, bytes, kind);
    if (pcm && pcm.length) {
      tr = await ctx.shz.recognizePcm(pcm).catch(() => null);
    }
  }
  if (cacheKey && ctx.exec) {
    const payload = { found: !!tr, track: tr ? compactTrack(tr) : null };
    ctx.exec.waitUntil(cachePutJson(ctx, cacheKey, payload, RECOG_TTL));
  }
  return tr;
}

const RECOG_TTL = 6 * 3600;
const MAX_DECODE_SECONDS = 15;
const OPUS_PACKETS_PER_CHUNK = 50;   // ~1 s per chunk
const AAC_SECONDS_PER_CHUNK = 0.6;
const MP3_SECONDS_PER_CHUNK = 0.6;
const AAC_WARMUP_SECONDS = 0.5;

/**
 * Decode OGG(Opus) / MP4,MOV,M4A(AAC) / MP3 to 16 kHz mono Int16, in
 * CPU-budgeted self-subrequests to /svc/dec. Returns Int16Array or null.
 */
async function decodeToPcm(ctx, bytes, kind) {
  const origin = ctx.publicUrl(ctx.request);
  const decUrl = origin ? `${origin.replace(/\/$/, "")}/svc/dec` : null;
  if (!decUrl) return null;

  try {
    if (kind === "ogg") {
      const pages = parseOggPages(bytes);
      if (!pages || pages.pages.length < 3) return null;
      const headB64 = bytesToB64(bytes.subarray(0, pages.headEnd));
      const ranges = oggChunkRanges(pages.pages, pages.headEnd, OPUS_PACKETS_PER_CHUNK);
      const parts = [];
      let total = 0;
      for (const [from, to] of ranges) {
        const r = await decCall(decUrl, { codec: "opus", head: headB64, data: bytesToB64(bytes.subarray(from, to)) });
        if (!OK(r)) continue;
        parts.push(r);
        total += r.samples;
        if (total >= MAX_DECODE_SECONDS * 16000) break;
      }
      return joinPcm(parts);
    }

    if (kind === "mp4") {
      const parsed = parseMp4Audio(bytes);
      if (!parsed || !parsed.asc || !parsed.frames.length) return null;
      const rate = parsed.sampleRate || 44100;
      const framesPerChunk = Math.max(8, Math.round(AAC_SECONDS_PER_CHUNK * (rate / 1024)));
      const warmupFrames = Math.max(4, Math.round(AAC_WARMUP_SECONDS * (rate / 1024)));
      const asc = bytesToB64(parsed.asc);
      const skipSamples = Math.round(AAC_WARMUP_SECONDS * 16000);
      const parts = [];
      let total = 0;
      const need = Math.min(parsed.frames.length, Math.ceil(MAX_DECODE_SECONDS * rate / 1024) + warmupFrames);
      for (let i = 0; i < need; i += framesPerChunk) {
        const from = Math.max(0, i - warmupFrames);
        const to = Math.min(parsed.frames.length, i + framesPerChunk);
        const frames = [];
        for (let k = from; k < to; k++) {
          const f = parsed.frames[k];
          frames.push(bytes.subarray(f.o, f.o + f.s));
        }
        const r = await decCall(decUrl, { codec: "aac", asc, skip: skipSamples, frames: frames.map((f) => bytesToB64(f)) });
        if (!OK(r)) continue;
        parts.push(r);
        total += r.samples;
        if (total >= MAX_DECODE_SECONDS * 16000) break;
      }
      return joinPcm(parts);
    }

    if (kind === "mp3") {
      // ~0.6 s per chunk at 128-320 kbps -> 12-40 KB slices.
      const chunkBytes = 16000;
      let total = 0;
      const parts = [];
      for (let off = 0; off < bytes.length; off += chunkBytes) {
        const r = await decCall(decUrl, { codec: "mp3", data: bytesToB64(bytes.subarray(off, Math.min(bytes.length, off + chunkBytes))) });
        if (!OK(r)) continue;
        parts.push(r);
        total += r.samples;
        if (total >= MAX_DECODE_SECONDS * 16000) break;
      }
      return joinPcm(parts);
    }

    return null;
  } catch (e) {
    try { await ctx.store.logError({ where: "decodeToPcm", msg: e?.message || String(e) }); } catch {}
    return null;
  }
}

async function decCall(url, body) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const OK = (r) => r && r.ok && r.samples > 0;

/** Concatenate chunk responses' PCM into a single Int16Array at 16 kHz. */
function joinPcm(parts) {
  let n = 0;
  for (const p of parts) n += p.samples || 0;
  if (!n) return null;
  const out = new Int16Array(n);
  let off = 0;
  for (const p of parts) {
    const b = b64ToBytes(p.pcm);
    out.set(new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1), off);
    off += p.samples;
  }
  return out;
}

function compactTrack(tr) {
  return {
    id: tr.id, key: tr.key, source: tr.source, title: tr.title, artist: tr.artist,
    album: tr.album, year: tr.year, genre: tr.genre, artwork: tr.artwork,
    duration_ms: tr.duration_ms || 0, confidence: tr.confidence ?? null,
  };
}

// ── cache helpers (Cache API — no request quota on Workers) ────────────────
function cacheKeyUrl(key) {
  return new Request(`https://cache.local/${key}`, { method: "GET" });
}
async function cacheGetJson(ctx, key) {
  try {
    const hit = await caches.default.match(cacheKeyUrl(key));
    if (!hit) return null;
    const ts = parseInt(hit.headers.get("x-ts") || "0", 10);
    if (ts && Date.now() - ts > RECOG_TTL * 1000) return null;
    return await hit.json();
  } catch { return null; }
}
async function cachePutJson(ctx, key, value, ttlSec) {
  try {
    const body = JSON.stringify(value);
    const res = new Response(body, {
      headers: { "content-type": "application/json", "x-ts": String(Date.now()), "cache-control": `public, max-age=${Math.min(ttlSec, 86400)}` },
    });
    await caches.default.put(cacheKeyUrl(key), res);
  } catch {}
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
