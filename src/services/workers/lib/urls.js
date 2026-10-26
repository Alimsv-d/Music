// Strict Instagram URL parsing / validation.
//
// Accepted: https only, host in {instagram.com, www.instagram.com,
// m.instagram.com, instagr.am}, path EXACTLY two segments
// (<kind>/<shortcode>) where kind is one of {p, reel, reels, tv}.
// No credentials, no port other than 443 (or an explicit :443), tracking
// parameters are stripped from the parsed URL and the canonical form is
// rebuilt from scratch, and the shortcode must look like a real Instagram
// shortcode (4..32 base64url characters).
//
// Anything else throws UrlError("E_INVALID_URL").

export const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
  "instagr.am",
]);

export const CONTENT_KINDS = new Set(["p", "reel", "reels", "tv"]);

/**
 * Path segments that never denote a media object. `/reels/audio`,
 * `/stories/xyz`, `/direct/inbox` ... are all rejected explicitly so that a
 * non-media path can never be mistaken for a shortcode.
 */
export const NON_MEDIA_SEGMENTS = new Set([
  "audio",
  "p",
  "reel",
  "reels",
  "tv",
  "explore",
  "stories",
  "highlights",
  "direct",
  "accounts",
  "about",
  "developer",
  "legal",
  "login",
  "signup",
  "challenge",
  "live",
  "shopping",
]);

// Instagram shortcodes are short base64url-ish identifiers. 4..32 characters
// is deliberately tighter than "any string" so that words like "audio" or
// "explore" can never pass as a shortcode.
const SHORTCODE_RE = /^[A-Za-z0-9_-]{4,32}$/;

const TRACKING_PARAMS = [
  "igsh",
  "igshid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "yclid",
  "igshid",
  "s",
];

export class UrlError extends Error {
  constructor(code = "E_INVALID_URL") {
    super(code);
    this.code = code;
    this.name = "UrlError";
  }
}

/**
 * Remove tracking parameters from a URL object (mutates and returns it).
 * @param {URL} url
 * @returns {URL}
 */
export function stripTrackingParams(url) {
  for (const p of TRACKING_PARAMS) {
    url.searchParams.delete(p);
  }
  // "s" is only tracking when it looks like a share source (e.g. "s=src"),
  // never when it is a real parameter of the media path.
  const s = url.searchParams.get("s");
  if (s && /^(src|igsh|web|other)$/i.test(s)) url.searchParams.delete("s");
  url.hash = "";
  return url;
}

/**
 * @param {string} input raw user input
 * @returns {{ok:true, kind:string, shortcode:string, canonical:string, url:URL}}
 *        or throws UrlError
 */
export function parseInstagramUrl(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new UrlError("E_INVALID_URL");
  }
  let raw = input.trim();

  // Be forgiving: accept bare "instagram.com/p/xxx" without scheme.
  if (!/^https?:\/\//i.test(raw)) {
    raw = "https://" + raw.replace(/^\/+/, "");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlError("E_INVALID_URL");
  }

  if (url.protocol !== "https:") throw new UrlError("E_INVALID_URL");
  // Only the default HTTPS port is acceptable ("" and "443" are the same).
  if (url.port && url.port !== "443") throw new UrlError("E_INVALID_URL");
  if (url.username || url.password) throw new UrlError("E_INVALID_URL");

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!INSTAGRAM_HOSTS.has(host)) throw new UrlError("E_INVALID_URL");

  const segments = url.pathname.split("/").filter(Boolean);
  // Exactly two segments: <kind>/<shortcode>. Anything longer is a nested
  // route (e.g. /p/ABC/comments) and must not be silently accepted.
  if (segments.length !== 2) throw new UrlError("E_INVALID_URL");

  const kind = segments[0].toLowerCase();
  if (!CONTENT_KINDS.has(kind)) throw new UrlError("E_INVALID_URL");

  const shortcode = segments[1];
  if (NON_MEDIA_SEGMENTS.has(shortcode.toLowerCase())) throw new UrlError("E_INVALID_URL");
  if (!SHORTCODE_RE.test(shortcode)) throw new UrlError("E_INVALID_URL");

  // Normalise reels -> reel for a compact canonical representation.
  const canonicalKind = kind === "reels" ? "reel" : kind;
  const canonical = `https://www.instagram.com/${canonicalKind}/${shortcode}/`;

  // The returned URL is the sanitised one (no tracking parameters).
  const clean = stripTrackingParams(url);

  return { ok: true, kind: canonicalKind, shortcode, canonical, url: clean };
}

export function sanitizeFilenamePart(value, fallback = "instagram") {
  const cleaned = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(0, 60);
  return cleaned || fallback;
}

export function buildFilename(author, shortcode, index, ext) {
  const a = sanitizeFilenamePart(author, "instagram");
  const c = sanitizeFilenamePart(shortcode, "media");
  const suffix = Number.isFinite(index) && index > 0 ? `_${index}` : "";
  const e = sanitizeFilenamePart(ext, "bin").toLowerCase().replace(/^\./, "");
  return `${a}_${c}${suffix}.${e}`;
}
