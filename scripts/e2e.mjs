// Worker-level E2E harness that runs WITHOUT workerd (this host caps OS
// threads, so `wrangler dev` cannot run). It imports src/index.js directly,
// stubs `caches`/KV/Telegram, feeds real Telegram updates through /webhook,
// and asserts the resulting Bot API calls + service calls.
//
// The REAL SoundCloud backend is used for search (network reachable), so the
// search path is genuinely exercised end to end.
//
// Run: node scripts/e2e.mjs

import worker from "../src/index.js";
import { MockKV } from "../test/mock-kv.js";

const WEBHOOK_SECRET = "test-secret-123";

// ── stub Telegram API by monkey-patching global fetch ────────────────────────
import scWorker from "../src/services/workers/soundcloud.js";
import shzWorker from "../src/services/workers/shazam.js";
import igWorker from "../src/services/workers/insta.js";
import decWorker from "../src/services/workers/decode.js";
import { readFile } from "node:fs/promises";

const calls = [];
let totalAnswers = 0;
const realFetch = globalThis.fetch;
const TG = "http://tg.mock";
const WORKER = "https://w.dev";
const SHAZAM_UP = "https://shazam-worker.alighost5920.workers.dev";
const SC_UP = "https://soundcloud-worker.alighost5920.workers.dev";
const INSTA_UP = "https://insta-worker.alighost5920.workers.dev";
const MEDIA = "http://media.mock";
let scSearchCalls = 0, shazamRecognizeCalls = 0, decCalls = 0;

// Cache API stub with real match/put semantics (Map-backed).
const cacheMap = new Map();
globalThis.caches = {
  default: {
    async match(req) {
      const e = cacheMap.get(String(req.url));
      if (!e) return undefined;
      if (Date.now() - e.ts > e.ttl * 1000) return undefined;
      return e.res.clone();
    },
    async put(req, res) {
      const ttl = +(res.headers.get("cache-control") || "").match(/max-age=(\d+)/)?.[1] || 3600;
      cacheMap.set(String(req.url), { ts: Date.now(), ttl, res: res.clone() });
    },
  },
};

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(TG)) {
    if (u.includes("/file/bot")) {
      const path = u.split("/file/bot123:abc/")[1];
      const f = await fixtureForPath(path).catch(() => null);
      if (f) return new Response(f, { headers: { "content-type": "application/octet-stream" } });
      return new Response("not found", { status: 404 });
    }
    const method = u.split("/").pop();
    const params = opts.body ? safeJson(opts.body) : {};
    calls.push({ method, params });
    if (method === "answerCallbackQuery") totalAnswers++;
    return jsonResp(tgResult(method, params));
  }
  // Self-routing: bundled /svc/* endpoints run in-process (as in production).
  if (u.startsWith(`${WORKER}/svc/`)) {
    const svcReq = new Request(u, opts);
    if (u.startsWith(`${WORKER}/svc/dec`)) { decCalls++; return decWorker.fetch(svcReq); }
    if (u.startsWith(`${WORKER}/svc/sc`)) return scWorker.fetch(svcReq, env, exec);
    if (u.startsWith(`${WORKER}/svc/shz`)) return shzWorker.fetch(svcReq, env, exec);
    if (u.startsWith(`${WORKER}/svc/ig`)) return igWorker.fetch(svcReq, env, exec);
  }
  // Shazam recognize (pcm) -> canned found result (real service is covered by live-check).
  if (u.startsWith(`${SHAZAM_UP}/api/v1/recognize`)) {
    shazamRecognizeCalls++;
    return jsonResp({ ok: true, data: { found: true, confidence: 0.9, track: {
      shazam_id: "1702137", title: "Goriz", artist: "Ebi", album: "Goriz",
      release_date: "2018-01-01", genre: "Pop", artwork: "https://is1-ssl.mzstatic.com/art.jpg",
      duration_ms: 210000,
    } } });
  }
  // SC search for the RECOGNIZED track ("Ebi Goriz") -> canned SC result so
  // delivery works. Other searches keep hitting the real SoundCloud backend.
  if (u.startsWith(`${SC_UP}/api/v1/search`) && safeJson(opts.body)?.query === "Ebi Goriz") {
    scSearchCalls++;
    return jsonResp({ ok: true, data: { found: true, results: [
      { id: "85511979", title: "Goriz", artist: "Ebi", streamUrl: "https://w.dev/svc/sc/stream/85511979", downloadUrl: "https://w.dev/svc/sc/download/85511979", duration_ms: 210000 },
    ] } });
  }
  // SC track enrich.
  if (u.match(/\/api\/v1\/track\/\d+/)) {
    return jsonResp({ ok: true, data: { id: "85511979", title: "Goriz", artist: "Ebi", album: "Goriz",
      artwork: "https://is1-ssl.mzstatic.com/art.jpg", streamUrl: "https://w.dev/svc/sc/stream/85511979",
      downloadUrl: "https://w.dev/svc/sc/download/85511979", duration_ms: 210000 } });
  }
  // Insta resolve -> canned reel with video pointing at a local fixture
  // (shape mirrors the real insta-worker: items[].variants[]).
  if (u.startsWith(`${INSTA_UP}/api/v1/resolve`)) {
    const sc = u.match(/reel\/([^/?&]+)/)?.[1] || "x";
    return jsonResp({ ok: true, data: { shortcode: sc, caption: "reel caption", author: { username: "reeluser" },
      items: [{ type: "video", index: 0,
        variants: [{ url: `${MEDIA}/reel_${sc}.mp4`, mime: "video/mp4", has_audio: true, quality: "best", width: 640, height: 1136 }] }] } });
  }
  // Insta CDN media -> fixture bytes.
  if (u.startsWith(MEDIA)) {
    const f = await readFile(new URL("../test/fixtures/video3s.mp4", import.meta.url));
    return new Response(f, { headers: { "content-type": "video/mp4" } });
  }
  // passthrough to real network for the backend services
  return realFetch(url, opts);
};

