// Provider layer: ordered list of upstreams with a timeout that covers the
// whole call (headers *and* body), retry/backoff with jitter, a per-provider
// circuit breaker with a single half-open probe, and health tracking.
//
// Rules enforced here:
//   * the timeout covers the body read as well (AbortSignal.timeout);
//   * numeric env vars are validated (finite and > 0) before use;
//   * the breaker is keyed by the FULL upstream URL, not only its host;
//   * the breaker allows exactly ONE probe while half-open;
//   * a health check never mutates breaker/health state;
//   * UPSTREAM_TOKEN is only ever sent to the upstream it belongs to and
//     redirects are followed manually, never automatically;
//   * a network error is NOT "content not found";
//   * a non-object JSON body is rejected.

import { normalizeUpstream } from "./normalize.js";

const DEFAULT_UPSTREAM = "https://catplus.ir/api/insta";
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_ATTEMPTS = 2;
const MAX_REDIRECT_HOPS = 2;

const STATE = {
  // full upstream URL -> { failures, openedAt, probing }
  breaker: new Map(),
  // full upstream URL -> { ok, at }
  health: new Map(),
};

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;

export function parseUpstreams(env) {
  const raw = (env && env.UPSTREAM_URLS) || DEFAULT_UPSTREAM;
  const list = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const usable = list.filter((s) => {
    try {
      return new URL(s).protocol === "https:";
    } catch {
      return false;
    }
  });
  return usable.length ? usable : [DEFAULT_UPSTREAM];
}

export function providerName(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** The breaker is keyed by the complete upstream URL. */
export function breakerKey(url) {
  return String(url || "");
}

function breakerFor(key) {
  let b = STATE.breaker.get(key);
  if (!b) {
    b = { failures: 0, openedAt: 0, probing: false };
    STATE.breaker.set(key, b);
  }
  return b;
}

/**
 * Pure state inspection: true while the breaker is open (and the cooldown has
 * not elapsed). Never mutates the breaker — a health snapshot must not change
 * the circuit state.
 */
export function breakerOpen(key) {
  const b = breakerFor(key);
  if (b.failures < BREAKER_THRESHOLD) return false;
  if (Date.now() - b.openedAt > BREAKER_COOLDOWN_MS) return false; // half-open
  return true;
}

/**
 * Decide whether a request may be sent to this upstream. When the breaker is
 * half-open exactly ONE probe is allowed; concurrent callers are rejected
 * until that probe settles.
 */
export function allowProvider(key) {
  const b = breakerFor(key);
  if (b.failures < BREAKER_THRESHOLD) return true;
  if (Date.now() - b.openedAt > BREAKER_COOLDOWN_MS) {
    if (b.probing) return false;
    b.probing = true;
    return true;
  }
  return false;
}

export function recordSuccess(key) {
  const b = breakerFor(key);
  b.failures = 0;
  b.openedAt = 0;
  b.probing = false;
  STATE.health.set(key, { ok: true, at: Date.now() });
}

export function recordFailure(key) {
  const b = breakerFor(key);
  b.failures += 1;
  b.probing = false;
  if (b.failures >= BREAKER_THRESHOLD) b.openedAt = Date.now();
  STATE.health.set(key, { ok: false, at: Date.now() });
}

export function providerHealthSnapshot() {
  const out = {};
  for (const [key, h] of STATE.health.entries()) {
    out[providerName(key)] = { ...h, breaker_open: breakerOpen(key), provider: providerName(key) };
  }
  return out;
}

export function resetProviderState() {
  STATE.breaker.clear();
  STATE.health.clear();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildUrl(base, target) {
  const u = new URL(base);
  u.searchParams.set("url", target);
  return u.toString();
}

/** Read a numeric env var: finite and > 0, otherwise the safe default. */
export function numericEnv(env, name, fallback) {
  const raw = env ? env[name] : undefined;
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * The upstream bearer token is only sent to the upstream it belongs to:
 * either the host configured in UPSTREAM_TOKEN_HOST, or — when no host is
 * configured — the single configured upstream. With several upstreams and no
 * explicit host the token is withheld so it can never leak to a third party.
 */
export function tokenForProvider(base, env, providerCount) {
  const token = env && env.UPSTREAM_TOKEN;
  if (!token || typeof token !== "string") return null;
  const host = providerName(base);
  const allowed = env && env.UPSTREAM_TOKEN_HOST ? String(env.UPSTREAM_TOKEN_HOST).toLowerCase().replace(/\.$/, "") : null;
  if (allowed) return host === allowed ? token : null;
  return providerCount === 1 ? token : null;
}

function upstreamError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

/** A timeout is a distinct failure class, never "content not found". */
function isTimeout(err) {
  return Boolean(
    err &&
      (err.code === "E_UPSTREAM_TIMEOUT" ||
        err.name === "TimeoutError" ||
        err.name === "AbortError"),
  );
}

/**
 * Fetch with manual redirect handling: redirects are never followed
 * automatically and only same-origin hops are allowed (max 2).
 */
async function fetchManual(url, init, fetchImpl) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const res = await fetchImpl(current, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    let next;
    try {
      next = new URL(location, current).toString();
    } catch {
      return res;
    }
    try {
      const from = new URL(current);
      const to = new URL(next);
      if (from.origin !== to.origin) return res;
    } catch {
      return res;
    }
    current = next;
  }
  throw upstreamError("E_UPSTREAM_FAILED", "too_many_redirects");
}

/**
 * Call one provider with retry/backoff (jittered). Returns the parsed JSON or
 * throws an error carrying a stable `code`.
 */
export async function callProvider(base, target, { fetchImpl, timeoutMs, token, attempts = DEFAULT_ATTEMPTS }) {
  const url = buildUrl(base, target);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const headers = {
        accept: "application/json",
        "user-agent": "insta-worker/1.0 (+https://github.com/Alimsv-d/insta-worker)",
      };
      if (token) headers.authorization = `Bearer ${token}`;

      // The signal covers the body read as well, not only the headers.
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetchManual(url, { headers, signal }, fetchImpl);

      if (res.status === 404 || res.status === 410) {
        throw upstreamError("E_PRIVATE_OR_NOT_FOUND", "not_found");
      }
      if (!res.ok) {
        // 3xx that we did not follow, 4xx/5xx: an upstream problem, never
        // "content not found".
        throw upstreamError("E_UPSTREAM_FAILED", `upstream_status_${res.status}`);
      }

      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw upstreamError("E_UPSTREAM_FAILED", "upstream_bad_json");
      }
      if (!json || typeof json !== "object" || Array.isArray(json)) {
        throw upstreamError("E_UPSTREAM_FAILED", "upstream_bad_shape");
      }
      return json;
    } catch (err) {
      const timeout = isTimeout(err);
      lastErr = timeout
        ? upstreamError("E_UPSTREAM_TIMEOUT", (err && err.message) || "upstream_timeout")
        : err;
      if (lastErr && lastErr.code === "E_PRIVATE_OR_NOT_FOUND") break; // no point retrying
      if (i < attempts - 1) {
        // Exponential backoff with jitter.
        const backoff = 200 * Math.pow(2, i) * (0.5 + Math.random());
        await sleep(backoff);
      }
    }
  }
  const finalCode = lastErr && lastErr.code ? lastErr.code : "E_UPSTREAM_FAILED";
  throw upstreamError(finalCode, (lastErr && lastErr.message) || "upstream_failed");
}

