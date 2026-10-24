// Normalized internal Track shape + helpers. Every service adapter maps its
// upstream response into this single shape:
//   {id, key, source, title, artist, artistId, album, year, duration_ms,
//    artwork, pageUrl, streamUrl, downloadUrl, downloadable}

/** Build a stable cache/file_id key for a track. */
export function trackKey(source, id) {
  return `${source}:${id}`;
}

/** Normalize milliseconds duration to seconds int. */
export function durSec(ms) {
  return ms ? Math.round(ms / 1000) : 0;
}

/** Extract a 4-digit year from an ISO-ish date string. */
export function toYear(dateStr) {
  const m = String(dateStr ?? "").match(/(\d{4})/);
  return m ? m[1] : "";
}

/** Sanitize a string for use in a filename. */
export function safeFilename(s) {
  return String(s ?? "track")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "track";
}