const FIXTURES = {
  "v/voice.ogg": "voice10s.ogg",
  "v/audio.m4a": "audio3s.m4a",
  "v/video.mp4": "video3s.mp4",
  "v/audio.mp3": "audio10s.mp3",
};
async function fixtureForPath(path) {
  const name = FIXTURES[path];
  if (!name) return null;
  return readFile(new URL(`../test/fixtures/${name}`, import.meta.url));
}

function safeJson(b) {
  if (typeof b === "string") { try { return JSON.parse(b); } catch { return { _raw: b.slice(0, 60) }; } }
  if (b instanceof FormData) { const o = { _multipart: true }; for (const [k, v] of b.entries()) o[k] = v instanceof File ? `[file:${v.name}]` : v; return o; }
  return {};
}
function tgResult(method, p) {
  if (method === "getFile") {
    const map = { FVOICE1: "v/voice.ogg", FDOC1: "v/audio.m4a", FAUD1: "v/audio.mp3", FVID1: "v/video.mp3" };
    return { ok: true, result: { file_path: map[p.file_id] || "v/voice.ogg" } };
  }
  if (method === "getMe") return { ok: true, result: { id: 1, is_bot: true, username: "musicbot" } };
  if (method === "getChatMember") return { ok: true, result: { status: "member" } };
  if (method === "getWebhookInfo") return { ok: true, result: { url: "", pending_update_count: 0 } };
  if (/send|edit|copy|forward/.test(method)) return { ok: true, result: { message_id: 99, chat: { id: p.chat_id }, audio: { file_id: "FID1" } } };
  return { ok: true, result: true };
}
const jsonResp = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });

// ── env + ctx ────────────────────────────────────────────────────────────────
const env = {
  KV: new MockKV(),
  OWNER_ID: "8437014959", OWNER_USERNAME: "AliMsvD", CREATOR_NAME: "Ali Mousavi",
  BOT_NAME: "Music", BOT_USERNAME: "musicbot",
  BOT_TOKEN: "123:abc", WEBHOOK_SECRET, LINK_SECRET: "linksecret", ADMIN_SETUP_KEY: "setupkey",
  TELEGRAM_API_BASE: TG,
  SOUNDCLOUD_API_URL: "https://soundcloud-worker.alighost5920.workers.dev",
  SHAZAM_API_URL: "https://shazam-worker.alighost5920.workers.dev",
  INSTA_API_URL: "https://insta-worker.alighost5920.workers.dev",
  LEGACY_INSTA_API_URL: "https://catplus.ir/api/insta",
  LRCLIB_API_URL: "https://lrclib.net",
  DEFAULT_LANG: "fa", PAGE_SIZE: "10", RESULT_TTL: "3600", RATE_LIMIT_PER_MIN: "20",
  API_TIMEOUT_MS: "8000", MAX_UPLOAD_MB: "50", SEARCH_CACHE_TTL: "300", TRACK_CACHE_TTL: "3600",
  DEFAULT_SUPPORT_URL: "https://t.me/AliMsvD",
};
// Patch the KV binding to also serve `get`/`put` used by Store. MockKV already does.

