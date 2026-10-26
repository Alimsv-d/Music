// Standard JSON envelope, stable error codes, configurable CORS and cache
// headers.
//
// Rules enforced here:
//   * every JSON error carries `request_id`, `lang` and a stable `error.code`;
//   * resolve/error responses are `private, no-store` so a shared cache can
//     never replay a rate-limited or signed response;
//   * CORS is controlled by ALLOWED_ORIGINS (default `*`); when an explicit
//     list is configured only a matching Origin is echoed back;
//   * `X-Content-Type-Options: nosniff` is always present.

import { t } from "./i18n.js";

export const ERROR_STATUS = {
  E_INVALID_URL: 400,
  E_INVALID_REQUEST: 400,
  E_BAD_QUALITY: 400,
  E_BAD_INDEX: 400,
  E_NOT_ALLOWED_HOST: 400,
  E_NOT_ALLOWED_TYPE: 415,
  E_METHOD: 405,
  E_UNAUTHORIZED: 401,
  E_NOT_FOUND: 404,
  E_NO_VARIANTS: 404,
  E_PRIVATE_OR_NOT_FOUND: 404,
  E_RATE_LIMIT: 429,
  E_TOO_LARGE: 413,
  E_UPSTREAM_FAILED: 502,
  E_UPSTREAM_UNAVAILABLE: 502,
  E_UPSTREAM_TIMEOUT: 504,
  E_INTERNAL: 500,
};

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

/**
 * `ALLOWED_ORIGINS` is either `*` (default) or a comma-separated list of
 * origins. Returns `"*"` or an array of normalised origins.
 */
export function parseAllowedOrigins(env) {
  const raw = env && env.ALLOWED_ORIGINS;
  const value = typeof raw === "string" && raw.trim() ? raw.trim() : "*";
  if (value === "*") return "*";
  const list = value
    .split(",")
    .map((s) => stripTrailingSlash(s.trim()))
    .filter(Boolean);
  return list.length ? list : "*";
}

export function corsHeaders(request, env) {
  const allowed = parseAllowedOrigins(env);
  const origin = request ? request.headers.get("origin") : null;
  const headers = {
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, X-API-Key, X-Requested-With, Range, If-None-Match",
    "access-control-max-age": "86400",
    "access-control-expose-headers":
      "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After, ETag, X-Request-Id, Content-Disposition, Content-Range, Accept-Ranges",
  };
  if (allowed === "*") {
    headers["access-control-allow-origin"] = "*";
  } else {
    headers.vary = "Origin";
    if (origin && allowed.includes(stripTrailingSlash(origin))) {
      headers["access-control-allow-origin"] = origin;
    }
  }
  return headers;
}

export function baseHeaders(request, env, extra = {}) {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
    ...corsHeaders(request, env),
    ...extra,
  };
}

/** Add CORS (and the shared security headers) to a streamed/binary response. */
export function applyCors(headers, request, env) {
  for (const [key, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(key, value);
  }
  return headers;
}

export function jsonError(code, lang, options = {}) {
  const { headers = {}, body = {}, request, env } = options || {};
  const status = ERROR_STATUS[code] || 500;
  const headersOut = { ...headers };
  if (!headersOut["x-request-id"] && body && body.request_id) {
    headersOut["x-request-id"] = body.request_id;
  }
  if (status === 401 && !headersOut["www-authenticate"]) {
    headersOut["www-authenticate"] = 'Bearer realm="insta-worker"';
  }
  if (status === 405 && !headersOut.allow) {
    headersOut.allow = "GET, HEAD, OPTIONS";
  }
  return jsonResponse(
    {
      ...body,
      ok: false,
      status,
      lang,
      error: { code, message: t(lang, code) },
    },
    status,
    lang,
    { request, env, headers: headersOut },
  );
}

export function jsonOk(data, lang, options = {}) {
  const { headers = {}, body = {}, request, env } = options || {};
  return jsonResponse({ ...body, ok: true, status: 200, lang, data }, 200, lang, { request, env, headers });
}

export function jsonResponse(body, status, lang, options = {}) {
  const { request, env, headers = {} } = options || {};
  const merged = { ...headers };
  const h = new Headers(baseHeaders(request, env, merged));
  h.set("content-type", "application/json; charset=utf-8");
  if (!h.has("cache-control")) h.set("cache-control", "private, no-store");
  const isHead = request && String(request.method || "").toUpperCase() === "HEAD";
  return new Response(isHead ? null : JSON.stringify(body), { status, headers: h });
}

export function newRequestId() {
  try {
    return crypto.randomUUID();
  } catch {
    return "req_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

export function withRequestId(body, requestId) {
  return { ...body, request_id: requestId };
}
