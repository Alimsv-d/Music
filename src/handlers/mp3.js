import { hmacHex } from "../utils/crypto.js";
import { t } from "../i18n/index.js";
import { rlCheck, fmtWait } from "./rate.js";

export function mp3Configured(ctx) {
  return Boolean(ctx.env.MP3SVC_URL && ctx.env.MP3SVC_SECRET);
}

function mp3Base(ctx) {
  return String(ctx.env.MP3SVC_URL || "").replace(/\/$/, "");
}

function scBase(ctx) {
  return String(ctx.env.SOUNDCLOUD_API_URL || "").replace(/\/$/, "");
}

export function sidOf(tr) {
  return String(tr.sid || String(tr.id || "").replace(/^sc_/, ""));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Direct-send attempt for tracks with a native mp3 asset.
 * Returns the sent message or null. Caches the file_id through the caller's
 * putTrack when Telegram assigns one; deletes bogus (doc) deliveries.
 */
export async function sendDirectMp3(ctx, { chatId, tr, caption, title, artist, dur, markup, cacheKey }) {
  const urls = [tr.downloadUrl, tr.streamUrl].filter(Boolean);
  for (const url of urls) {
    try {
      const sent = await ctx.tg.sendAudio(chatId, {
        audio: url, caption, title, performer: artist, duration: dur, reply_markup: markup,
      });
      const fid = sent?.audio?.file_id;
      if (fid && cacheKey && ctx.store.putTrack) {
        ctx.exec.waitUntil(ctx.store.putTrack(cacheKey, { file_id: fid, title, artist, duration_ms: tr.duration_ms }));
        return sent;
      }
      let doc = sent?.audio ? null : sent;
      if (doc?.message_id) { try { await ctx.tg.deleteMessage(chatId, doc.message_id); } catch {} }
      // html-less delivery: cache whenever telegram echoed an audio
    } catch { /* try next URL */ }
  }
  return null;
}

/**
 * Enqueue signed m4a->mp3 job on the host transcoder.
 * -> { ok:true, job } | { ok:false, error }
 */
export async function enqueueMp3Job(ctx, tr) {
  const base = mp3Base(ctx);
  const secret = ctx.env.MP3SVC_SECRET;
  const sc = scBase(ctx);
  if (!base || !secret || !sc) return { ok: false, error: "unconfigured" };
  const body = JSON.stringify({
    url: `${sc}/api/v1/download?id=${sidOf(tr)}`,
    title: tr.title || "track",
    artist: tr.artist || "",
    dur: Math.round((tr.duration_ms || 0) / 1000),
  });
  try {
    const res = await fetch(`${base}/enqueue.php`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sig": await hmacHex(secret, body) },
      body,
    });
    const data = await res.json().catch(() => null);
    if (!data?.ok) return { ok: false, error: data?.error || `http_${res.status}` };
    return { ok: true, job: String(data.job) };
  } catch (e) {
    return { ok: false, error: e?.message || "fetch" };
  }
}

/**
 * Poll the transcoder until the MP3 is ready (or the budget lapses).
 * -> { state:"done", url:"https://…/dl.php?job=…&sig=…" } | { state:"failed", error? } | { state:"pending" }
 */
export async function pollMp3Job(ctx, job, opts = {}) {
  const base = mp3Base(ctx);
  const secret = ctx.env.MP3SVC_SECRET;
  if (!base || !secret || !job) return { state: "failed", error: "unconfigured" };
  const { budgetMs = +ctx.env.MP3_POLL_BUDGET_MS || 150000, firstWaitMs = +ctx.env.MP3_POLL_FIRST_WAIT_MS || 12000, stepMs = +ctx.env.MP3_POLL_STEP_MS || 6000 } = opts;
  const sig = await hmacHex(secret, job);
  const statusUrl = `${base}/status.php?job=${job}&sig=${sig}`;
  await sleep(firstWaitMs);
  const deadline = Date.now() + budgetMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    const st = await fetch(statusUrl, { method: "GET" })
      .then((r) => r.json().catch(() => null)).catch((e) => ({ error: e?.message || "fetch" }));
    if (st?.state === "done") {
      return { state: "done", url: `${base}${st.url || `/dl.php?job=${job}&sig=${sig}`}` };
    }
    if (st?.state === "failed") return { state: "failed", error: st.error || "" };
    lastErr = st?.error || lastErr;
    await sleep(stepMs);
  }
  return { state: "failed", error: lastErr || "timeout" };
}

/**
 * Full m4a->mp3 delivery: enqueue, status message, poll, send, cache.
 * `msg` must carry from.id + chat.id. Caller supplies caption/markup/duration.
 * Returns the final sent message (audio or a clear failure text).
 */
export async function deliverTranscodedMp3(ctx, { msg, tr, lang, caption, title, artist, dur, markup, cacheKey }) {
  const chatId = msg.chat.id;
  const statusMsg = await ctx.tg.sendMessage(chatId, t(lang, "transcoding")).catch(() => null);
  let result = await enqueueMp3Job(ctx, tr).catch(() => ({ ok: false, error: "fetch" }));

  const sendFail = async () => {
    const text = `${caption}\n\n${t(lang, "mp3_failed")}`;
    try {
      if (statusMsg?.message_id) return await ctx.tg.editMessageText(chatId, statusMsg.message_id, text, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: markup });
    } catch {}
    return ctx.tg.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: markup }).catch(() => null);
  };
  const clearStatus = () => { if (statusMsg?.message_id) ctx.tg.deleteMessage(chatId, statusMsg.message_id).catch(() => {}); };

  let sent = null;
  if (!result.ok) { clearStatus(); return sendFail(); }
  const wait = await rlCheck(ctx, msg.from?.id, "mp3convert").catch(() => null);
  if (wait) {
    clearStatus();
    return ctx.tg.sendMessage(chatId, t(lang, "rate_limited", { wait: fmtWait(wait) }), { parse_mode: "HTML" }).catch(() => null);
  }
  const jobState = await pollMp3Job(ctx, result.job);
  if (jobState?.state === "done") {
    try {
      sent = await ctx.tg.sendAudio(chatId, {
        audio: jobState.url, caption, title, performer: artist, duration: dur, reply_markup: markup,
      });
      const fid = sent?.audio?.file_id;
      if (fid && cacheKey && ctx.store.putTrack) {
        ctx.exec.waitUntil(ctx.store.putTrack(cacheKey, { file_id: fid, title, artist, duration_ms: tr.duration_ms }));
      }
    } catch { sent = null; }
  }
  clearStatus();
  if (sent?.message_id) return sent;
  return sendFail();
}

/**
 * The shared MP3-first funnel used by runDownload + deliverTrack.
 * Caller has already tried (and cleared) any cached file_id. Chooses:
 *   hasMp3 -> direct send of the worker's mp3 URLs; on failure falls through
 *   to the host transcode flow (never sends anything but mp3).
 */
export async function deliverMp3(ctx, { msg, tr, lang, caption, title, artist, dur, markup, cacheKey }) {
  const chatId = msg.chat.id;
  if (tr.hasMp3) {
    const direct = await sendDirectMp3(ctx, { chatId, tr, caption, title, artist, dur, markup, cacheKey });
    if (direct?.message_id) return direct;
  }
  return deliverTranscodedMp3(ctx, { msg, tr, lang, caption, title, artist, dur, markup, cacheKey });
}
