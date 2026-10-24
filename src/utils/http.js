// Resilient HTTP helpers: timeout, retry with exponential backoff + jitter,
// JSON parsing, and edge-cache backed GETs. All service adapters use these so
// a flaky upstream never crashes the bot.

export class HttpError extends Error {
  constructor(message, { status = 0, code = "HTTP", url = "" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with a hard timeout and retry/backoff on network errors + 5xx/429.
 * opts: { timeout, retries, backoff, headers, method, body }
 */
export async function http(url, opts = {}) {
  const {
    timeout = 10000,
    retries = 2,
    backoff = 400,
    headers = {},
    method = "GET",
    body,
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: ctrl.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      // Retry on 429 & 5xx, honoring Retry-After when present.
      if (res.status === 429 || res.status >= 500) {
        const ra = parseInt(res.headers.get("retry-after") || "0", 10);
        lastErr = new HttpError(`HTTP ${res.status}`, { status: res.status, url });
        if (attempt < retries) {
          await sleep(Math.max(ra * 1000, backoff * 2 ** attempt + Math.random() * 200));
          continue;
        }
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === "AbortError"
        ? new HttpError("timeout", { code: "TIMEOUT", url })
        : new HttpError(e.message || "network", { code: "NETWORK", url });
      if (attempt < retries) {
        await sleep(backoff * 2 ** attempt + Math.random() * 200);
        continue;
      }
    }
  }
  throw lastErr;
}

/** GET JSON with retry; throws HttpError on non-2xx or bad JSON. */
export async function httpJson(url, opts = {}) {
  const res = await http(url, opts);
  if (!res.ok) {
    throw new HttpError(`HTTP ${res.status}`, { status: res.status, url });
  }
  try {
    return await res.json();
  } catch {
    throw new HttpError("invalid json", { code: "BAD_JSON", url });
  }
}

/**
 * Edge-cache a GET JSON response. `cacheKey` must be a stable absolute URL or
 * a synthesized key; we wrap it in a Request for caches.default.
 * ttlSec is enforced via a stored timestamp (caches.default ignores
 * expirationTtl), so we treat stale entries as misses.
 */
export async function cachedJson(url, { ttlSec = 300, cacheKey, ...opts } = {}) {
  const cache = caches.default;
  const key = new Request(cacheKey || url, { method: "GET" });
  try {
    const hit = await cache.match(key);
    if (hit) {
      const ts = parseInt(hit.headers.get("x-cache-ts") || "0", 10);
      if (ts && Date.now() - ts < ttlSec * 1000) return hit.json();
    }
  } catch { /* cache unavailable */ }

  const data = await httpJson(url, opts);
  try {
    const res = new Response(JSON.stringify(data), {
      headers: {
        "content-type": "application/json",
        "x-cache-ts": String(Date.now()),
        "cache-control": `public, max-age=${ttlSec}`,
      },
    });
    await cache.put(key, res);
  } catch { /* non-fatal */ }
  return data;
}
