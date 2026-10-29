// Worker entry point. Webhook-only bot on Cloudflare Workers.
//
// Routes:
//   GET  /            branded status page
//   GET  /health      JSON API health check
//   GET  /setup?key=  bootstrap webhook + commands (key = ADMIN_SETUP_KEY)
//   POST /webhook     Telegram updates (verified by WEBHOOK_SECRET header)
//   GET  /dl/<sig>    signed MP3 proxy for inline-mode audio (HTTP Range ok)
//   cron              webhook watchdog + broadcast job processing

import { Ctx } from "./ctx.js";
import { verifyLink } from "./utils/crypto.js";
import { timingSafeEqualStr } from "./utils/crypto.js";
import { secret } from "./utils/secrets.js";
import { handleMessage } from "./handlers/message.js";
import { handleCallback } from "./handlers/callback.js";
import { handleInlineQuery, handleChosenInline } from "./handlers/inline.js";
import { setupWebhook, runBroadcastChunk } from "./handlers/admin.js";
import { COMMANDS } from "./handlers/commands.js";
import { t } from "./i18n/index.js";

// Bundled web services — the SoundCloud, Shazam and Instagram resolvers run
// inside THIS worker under a prefix, so the whole stack deploys as ONE
// codebase + ONE worker (no separate service URLs). The bot's service clients
// reach them via the same-origin URLs configured in wrangler.jsonc.
import scWorker from "./services/workers/soundcloud.js";
import shzWorker from "./services/workers/shazam.js";
import igWorker from "./services/workers/insta.js";
import decWorker from "./services/workers/decode.js";

export default {
  async fetch(request, env, exec) {
    const url = new URL(request.url);
    const path = url.pathname;
    const ctx = new Ctx(env, exec);
    ctx.request = request;
    ctx.bindOrigin(request);

    try {
      // ── bundled service routing (delegated by path prefix) ────────────────
      // /svc/sc/<rest>  -> SoundCloud worker (search/track/stream/download/f/…)
      // /svc/shz/<rest> -> Shazam worker (health/search/lyrics/recognize)
      // /svc/ig/<rest>  -> Instagram worker (resolve/download/health)
      // /svc/dec        -> in-worker audio decoder (chunked PCM for recognition)
      for (const [prefix, worker] of [["/svc/sc", scWorker], ["/svc/shz", shzWorker], ["/svc/ig", igWorker], ["/svc/dec", decWorker]]) {
        if (path === prefix || path.startsWith(prefix + "/")) {
          const rewritten = new URL(request.url);
          rewritten.pathname = path === prefix ? "/" : path.slice(prefix.length);
          const fwd = new Request(rewritten.toString(), request);
          // Share the bot's KV binding with bundled services under the names
          // their standalone workers expect. No extra service URL/binding is
          // required when the stack is deployed as one Worker.
          const serviceEnv = {
            ...env,
            CACHE_KV: env.KV,
            CACHE: env.KV,
            BACKEND_URL: env.SHAZAM_BACKEND_URL,
            BACKEND_KEY: env.SHAZAM_BACKEND_KEY,
            PUBLIC_URL: env.PUBLIC_URL || url.origin,
          };
          return worker.fetch(fwd, serviceEnv, exec);
        }
      }

      // First-request auto-activation: after a Deploy-to-Cloudflare install the
      // very first hit on the worker (or any user message) registers the webhook
      // in the background — no manual /setup needed. Skipped while running
      // locally (127.x) so `wrangler dev` never hijacks a live webhook.
      if (env.BOT_TOKEN && !url.hostname.startsWith("127.") && url.hostname !== "localhost") {
        exec.waitUntil(
          (async () => {
            try {
              if (!(await ctx.store.getCfg("activated"))) {
                await runSetup(request, env, ctx, url);
              }
            } catch {}
          })()
        );
      }

      if (path === "/" || path === "") return statusPage(request, env);
      if (path === "/health") return healthCheck(ctx);
      if (path === "/setup") return setupRoute(request, env, ctx, url);
      if (path === "/webhook" && request.method === "POST") return webhook(request, env, exec, ctx);
      if (path.startsWith("/dl/")) return dlProxy(ctx, path, request);
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error("fetch error:", e?.message);
      try { await ctx.store.logError({ where: "fetch", msg: e?.message }); } catch {}
      return new Response("error", { status: 500 });
    }
  },

  async scheduled(event, env, exec) {
    const ctx = new Ctx(env, exec);
    exec.waitUntil(cronTick(ctx, event));
  },
};

// ── webhook ───────────────────────────────────────────────────────────────────
async function webhook(request, env, exec, ctx) {
  // Verify Telegram's secret header.
  const token = request.headers.get("x-telegram-bot-api-secret-token") || "";
  const expected = await secret(env, "WEBHOOK_SECRET");
  if (!expected || !timingSafeEqualStr(token, expected)) {
    return new Response("forbidden", { status: 403 });
  }

  let update;
  try { update = await request.json(); } catch { return new Response("bad", { status: 400 }); }

  // Acknowledge immediately; do the work in the background.
  exec.waitUntil(processUpdate(ctx, update));
  return new Response("ok");
}

