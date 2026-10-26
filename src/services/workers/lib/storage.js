// KV storage: rate limiting and a short-lived metadata cache.
//
// This service intentionally has **no D1 database**. KV is optional too: when
// the binding is missing every helper degrades gracefully (requests still work,
// only the cache and the rate limiter are skipped).
//
// Privacy / robustness rules:
//   * the raw IP is NEVER stored. Only an HMAC-SHA256 bucket key is written to
//     KV. IP_HASH_SECRET is optional; a built-in public default is used when it
//     is not configured;
//   * an unknown IP never shares a bucket with other clients;
//   * the cache TTL has a hard minimum of 60 seconds (signed media URLs expire;
//     a shorter TTL only wastes upstream quota);
//   * the rate limiter is a fixed window and is APPROXIMATE: KV `get` + `put`
//     are not atomic, so a burst can exceed the limit by a few requests. It
//     stops casual abuse; it is NOT a hard quota.

// ---------------------------------------------------------------------------
// Hashing (never store raw IPs or raw API keys)
// ---------------------------------------------------------------------------

/**
 * Fallback secret used when IP_HASH_SECRET is not configured. It is public, so
 * set a private secret in production if you do not want IP hashes to be
 * comparable across deployments. It is not a credential.
 */
export const DEFAULT_IP_HASH_SECRET = "insta-worker-default-ip-hash-secret";

export function ipHashSecret(env) {
  const s = env ? env.IP_HASH_SECRET : undefined;
  return typeof s === "string" && s.length >= 16 ? s : DEFAULT_IP_HASH_SECRET;
}

export async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(message)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The per-client rate-limit bucket key.
 *
 * The IP is HMAC-hashed (keyed, so a leaked KV entry cannot be brute-forced).
 * When no IP header is available we derive a coarse key from the client
 * headers; if even those are absent we generate a random key, so anonymous
 * clients are never placed in one shared bucket.
 */
export async function clientKey(request, env) {
  const secret = ipHashSecret(env);
  const ip =
    request.headers.get("cf-connecting-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    request.headers.get("x-real-ip") ||
    "";
  if (ip) return "ip:" + (await hmacHex(secret, "ip:" + ip));

  const coarse = [
    request.headers.get("user-agent") || "",
    request.headers.get("accept-language") || "",
    request.headers.get("cf-ray") || "",
  ].join("|");
  if (coarse.replace(/\|/g, "")) {
    return "anon:" + (await hmacHex(secret, "coarse:" + coarse));
  }
  // No identifying input at all: never share a bucket with other clients.
  let random;
  try {
    random = crypto.randomUUID();
  } catch {
    random = Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  return "anon:" + (await hmacHex(secret, "random:" + random));
}

/** A stable bucket key for an authenticated API key (raw key is not stored). */
export async function apiKeyBucket(env, key) {
  return "key:" + (await hmacHex(ipHashSecret(env), "apikey:" + key));
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window per minute — APPROXIMATE)
// ---------------------------------------------------------------------------

export const COUNTERS = {
  kvErrors: 0,
};

function numEnv(env, name, fallback) {
  const raw = env ? env[name] : undefined;
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/** Configured limits per bucket. Invalid values fall back to the defaults. */
export function rateLimits(env) {
  return {
    resolve: numEnv(env, "RATE_LIMIT_PER_MINUTE", 60),
    download: numEnv(env, "RATE_LIMIT_DOWNLOAD_PER_MINUTE", 20),
    thumbnail: numEnv(env, "RATE_LIMIT_THUMBNAIL_PER_MINUTE", 60),
    health: numEnv(env, "RATE_LIMIT_HEALTH_PER_MINUTE", 10),
  };
}

/**
 * Fixed-window rate limiter.
 *
 * NOTE: this is approximate (see the file header). Concurrent requests can
 * exceed the configured limit by a small amount.
 *
 * @returns {{allowed:boolean, limit:number, remaining:number, reset:number, retryAfter:number}}
 */
export async function checkRateLimit(env, bucket, key, limit) {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - (nowSec % 60);
  const reset = windowStart + 60;

  if (!env || !env.KV || !Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, limit: limit || Infinity, remaining: limit || Infinity, reset, retryAfter: 0, degraded: true };
  }

  const kvKey = `rl:${bucket}:${key}:${windowStart}`;
  try {
    const current = Number((await env.KV.get(kvKey)) || 0);
    if (current >= limit) {
      return { allowed: false, limit, remaining: 0, reset, retryAfter: Math.max(1, reset - nowSec) };
    }
    const next = current + 1;
    await env.KV.put(kvKey, String(next), { expirationTtl: 120 });
    return { allowed: true, limit, remaining: Math.max(0, limit - next), reset, retryAfter: 0 };
  } catch (err) {
    // Degrade instead of failing the request, but make the failure visible.
    COUNTERS.kvErrors++;
    console.error(`[storage] rate limit check failed for bucket ${bucket}:`, err && err.message);
    return { allowed: true, limit, remaining: limit, reset, retryAfter: 0, degraded: true };
  }
}

export function rateHeaders(rl) {
  const h = {};
  if (rl && Number.isFinite(rl.limit)) {
    h["x-ratelimit-limit"] = String(rl.limit);
    h["x-ratelimit-remaining"] = String(Math.max(0, rl.remaining));
    h["x-ratelimit-reset"] = String(rl.reset);
  }
  if (rl && !rl.allowed) h["retry-after"] = String(rl.retryAfter || 60);
  return h;
}

// ---------------------------------------------------------------------------
// Short-lived metadata cache (signed URLs expire -> short TTL)
// ---------------------------------------------------------------------------

export const MIN_CACHE_TTL = 60;
export const MAX_CACHE_TTL = 900;

/** Cache TTL in seconds, clamped to [60, 900]; invalid values use 120. */
export function cacheTtl(env) {
  const raw = env ? env.CACHE_TTL_SECONDS : undefined;
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(n) || n <= 0) return 120;
  return Math.min(MAX_CACHE_TTL, Math.max(MIN_CACHE_TTL, Math.floor(n)));
}

export async function cacheGet(env, shortcode) {
  if (!env || !env.KV) return null;
  try {
    const raw = await env.KV.get(`cache:resolve:${shortcode}`, "text");
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    COUNTERS.kvErrors++;
    console.error(`[storage] cache read failed for ${shortcode}:`, err && err.message);
    return null;
  }
}

export async function cacheSet(env, shortcode, value) {
  if (!env || !env.KV) return;
  try {
    await env.KV.put(`cache:resolve:${shortcode}`, JSON.stringify(value), { expirationTtl: cacheTtl(env) });
  } catch (err) {
    COUNTERS.kvErrors++;
    console.error(`[storage] cache write failed for ${shortcode}:`, err && err.message);
  }
}

/**
 * A STRONG ETag: SHA-256 of the serialised payload. Strong validators may be
 * used for range requests and never carry the weak `W/` prefix.
 */
export async function etagFrom(value) {
  const str = JSON.stringify(value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"sha256-${hex}"`;
}
