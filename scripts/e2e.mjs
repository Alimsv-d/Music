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
const calls = [];
let totalAnswers = 0;
const realFetch = globalThis.fetch;
const TG = "http://tg.mock";

globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
const cacheStore = new MockKV();

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(TG)) {
    const method = u.split("/").pop();
    const params = opts.body ? safeJson(opts.body) : {};
    calls.push({ method, params });
    if (method === "answerCallbackQuery") totalAnswers++;
    return jsonResp(tgResult(method, params));
  }
  // passthrough to real network for the backend services
  return realFetch(url, opts);
};

function safeJson(b) {
  if (typeof b === "string") { try { return JSON.parse(b); } catch { return { _raw: b.slice(0, 60) }; } }
  if (b instanceof FormData) { const o = { _multipart: true }; for (const [k, v] of b.entries()) o[k] = v instanceof File ? `[file:${v.name}]` : v; return o; }
  return {};
}
function tgResult(method, p) {
  if (method === "getFile") return { ok: true, result: { file_path: "v/f.ogg" } };
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
const exec = { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) };
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

// 14) every callback answered
check("every callback answered", totalAnswers >= callbackQueriesSent && callbackQueriesSent >= 3, `${totalAnswers}/${callbackQueriesSent} answered`);

console.log("\n| e2e check | result | info |\n|---|---|---|");
let fail = 0;
for (const [n, ok, info] of results) { if (!ok) fail++; console.log(`| ${n} | ${ok ? "✅" : "❌"} | ${info} |`); }
console.log(`\n${results.length - fail}/${results.length} e2e checks passed`);
process.exit(fail ? 1 : 0);