/**
 * Resolve content by trying providers in order. Returns the normalised result
 * (which carries `provider`) or throws.
 * @param {{kind:string,shortcode:string,canonical:string}} ctx
 */
export async function resolveContent(ctx, env, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const providers = options.providers || parseUpstreams(env);
  const rawTimeout = options.timeoutMs !== undefined ? options.timeoutMs : env && env.UPSTREAM_TIMEOUT_MS;
  const timeoutMs = numericEnv({ UPSTREAM_TIMEOUT_MS: rawTimeout }, "UPSTREAM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const attempts = options.attempts || DEFAULT_ATTEMPTS;

  let sawNotFound = false;
  let sawTimeout = false;
  let sawAnyFailure = false;
  let skipped = 0;

  for (const base of providers) {
    const key = breakerKey(base);
    const name = providerName(base);
    if (!allowProvider(key)) {
      skipped++;
      continue;
    }
    const token = tokenForProvider(base, env, providers.length);
    try {
      const payload = await callProvider(base, ctx.canonical, { fetchImpl, timeoutMs, token, attempts });
      const normalized = normalizeUpstream(payload, ctx, name);
      if (normalized) {
        recordSuccess(key);
        return normalized;
      }
      // Upstream answered but with no usable media.
      sawNotFound = true;
      recordSuccess(key);
    } catch (err) {
      if (err && err.code === "E_PRIVATE_OR_NOT_FOUND") {
        sawNotFound = true;
        recordSuccess(key);
        continue;
      }
      // A network/timeout failure is NOT "not found".
      if (isTimeout(err)) sawTimeout = true;
      else sawAnyFailure = true;
      recordFailure(key);
    }
  }

  if (sawAnyFailure) throw upstreamError("E_UPSTREAM_FAILED", "upstream_failed");
  if (sawTimeout) throw upstreamError("E_UPSTREAM_TIMEOUT", "upstream_timeout");
  if (sawNotFound) throw upstreamError("E_PRIVATE_OR_NOT_FOUND", "private_or_not_found");
  if (skipped > 0) throw upstreamError("E_UPSTREAM_UNAVAILABLE", "breaker_open");
  throw upstreamError("E_UPSTREAM_UNAVAILABLE", "no_provider");
}

/**
 * Reachability probe. It never records success/failure: a health check must
 * not change the circuit breaker state.
 */
export async function checkProviderHealth(env, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const providers = options.providers || parseUpstreams(env);
  const baseTimeout = numericEnv(env, "UPSTREAM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const rawTimeout = options.timeoutMs !== undefined ? options.timeoutMs : baseTimeout;
  const timeoutMs = Math.min(5000, numericEnv({ UPSTREAM_TIMEOUT_MS: rawTimeout }, "UPSTREAM_TIMEOUT_MS", baseTimeout));
  const results = [];
  for (const base of providers) {
    const name = providerName(base);
    const started = Date.now();
    try {
      // A well-known public reel; providers usually respond fast.
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetchManual(
        buildUrl(base, "https://www.instagram.com/reel/DEADBEEF/"),
        { method: "GET", signal },
        fetchImpl,
      );
      // A health probe never consumes the body.
      if (res.body) {
        try {
          await res.body.cancel();
        } catch {
          /* ignore */
        }
      }
      results.push({ provider: name, reachable: true, status: res.status, latency_ms: Date.now() - started });
    } catch (e) {
      const timeout = isTimeout(e);
      results.push({
        provider: name,
        reachable: false,
        error: timeout ? "timeout" : String((e && e.message) || e),
        latency_ms: Date.now() - started,
      });
    }
  }
  return results;
}
