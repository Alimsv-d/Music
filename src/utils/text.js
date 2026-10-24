// Text utilities: HTML escaping, Persian/Arabic normalization, fuzzy matching,
// digit handling, and message splitting. Pure functions — no env access — so
// they are trivially unit-testable.

/** Escape a string for safe inclusion in Telegram HTML parse_mode messages. */
export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** Convert Persian & Arabic-Indic digits to ASCII. */
export function toAsciiDigits(s) {
  return String(s ?? "").replace(/[۰-۹٠-٩]/g, (d) => {
    const fa = FA_DIGITS.indexOf(d);
    if (fa !== -1) return String(fa);
    const ar = AR_DIGITS.indexOf(d);
    return ar !== -1 ? String(ar) : d;
  });
}

/** Convert ASCII digits to Persian digits for display. */
export function toFaDigits(s) {
  return String(s ?? "").replace(/[0-9]/g, (d) => FA_DIGITS[+d]);
}

/** Localize digits in a string for the given lang. */
export function loc(s, lang) {
  return lang === "fa" ? toFaDigits(s) : String(s);
}

const ARABIC_MAP = {
  "ي": "ی", "ك": "ک", "ى": "ی", "ئ": "ی", "ة": "ه", "ؤ": "و",
  "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ې": "ی", "ە": "ه",
  "‌": " ", // ZWNJ -> space
  "ـ": "", // tatweel
};

/** Strip diacritics/harakat (Arabic & Persian). */
const DIACRITICS = /[ً-ْٰـ]/g;

/** Normalize "Artist - Title" separators and noise words. */
const NOISE_RE = /\b(official|lyrics?|video|audio|music|hd|hq|4k|remix|version|ft|feat|featuring|prod|x|vs|cover|slowed|sped ?up|nightcore|bass boosted|8d|live|acoustic|karaoke|instrumental|ost|teaser|موزیک|آهنگ|رسمی|متن|ویدیو|کاور|ریمیکس|بی کلام|بیکلام|نسخه|زنده)\b/gi;

/**
 * Normalize a query or title for comparison/search:
 * unify Persian/Arabic chars, ASCII digits, lowercase, drop diacritics,
 * normalize punctuation/feat separators, collapse whitespace.
 * `keepNoise=false` also strips common noise words for fuzzy scoring.
 */
export function normalize(input, { keepNoise = false } = {}) {
  let s = toAsciiDigits(String(input ?? "")).toLowerCase();
  s = s.normalize ? s.normalize("NFKC") : s;
  s = s.replace(DIACRITICS, "");
  s = s.replace(/[يىئككةؤأإٱېەـ‌]/g, (ch) => ARABIC_MAP[ch] ?? " ");
  // unify "feat." variants to a single token before noise stripping
  s = s.replace(/\b(feat\.?|ft\.?|featuring)\b/g, " feat ");
  if (!keepNoise) s = s.replace(NOISE_RE, " ");
  s = s.replace(/[‌]/g, " ");
  s = s.replace(/[_\-–—|•·,.'"()\[\]{}!؟?]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Split a raw query into candidate {artist, title} if it looks like "A - B". */
export function splitArtistTitle(raw) {
  const s = String(raw ?? "").trim();
  const m = s.split(/\s*[-–—|:]\s*/);
  if (m.length >= 2 && m[0] && m[1]) {
    return { artist: m[0].trim(), title: m.slice(1).join(" - ").trim() };
  }
  return null;
}

/**
 * Word-level Dice/Jaccard-ish similarity between two normalized strings.
 * Returns 0..1. Good enough for "is this query basically this track?"
 */
export function similarity(aRaw, bRaw) {
  const a = normalize(aRaw), b = normalize(bRaw);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aw = new Set(a.split(" ")), bw = new Set(b.split(" "));
  let inter = 0;
  for (const w of aw) if (bw.has(w)) inter++;
  const dice = (2 * inter) / (aw.size + bw.size);
  // bonus for substring containment (handles "ebi goriz" ⊂ "ebi goriz slowed")
  if (a.includes(b) || b.includes(a)) return Math.min(1, dice + 0.25);
  return dice;
}

/**
 * Score how well a query matches a candidate track.
 * Compares against "artist title", "title artist", and title alone; returns
 * the best 0..1 score. Used to decide deliver-direct vs. list.
 */
export function matchScore(query, track) {
  const title = track?.title || "";
  const artist = track?.artist || "";
  const combos = [
    `${artist} ${title}`,
    `${title} ${artist}`,
    title,
  ];
  let best = 0;
  for (const c of combos) best = Math.max(best, similarity(query, c));
  return best;
}

/** Format milliseconds -> "m:ss". */
export function fmtDuration(ms, lang = "en") {
  if (!ms || !isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return loc(`${m}:${String(r).padStart(2, "0")}`, lang);
}

/** Extract a 4-digit year from an ISO date string. */
export function yearOf(dateStr) {
  const m = String(dateStr ?? "").match(/(\d{4})/);
  return m ? m[1] : "";
}

/**
 * Split long text into <= limit chunks on paragraph/sentence boundaries.
 * Never splits mid-word unless a single paragraph exceeds the limit.
 */
export function splitText(text, limit = 4096) {
  const s = String(text ?? "");
  if (s.length <= limit) return [s];
  const chunks = [];
  let rest = s;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf(". ", limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

/** Short random id for KV search-result handles (callback-safe). */
export function shortId(len = 8) {
  const abc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

/** Clamp an integer into [min,max] with a fallback. */
export function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Detect whether text looks like a lyrics snippet rather than a query. */
export function looksLikeLyrics(text) {
  const words = normalize(text, { keepNoise: true }).split(" ").filter(Boolean);
  return words.length >= 5 && !splitArtistTitle(text);
}

/** Detect an Instagram post/reel URL in text. Returns the matched URL or null. */
export function extractInstagramUrl(text) {
  const m = String(text ?? "").match(
    /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv|stories)\/[A-Za-z0-9_-]+[^\s]*/i
  );
  return m ? m[0] : null;
}

/** Detect a generic http(s) URL in text. */
export function extractUrl(text) {
  const m = String(text ?? "").match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
}

/** Detect a SoundCloud URL. */
export function extractSoundCloudUrl(text) {
  const m = String(text ?? "").match(/https?:\/\/(?:www\.)?soundcloud\.com\/[^\s]+/i);
  return m ? m[0] : null;
}