async function processUpdate(ctx, update) {
  try {
    // Dedupe by update_id (10 min TTL).
    if (update.update_id !== undefined) {
      const dup = await ctx.store.seenUpdate(update.update_id);
      if (dup) return;
    }

    if (update.message) {
      await ctx.store.bump("updates");
      return await handleMessage(ctx, update.message);
    }
    if (update.edited_message) {
      // Treat edited messages lightly: only re-run search if it's a command.
      return;
    }
    if (update.callback_query) return await handleCallback(ctx, update.callback_query);
    if (update.inline_query) return await handleInlineQuery(ctx, update.inline_query);
    if (update.chosen_inline_result) return await handleChosenInline(ctx, update.chosen_inline_result);
    if (update.my_chat_member || update.chat_member) {
      // Track joins/leaves & bot admin changes. Minimal: bump counters.
      await ctx.store.bump("member_events");
      return;
    }
  } catch (e) {
    console.error("processUpdate:", e?.message);
    try { await ctx.store.logError({ where: "update", msg: e?.message }); } catch {}
  }
}

// ── /dl/<signed> MP3 proxy ────────────────────────────────────────────────────
// Streams the resolved SoundCloud audio through the worker with Range support,
// so Telegram can fetch it for InlineQueryResultAudio. Signed to prevent abuse.
async function dlProxy(ctx, path, request) {
  const token = decodeURIComponent(path.slice("/dl/".length)).replace(/\.mp3$/, "");
  const v = await verifyLink(await secret(ctx.env, "LINK_SECRET"), token);
  if (!v.ok) return new Response("forbidden", { status: 403 });

  const [source, ...idParts] = v.id.split(":");
  const id = idParts.join(":");
  if (source !== "sc" || !id) return new Response("bad id", { status: 400 });

  const base = (ctx.sc.base || "").replace(/\/$/, "");
  if (!base) return new Response("soundcloud backend not configured", { status: 503 });
  const candidates = [
    `${base}/api/v1/download?id=${encodeURIComponent(id)}`,
    `${base}/api/v1/stream?id=${encodeURIComponent(id)}`,
  ];
  const requestHeaders = {};
  const range = request.headers.get("range");
  if (range) requestHeaders.range = range;

  let res = null;
  for (const upstream of candidates) {
    try {
      const candidate = await fetch(upstream, { headers: requestHeaders });
      const ct = (candidate.headers.get("content-type") || "").toLowerCase();
      // /download can return a JSON/HLS manifest for browser-mode tracks.
      if ((!candidate.ok && candidate.status !== 206) || ct.includes("application/json") || ct.includes("mpegurl") || ct.includes("text/plain")) continue;
      res = candidate;
      break;
    } catch {}
  }
  if (!res) return new Response("upstream unavailable", { status: 502 });

  const out = new Headers();
  out.set("content-type", res.headers.get("content-type") || "audio/mpeg");
  const cl = res.headers.get("content-length"); if (cl) out.set("content-length", cl);
  const cr = res.headers.get("content-range"); if (cr) out.set("content-range", cr);
  out.set("accept-ranges", "bytes");
  out.set("cache-control", "public, max-age=300");
  return new Response(res.body, { status: res.status, headers: out });
}

// ── /setup ────────────────────────────────────────────────────────────────────
// Idempotent. If the bot was never activated, calling /setup with NO key (or a
// matching key) runs it once — that's how Deploy-to-Cloudflare users go live
// with just BOT_TOKEN + OWNER_ID. After activation only the key opens it.
async function setupRoute(request, env, ctx, url) {
  const key = url.searchParams.get("key") || "";
  const already = await ctx.store.getCfg("activated");
  const adminKey = await secret(env, "ADMIN_SETUP_KEY");
  if (already && (!adminKey || !timingSafeEqualStr(key, adminKey))) {
    return json({ ok: false, error: "forbidden" }, 403);
  }
  return runSetup(request, env, ctx, url);
}

