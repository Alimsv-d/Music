// =============================================================================
// insta-worker — independent Instagram public-content resolver & downloader.
// A bilingual web page plus a versioned JSON API on one Cloudflare Worker.
// No database, no admin panel and no mandatory secrets.
// =============================================================================

import { parseInstagramUrl, buildFilename } from "./lib/urls.js";
import { extensionForMime } from "./lib/normalize.js";
import {
  resolveContent,
  checkProviderHealth,
  providerHealthSnapshot,
  parseUpstreams,
  providerName,
} from "./lib/providers.js";
import { streamMedia, validateProxyUrl, exceedsMaxSize, maxBytes } from "./lib/security.js";
import {
  checkRateLimit,
  rateLimits,
  rateHeaders,
  clientKey,
  apiKeyBucket,
  cacheGet,
  cacheSet,
  etagFrom,
} from "./lib/storage.js";
import {
  jsonError,
  jsonOk,
  jsonResponse,
  baseHeaders,
  applyCors,
  newRequestId,
  withRequestId,
} from "./lib/http.js";
import { timingSafeEqual } from "./lib/crypto.js";
import { langFromRequest, uiLangFromRequest } from "./lib/i18n.js";
import { renderHome } from "./lib/ui.js";

const VERSION = "1.0.0";
const NAME = "insta-worker";
const ENDPOINTS = [
  { method: "GET", path: "/api/v1/resolve", description: "Resolve public metadata and variants." },
  { method: "GET", path: "/api/v1/download", description: "Stream a media variant." },
  { method: "GET", path: "/api/v1/thumbnail", description: "Proxy a thumbnail image." },
  { method: "GET", path: "/health", description: "Service and provider health." },
  { method: "GET", path: "/openapi.json", description: "OpenAPI 3 document." },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentDisposition(filename) {
  const safe = String(filename || "media").replace(/["\\\r\n]/g, "_");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function resolveVariant(result, quality, index) {
  if (index < 0 || index >= result.items.length) return { error: "E_BAD_INDEX" };
  const item = result.items[index];
  if (!item || item.variants.length === 0) return { error: "E_NO_VARIANTS" };
  const wanted = String(quality || "best");
  const variant =
    wanted === "best"
      ? item.variants[0]
      : item.variants.find((v) => v.quality === wanted);
  if (!variant) return { error: "E_BAD_QUALITY" };
  return { variant, item, index };
}

function parseIndex(raw) {
  if (raw === null || raw === undefined || raw === "") return 0;
  if (!/^\d{1,6}$/.test(String(raw))) return null;
  return Number(raw);
}

/** Optional static API keys: comma-separated in the API_KEYS secret. */
function parseApiKeys(env) {
  const raw = env && env.API_KEYS;
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function providedApiKey(request) {
  const direct = request.headers.get("x-api-key");
  if (direct && direct.trim()) return direct.trim();
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * When API_KEYS is unset the API is public and limiter buckets are IP-based.
 * When it is set, every /api/v1 request must present a matching key, and the
 * limiter bucket is derived from the key (the raw key is never stored).
 */
async function authenticate(request, env) {
  const keys = parseApiKeys(env);
  if (keys.length === 0) {
    return { ok: true, authRequired: false, bucket: await clientKey(request, env) };
  }
  const provided = providedApiKey(request);
  if (!provided) return { ok: false, authRequired: true };
  for (const key of keys) {
    if (await timingSafeEqual(provided, key)) {
      return { ok: true, authRequired: true, bucket: await apiKeyBucket(env, provided) };
    }
  }
  return { ok: false, authRequired: true };
}

async function metaForResolve(parsed, env) {
  const cached = await cacheGet(env, parsed.shortcode);
  if (cached) return { data: cached, cached: true };
  const data = await resolveContent(parsed, env);
  await cacheSet(env, parsed.shortcode, data);
  return { data, cached: false };
}

function rateLimited(request, env, lang, requestId, rl) {
  return jsonError("E_RATE_LIMIT", lang, {
    request,
    env,
    headers: rateHeaders(rl),
    body: { request_id: requestId },
  });
}

function jsonHeaders(request, env, requestId, extra = {}) {
  return { "x-request-id": requestId, ...extra };
}

/** A cryptographically random CSP nonce for inline style and script blocks. */
function newNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function contentSecurityPolicy(nonce) {
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    "style-src-attr 'none'",
    `script-src 'nonce-${nonce}'`,
    "script-src-attr 'none'",
    "connect-src 'self' https://*.cdninstagram.com https://*.fbcdn.net",
    "img-src 'self' data: https://*.cdninstagram.com https://*.fbcdn.net",
    "media-src 'self' https://*.cdninstagram.com https://*.fbcdn.net",
    "font-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * Content negotiation for GET /. Browsers send `text/html`; API clients send
 * `application/json` (or no Accept at all). Explicit JSON wins on a tie.
 */
function wantsHtml(request) {
  const accept = String(request.headers.get("accept") || "").toLowerCase();
  const html = accept.match(/(?:^|,\s*)text\/html\s*(?:;\s*q=([0-9.]+))?\s*(?:,|$)/);
  if (!html) return false;
  const htmlQ = html[1] === undefined ? 1 : Number(html[1]);
  if (!Number.isFinite(htmlQ) || htmlQ <= 0) return false;
  const json = accept.match(/(?:^|,\s*)application\/json\s*(?:;\s*q=([0-9.]+))?\s*(?:,|$)/);
  if (!json) return true;
  const jsonQ = json[1] === undefined ? 1 : Number(json[1]);
  if (!Number.isFinite(jsonQ)) return false;
  return htmlQ > jsonQ;
}

function htmlResponse(request, env, requestId) {
  const url = new URL(request.url);
  const nonce = newNonce();
  const debug = url.searchParams.get("debug") === "1";
  const html = renderHome({
    lang: uiLangFromRequest(request),
    nonce,
    build: VERSION,
    debug,
    origin: url.origin,
  });
  const headers = baseHeaders(request, env, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, no-store",
    "content-security-policy": contentSecurityPolicy(nonce),
    "x-frame-options": "DENY",
    "vary": "Accept, Accept-Language",
    "content-language": uiLangFromRequest(request),
    "x-request-id": requestId,
  });
  const isHead = String(request.method || "").toUpperCase() === "HEAD";
  return new Response(isHead ? null : html, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleRoot(request, env, lang, requestId) {
  if (wantsHtml(request)) return htmlResponse(request, env, requestId);
  return jsonOk(
    {
      name: NAME,
      version: VERSION,
      description: "Public Instagram metadata and media proxy with a bilingual web UI.",
      endpoints: ENDPOINTS,
      openapi: "/openapi.json",
      auth_required: parseApiKeys(env).length > 0,
    },
    lang,
    { request, env, headers: jsonHeaders(request, env, requestId) },
  );
}

async function handleResolve(request, env, lang, requestId, bucket, limitOverride) {
  const url = new URL(request.url);
  let parsed;
  try {
    parsed = parseInstagramUrl(url.searchParams.get("url"));
  } catch (e) {
    return jsonError(e.code || "E_INVALID_URL", lang, {
      request,
      env,
      body: { request_id: requestId },
    });
  }

  const limit = limitOverride || rateLimits(env).resolve;
  const rl = await checkRateLimit(env, "resolve", bucket, limit);
  if (!rl.allowed) return rateLimited(request, env, lang, requestId, rl);

  try {
    const { data, cached } = await metaForResolve(parsed, env);
    const etag = await etagFrom(data);
    const cacheControl = "private, no-store";
    const headers = jsonHeaders(request, env, requestId, {
      etag,
      "cache-control": cacheControl,
      "x-cache": cached ? "HIT" : "MISS",
      ...rateHeaders(rl),
    });

    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: baseHeaders(request, env, headers) });
    }

    return jsonResponse(
      withRequestId({ ok: true, status: 200, lang, data, meta: { cached, version: VERSION } }, requestId),
      200,
      lang,
      { request, env, headers },
    );
  } catch (err) {
    return jsonError(err.code || "E_UPSTREAM_FAILED", lang, {
      request,
      env,
      headers: { ...rateHeaders(rl), "x-request-id": requestId },
      body: { request_id: requestId },
    });
  }
}

async function handleDownload(request, env, lang, requestId, bucket, limitOverride) {
  const url = new URL(request.url);
  let parsed;
  try {
    parsed = parseInstagramUrl(url.searchParams.get("url"));
  } catch (e) {
    return jsonError(e.code || "E_INVALID_URL", lang, {
      request,
      env,
      body: { request_id: requestId },
    });
  }

  const quality = url.searchParams.get("quality") || "best";
  const index = parseIndex(url.searchParams.get("index"));
  if (index === null) {
    return jsonError("E_BAD_INDEX", lang, { request, env, body: { request_id: requestId } });
  }
  const isHead = request.method === "HEAD";
  const wantsInline = url.searchParams.get("inline") === "1";

  const limit = limitOverride || rateLimits(env).download;
  // A HEAD request advertises the headers without consuming the quota.
  const rl = isHead
    ? { allowed: true, limit, remaining: limit, reset: Math.floor(Date.now() / 1000) + 60, retryAfter: 0 }
    : await checkRateLimit(env, "download", bucket, limit);
  if (!rl.allowed) return rateLimited(request, env, lang, requestId, rl);

  let result;
  try {
    const r = await metaForResolve(parsed, env);
    result = r.data;
  } catch (err) {
    return jsonError(err.code || "E_UPSTREAM_FAILED", lang, {
      request,
      env,
      body: { request_id: requestId },
    });
  }

  const picked = resolveVariant(result, quality, index);
  if (picked.error) {
    return jsonError(picked.error, lang, { request, env, body: { request_id: requestId } });
  }
  const { variant, index: idx } = picked;

  if (exceedsMaxSize(variant.size, env)) {
    return jsonError("E_TOO_LARGE", lang, { request, env, body: { request_id: requestId } });
  }

  try {
    const ext = extensionForMime(variant.mime);
    const filename =
      variant.filename ||
      buildFilename(result.author?.username || "instagram", result.shortcode, idx + 1, ext);
    const res = await streamMedia(variant.url, request, env, {
      contentType: variant.mime,
      contentDisposition: wantsInline ? undefined : contentDisposition(filename),
      inline: wantsInline,
    });
    const h = new Headers(res.headers);
    applyCors(h, request, env);
    for (const [k, v] of Object.entries(rateHeaders(rl))) h.set(k, v);
    h.set("x-request-id", requestId);
    h.set("cache-control", "private, max-age=300");
    return new Response(res.body, { status: res.status, headers: h });
  } catch (err) {
    return jsonError(err.code || "E_UPSTREAM_FAILED", lang, {
      request,
      env,
      headers: rateHeaders(rl),
      body: { request_id: requestId },
    });
  }
}

async function handleThumbnail(request, env, lang, requestId, bucket) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) {
    return jsonError("E_INVALID_URL", lang, { request, env, body: { request_id: requestId } });
  }

  const rl = await checkRateLimit(env, "thumbnail", bucket, rateLimits(env).thumbnail);
  if (!rl.allowed) return rateLimited(request, env, lang, requestId, rl);

  const check = validateProxyUrl(target, env);
  if (!check.ok) {
    return jsonError(check.code, lang, {
      request,
      env,
      headers: rateHeaders(rl),
      body: { request_id: requestId },
    });
  }

  try {
    const res = await streamMedia(target, request, env, { requireImage: true });
    const h = new Headers(res.headers);
    applyCors(h, request, env);
    // Signed CDN URLs expire: never mark a thumbnail immutable.
    h.set("cache-control", "private, max-age=300");
    h.set("x-request-id", requestId);
    for (const [k, v] of Object.entries(rateHeaders(rl))) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  } catch (err) {
    return jsonError(err.code || "E_UPSTREAM_FAILED", lang, {
      request,
      env,
      headers: rateHeaders(rl),
      body: { request_id: requestId },
    });
  }
}

async function handleHealth(request, env, lang, requestId) {
  const url = new URL(request.url);
  const deep = url.searchParams.get("deep") === "1";
  const bucket = await clientKey(request, env);

  let rl = null;
  if (deep) {
    rl = await checkRateLimit(env, "health", bucket, rateLimits(env).health);
    if (!rl.allowed) return rateLimited(request, env, lang, requestId, rl);
  }

  const health = providerHealthSnapshot();
  const providers = parseUpstreams(env).map((u) => {
    const name = providerName(u);
    return { provider: name, breaker_open: Boolean(health[name] && health[name].breaker_open) };
  });

  let live = null;
  if (deep) {
    try {
      live = await checkProviderHealth(env);
    } catch {
      live = [];
    }
  }
  const degraded = Boolean(deep && live && live.length > 0 && live.every((p) => !p.reachable));

  return jsonOk(
    {
      status: degraded ? "degraded" : "ok",
      version: VERSION,
      time: new Date().toISOString(),
      storage: { kv: Boolean(env && env.KV) },
      auth_required: parseApiKeys(env).length > 0,
      limits: rateLimits(env),
      max_download_mb: Math.round(maxBytes(env) / (1024 * 1024)),
      providers,
      ...(live ? { provider_live: live } : {}),
    },
    lang,
    {
      request,
      env,
      headers: jsonHeaders(request, env, requestId, {
        "cache-control": "no-store",
        ...(rl ? rateHeaders(rl) : {}),
      }),
    },
  );
}

function openApiDocument() {
  const errorResponse = { description: "Structured JSON error (`error.code` is stable)." };
  return {
    openapi: "3.0.3",
    info: {
      title: "insta-worker API",
      version: VERSION,
      description:
        "Resolve public Instagram post/reel/IGTV metadata and stream the media. Public content only. " +
        "When the API_KEYS secret is set, /api/v1 requests require `Authorization: Bearer <key>` " +
        "or `x-api-key: <key>`; otherwise the API is public and rate limited per IP.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        apiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            ok: { type: "boolean", example: false },
            status: { type: "integer", example: 404 },
            lang: { type: "string", enum: ["en", "fa"] },
            request_id: { type: "string" },
            error: {
              type: "object",
              properties: { code: { type: "string" }, message: { type: "string" } },
            },
          },
        },
      },
    },
    paths: {
      "/": {
        get: {
          summary: "Web UI or JSON service summary (content-negotiated)",
          parameters: [
            { name: "lang", in: "query", schema: { type: "string", enum: ["en", "fa"] }, description: "UI language; defaults to Persian for HTML." },
          ],
          responses: { 200: { description: "HTML for text/html clients, JSON summary otherwise." } },
        },
      },
      "/api/v1/resolve": {
        get: {
          summary: "Resolve metadata and variants",
          security: [{}, { bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            { name: "url", in: "query", required: true, schema: { type: "string" } },
            { name: "lang", in: "query", schema: { type: "string", enum: ["en", "fa"] } },
          ],
          responses: {
            200: { description: "Normalised metadata and variants." },
            304: { description: "Not modified (strong ETag)." },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse,
            429: errorResponse,
            502: errorResponse,
            504: errorResponse,
          },
        },
      },
      "/api/v1/download": {
        get: {
          summary: "Stream a media variant",
          security: [{}, { bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            { name: "url", in: "query", required: true, schema: { type: "string" } },
            { name: "quality", in: "query", schema: { type: "string" }, description: "Variant label; default best." },
            { name: "index", in: "query", schema: { type: "integer", minimum: 0 } },
            { name: "inline", in: "query", schema: { type: "string", enum: ["1"] } },
            { name: "lang", in: "query", schema: { type: "string", enum: ["en", "fa"] } },
          ],
          responses: {
            200: { description: "Binary media stream." },
            206: { description: "Partial content (Range)." },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse,
            413: errorResponse,
            429: errorResponse,
            502: errorResponse,
            504: errorResponse,
          },
        },
      },
      "/api/v1/thumbnail": {
        get: {
          summary: "Proxy a thumbnail image",
          security: [{}, { bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            { name: "url", in: "query", required: true, schema: { type: "string" } },
            { name: "lang", in: "query", schema: { type: "string", enum: ["en", "fa"] } },
          ],
          responses: {
            200: { description: "Image stream." },
            400: errorResponse,
            401: errorResponse,
            415: errorResponse,
            429: errorResponse,
            502: errorResponse,
          },
        },
      },
      "/health": {
        get: {
          summary: "Health",
          parameters: [{ name: "deep", in: "query", schema: { type: "string", enum: ["1"] } }],
          responses: { 200: { description: "Service, storage, limits and provider state." } },
        },
      },
      "/openapi.json": { get: { summary: "This document", responses: { 200: { description: "OpenAPI 3 JSON." } } } },
    },
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const requestId = newRequestId();
    const lang = langFromRequest(request);
    const method = String(request.method || "GET").toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: baseHeaders(request, env, { "cache-control": "no-store" }),
      });
    }

    let path;
    try {
      path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    } catch {
      return jsonError("E_INVALID_URL", lang, { request, env, body: { request_id: requestId } });
    }

    const isGetLike = method === "GET" || method === "HEAD";
    const methodError = () =>
      jsonError("E_METHOD", lang, {
        request,
        env,
        headers: { allow: "GET, HEAD, OPTIONS", "x-request-id": requestId },
        body: { request_id: requestId },
      });

    try {
      if (path === "/") {
        if (!isGetLike) return methodError();
        return await handleRoot(request, env, lang, requestId);
      }

      if (path === "/health") {
        if (!isGetLike) return methodError();
        return await handleHealth(request, env, lang, requestId);
      }

      if (path === "/openapi.json") {
        if (!isGetLike) return methodError();
        return jsonResponse(
          withRequestId({ ok: true, status: 200, lang, data: openApiDocument() }, requestId),
          200,
          lang,
          {
            request,
            env,
            headers: { "cache-control": "public, max-age=3600", "x-request-id": requestId },
          },
        );
      }

      if (path === "/api/v1/resolve" || path === "/api/v1/download" || path === "/api/v1/thumbnail") {
        if (!isGetLike) return methodError();

        const auth = await authenticate(request, env);
        if (!auth.ok) {
          return jsonError("E_UNAUTHORIZED", lang, {
            request,
            env,
            body: { request_id: requestId },
          });
        }

        if (path === "/api/v1/resolve") {
          return await handleResolve(request, env, lang, requestId, auth.bucket, null);
        }
        if (path === "/api/v1/download") {
          return await handleDownload(request, env, lang, requestId, auth.bucket, null);
        }
        return await handleThumbnail(request, env, lang, requestId, auth.bucket);
      }

      if (path === "/api/v1" || path.startsWith("/api/")) {
        if (!isGetLike) return methodError();
        return jsonError("E_NOT_FOUND", lang, { request, env, body: { request_id: requestId } });
      }

      return jsonError("E_NOT_FOUND", lang, { request, env, body: { request_id: requestId } });
    } catch (err) {
      // Never leak stack traces.
      console.error("[worker] unhandled error:", err && err.message);
      return jsonError("E_INTERNAL", lang, { request, env, body: { request_id: requestId } });
    }
  },
};