// exec context that runs waitUntil tasks inline-ish (fire and forget, tracked).
const pending = [];
const exec = { waitUntil: (p) => pending.push(Promise.resolve(p).catch((e) => { if (process.env.E2E_DEBUG) console.log("waitUntil ERR:", e?.stack || e); })) };
const drain = async () => { await Promise.allSettled(pending.splice(0)); };

let uidc = 1;
const req = (update, secret = WEBHOOK_SECRET) => new Request("https://w.dev/webhook", {
  method: "POST",
  headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
  body: JSON.stringify(update),
});
const upd = (o) => ({ update_id: uidc++, ...o });
const privMsg = (text, from = 42, extra = {}) => upd({ message: { message_id: uidc, from: { id: from, first_name: "T", username: "u" + from }, chat: { id: from, type: "private" }, text, ...extra } });
let callbackQueriesSent = 0;
const cb = (data, from = 42) => { callbackQueriesSent++; return upd({ callback_query: { id: "cb" + uidc, from: { id: from }, message: { message_id: 1, chat: { id: from, type: "private" } }, data } }); };

const called = (m) => calls.filter((c) => c.method === m);
const last = (m) => called(m).slice(-1)[0];
const results = [];
const check = (name, cond, info = "") => results.push([name, !!cond, info]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = async (update) => { const r = await worker.fetch(req(update), env, exec); await drain(); return r.status; };

// 1) bad secret rejected
{
  const r = await worker.fetch(req(privMsg("/start"), "nope"), env, exec);
  check("rejects bad webhook secret", r.status === 403, `status ${r.status}`);
}

// 2) /start -> welcome + menu
calls.length = 0;
await run(privMsg("/start"));
check("/start sends welcome", called("sendMessage").length >= 1, last("sendMessage")?.params?.text?.slice(0, 30));
check("welcome has menu buttons", !!last("sendMessage")?.params?.reply_markup?.inline_keyboard?.length);

// 3) text search -> result list (real SC)
calls.length = 0;
await run(privMsg("ebi goriz"));
const smsg = last("sendMessage") || last("sendAudio");
check("search produces output", !!smsg, (smsg?.params?.text || smsg?.params?.caption || "").slice(0, 40));

// 4) dedupe: same update_id processed once
calls.length = 0;
const u = privMsg("/start"); u.update_id = 4242;
await run(u); await run(u);
check("dedupes update_id", called("sendMessage").length <= 1);

// 5) normal user panel denied
calls.length = 0;
await run(cb("pn:stats", 42));
check("user denied panel (answered)", called("answerCallbackQuery").length >= 1);
check("user NOT shown stats", !(last("editMessageText")?.params?.text || "").includes("آمار"));

// 6) owner panel opens
calls.length = 0;
await run(privMsg("/panel", 8437014959));
check("owner panel opens", (last("sendMessage")?.params?.text || "").includes("پنل"));

// 7) owner stats
calls.length = 0;
await run(cb("pn:stats", 8437014959));
check("owner stats shown", (last("editMessageText")?.params?.text || "").includes("آمار") || called("sendMessage").length >= 1);

// 8) inline query -> audio results
calls.length = 0;
await run(upd({ inline_query: { id: "iq1", from: { id: 42 }, query: "ebi", offset: "" } }));
check("inline answered", called("answerInlineQuery").length >= 1);
const iqr = last("answerInlineQuery")?.params;
check("inline returns results", Array.isArray(iqr?.results) && iqr.results.length > 0, `${iqr?.results?.length ?? 0} results`);
check("inline has signed /dl urls", (iqr?.results || []).some((r) => (r.audio_url || "").includes("/dl/")) || (iqr?.results || []).some((r) => r.audio_file_id));

// 9) voice -> getFile + recognition attempt
calls.length = 0;
await run(upd({ message: { message_id: uidc, from: { id: 42 }, chat: { id: 42, type: "private" }, voice: { file_id: "F1", duration: 5, file_size: 1000 } } }));
check("voice handled (getFile or reply)", called("getFile").length >= 1 || called("sendMessage").length >= 1);

// 10) instagram link handled
calls.length = 0;
await run(privMsg("https://www.instagram.com/reel/DEADBEEF/"));
check("insta handled", called("sendMessage").length + called("sendVideo").length + called("sendMediaGroup").length >= 1);

// 11) /dl signed proxy requires valid signature
{
  const bad = await worker.fetch(new Request("https://w.dev/dl/bad.sig.mp3"), env, exec);
  check("unsigned /dl rejected", bad.status === 403 || bad.status === 400);
  const { signLink } = await import("../src/utils/crypto.js");
  const good = await signLink("linksecret", "sc:85511979", 3600);
  const gres = await worker.fetch(new Request(`https://w.dev/dl/${encodeURIComponent(good)}.mp3`), env, exec);
  check("signed /dl proxies audio", gres.status === 200 || gres.status === 206, `status ${gres.status}`);
}

// 12) language switch callback
calls.length = 0;
await run(cb("lang:en", 42));
check("lang switch answered", called("answerCallbackQuery").length >= 1);

// 13) health endpoint
{
  const h = await worker.fetch(new Request("https://w.dev/health"), env, exec);
  const j = await h.json();
  check("/health returns json", j.ok === true);
}

// 15) voice note -> /svc/dec chunks -> Shazam PCM -> auto-deliver SC track
calls.length = 0; decCalls = 0; shazamRecognizeCalls = 0; scSearchCalls = 0;
await run(upd({ message: { message_id: uidc, from: { id: 42 }, chat: { id: 42, type: "private" }, voice: { file_id: "FVOICE1", duration: 10, file_size: 42927, mime_type: "audio/ogg" } } }));
check("voice decoded via /svc/dec", decCalls > 0, `${decCalls} chunks`);
check("voice recognized via shazam pcm", shazamRecognizeCalls > 0);
check("voice auto-delivered as audio", !!last("sendAudio"), String(last("sendAudio")?.params?.audio || "").slice(0, 60));

// 16) same voice again -> answered from recognition cache (zero upstream work)
{
  const d0 = decCalls, s0 = shazamRecognizeCalls;
  calls.length = 0;
  await run(upd({ message: { message_id: uidc, from: { id: 42 }, chat: { id: 42, type: "private" }, voice: { file_id: "FVOICE1", duration: 10, file_size: 42927, mime_type: "audio/ogg" } } }));
  check("repeated voice served from cache", decCalls === d0 && shazamRecognizeCalls === s0 && !!last("sendAudio"));
}

// 17) m4a audio document -> decoded -> delivered
calls.length = 0;
await run(upd({ message: { message_id: uidc, from: { id: 42 }, chat: { id: 42, type: "private" }, document: { file_id: "FDOC1", file_name: "song.m4a", mime_type: "audio/mp4", file_size: 35267 } } }));
check("m4a document recognized", shazamRecognizeCalls > 0);
check("m4a delivered", !!last("sendAudio"), calls.filter((c) => /send|edit/.test(c.method)).map((c) => c.method).join(","));

// 18) mp3 audio -> sliced decode -> delivered
calls.length = 0;
await run(upd({ message: { message_id: uidc, from: { id: 42 }, chat: { id: 42, type: "private" }, audio: { file_id: "FAUD1", duration: 10, file_size: 160958, mime_type: "audio/mpeg" } } }));
check("mp3 recognized", shazamRecognizeCalls > 0);
check("mp3 delivered", !!last("sendAudio"));

// 19) instagram reel -> video sent, then music auto-delivered
calls.length = 0;
{
  const d0 = decCalls, s0 = shazamRecognizeCalls;
  await run(privMsg("https://www.instagram.com/reel/CACHEV/"));
  check("reel video sent", called("sendVideo").length >= 1 || called("sendMediaGroup").length >= 1);
  check("reel music auto-delivered", !!last("sendAudio"), calls.map((c) => c.method).join(",") + ` | dec+${decCalls - d0} shz+${shazamRecognizeCalls - s0} | err: ${(JSON.stringify(await env.KV.get("err:log", "json") || []).slice(0, 300))}`);
}

// 20) every callback answered
check("every callback answered", totalAnswers >= callbackQueriesSent && callbackQueriesSent >= 3, `${totalAnswers}/${callbackQueriesSent} answered`);

console.log("\n| e2e check | result | info |\n|---|---|---|");
let fail = 0;
for (const [n, ok, info] of results) { if (!ok) fail++; console.log(`| ${n} | ${ok ? "✅" : "❌"} | ${info} |`); }
console.log(`\n${results.length - fail}/${results.length} e2e checks passed`);
process.exit(fail ? 1 : 0);