async function runSetup(request, env, ctx, url) {
  const report = { ok: true, steps: {} };
  const expectedBase = env.PUBLIC_URL || url.origin;
  const expectedWebhook = `${expectedBase}/webhook`;
  if (env.PUBLIC_URL && url.origin !== expectedBase) report.warnings = [...(report.warnings || []), "public_url_mismatch"];

  try {
    await ctx.tg.setWebhook(expectedWebhook, {
      secret_token: await secret(env, "WEBHOOK_SECRET"),
      allowed_updates: ["message", "edited_message", "callback_query", "inline_query", "chosen_inline_result", "my_chat_member", "chat_member"],
      drop_pending_updates: true,
      max_connections: 40,
    });
    report.steps.webhook = "ok";
  } catch (e) { report.steps.webhook = e.message; report.ok = false; }

  try {
    await ctx.tg.setMyCommands(COMMANDS.private, { type: "all_private_chats" }, "fa");
    await ctx.tg.setMyCommands(COMMANDS.private, { type: "all_private_chats" }, "en");
    await ctx.tg.setMyCommands(COMMANDS.group, { type: "all_group_chats" });
    report.steps.commands = "ok";
  } catch (e) { report.steps.commands = e.message; report.ok = false; }

  try {
    const desc = `🎧 ${env.BOT_NAME || "Music"} — جستجو، تشخیص و دانلود موزیک\n👨‍💻 ${env.CREATOR_NAME} @${env.OWNER_USERNAME}`;
    await ctx.tg.setMyDescription({ description: desc });
    await ctx.tg.setMyShortDescription({ short_description: "🎧 جستجو و دانلود موزیک / Music search & download" });
    report.steps.description = "ok";
  } catch (e) { report.steps.description = e.message; report.ok = false; }

  try {
    const info = await ctx.tg.getWebhookInfo();
    report.webhook_info = {
      url: info?.url || null,
      pending_update_count: info?.pending_update_count || 0,
      last_error_message: info?.last_error_message || null,
    };
    if (info?.url !== expectedWebhook) {
      report.ok = false;
      report.steps.webhook_verify = `expected ${expectedWebhook} but got ${info?.url || "none"}`;
    }
    if (info?.last_error_message) {
      report.ok = false;
      report.steps.webhook_error = info.last_error_message;
    }
  } catch (e) {
    report.ok = false;
    report.steps.webhook_info = e.message;
  }
  if (report.ok) await ctx.store.setCfg("activated", { at: Date.now(), url: expectedWebhook });
  return json(report, report.ok ? 200 : 500);
}

// ── /health ───────────────────────────────────────────────────────────────────
async function healthCheck(ctx) {
  const [sc, shz, insta, lyr] = await Promise.all([
    ctx.sc.ping(), ctx.shz.ping(), ctx.insta.ping(), ctx.lyr.ping(),
  ]);
  let webhook = null;
  try { const w = await ctx.tg.getWebhookInfo(); webhook = { url: w.url, pending: w.pending_update_count, error: w.last_error_message || null }; } catch {}
  return json({
    ok: true,
    bot: ctx.env.BOT_NAME,
    creator: `${ctx.env.CREATOR_NAME} @${ctx.env.OWNER_USERNAME}`,
    time: new Date().toISOString(),
    apis: { soundcloud_ms: sc, shazam_ms: shz, instagram_ms: insta, lrclib_ms: lyr },
    webhook,
  });
}

// ── / status page ────────────────────────────────────────────────────────────
function statusPage(request, env) {
  const name = env.BOT_NAME || "Music";
  const html = `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} Bot</title>
<style>body{margin:0;font-family:system-ui,Tahoma;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh}
.c{text-align:center;padding:2rem}.dot{display:inline-block;width:14px;height:14px;border-radius:50%;background:#3fb950;box-shadow:0 0 12px #3fb950;vertical-align:middle}
h1{font-size:2rem;margin:.4rem 0}.st{color:#3fb950;font-weight:700}.muted{color:#8b949e}a{color:#58a6ff}</style></head>
<body><div class="c"><div class="dot"></div><h1>🎧 ${name} Bot</h1>
<p class="st">Online</p><p class="muted">Music search · recognize · download<br>on Cloudflare Workers</p>
<p class="muted">👨‍💻 ${env.CREATOR_NAME || "Ali Mousavi"} — <a href="https://t.me/${env.OWNER_USERNAME || "AliMsvD"}">@${env.OWNER_USERNAME || "AliMsvD"}</a></p></div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// ── cron ──────────────────────────────────────────────────────────────────────
async function cronTick(ctx, event) {
  // 1) resume any pending broadcast jobs (every minute).
  try {
    const jobs = (await ctx.store.listJobs()).filter((j) => j.status === "queued" || j.status === "running");
    for (const j of jobs) ctx.exec.waitUntil(runBroadcastChunk(ctx, j.id));
  } catch (e) { await ctx.store.logError({ where: "cron.jobs", msg: e.message }); }

  // 2) webhook watchdog (every 5-min trigger — cheap enough to run each tick).
  try {
    const info = await ctx.tg.getWebhookInfo();
    let base = ctx.env.PUBLIC_URL || "";
    if (!base) {
      try { base = (await ctx.store.getCfg("activated"))?.url || ""; } catch {}
      base = base.replace(/\/webhook\/?$/, "");
    }
    const want = base ? `${base.replace(/\/$/, "")}/webhook` : null;
    const bad = !!info.last_error_message || (want && info.url !== want);
    if (bad) {
      await setupWebhook(ctx);
      const owner = ctx.ownerId;
      if (owner) {
        await ctx.tg.sendMessage(owner,
          `⚠️ Webhook ${info.last_error_message ? "had an error" : "mismatched"} and was reset.\n` +
          `err: ${info.last_error_message || "url mismatch"}`).catch(() => {});
      }
    }
  } catch (e) { /* no token configured yet */ }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
