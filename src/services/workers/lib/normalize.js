// Response normalisation: turn heterogeneous upstream payloads into a single
// stable shape:
//
//   {type, author:{username,full_name,avatar}, caption, thumbnail,
//    items:[{type, index, thumbnail, variants:[{url,quality,width,height,
//       bitrate,size,mime,filename,has_audio}]}], source_url, shortcode, provider}
//
// The legacy upstream (catplus.ir) returns:
//   { video: [{ video, thumbnail, ... }], image: [url, ...], ... }
// We also defensively accept a few common alternative shapes.
//
// Invariants enforced here:
//   * a variant URL must be an absolute https URL (no http, no credentials);
//   * several qualities of ONE clip are grouped into one item (variants),
//     while distinct media objects stay separate items (album order kept);
//   * the MIME type and the file extension are derived from the SAME source
//     (an image never ends up as .mp4);
//   * `has_audio` is null when the upstream does not say (never a guess);
//   * caption / username / avatar / quality are sanitised.

import { buildFilename, stripTrackingParams } from "./urls.js";

const VIDEO_EXT_RE = /\.(mp4|mov|webm|m4v)(\?|$)/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|heic|avif|gif)(\?|$)/i;

/** Canonical extension per MIME type — the single source of truth. */
const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/pjpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-m4v": "m4v",
  "video/3gpp": "3gp",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/aac": "aac",
};

/** Reverse lookup used when the upstream only gives us a file extension. */
const EXT_MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  "3gp": "video/3gpp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  aac: "audio/aac",
};

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function pickFirst(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Strip control characters and cap the length of free-form text. */
export function sanitizeText(value, maxLen = 2200) {
  if (value === undefined || value === null) return null;
  const s = String(value)
    .replace(CONTROL_CHARS, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/** Instagram usernames: letters, digits, dots and underscores only. */
export function sanitizeUsername(value) {
  const s = sanitizeText(value, 80);
  if (!s) return null;
  const cleaned = s.replace(/^@+/, "").replace(/[^A-Za-z0-9._]/g, "").slice(0, 40);
  return cleaned || null;
}

/** Quality labels are user-visible: keep them short and printable. */
export function sanitizeQuality(value, fallback = "default") {
  const s = sanitizeText(value, 40);
  if (!s) return fallback;
  const cleaned = s.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

/** Only absolute https URLs without credentials are accepted. */
export function sanitizeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  return stripTrackingParams(url).toString();
}

function extFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-z0-9]{2,5})$/i);
    if (m) return m[1].toLowerCase();
  } catch {
    // ignore
  }
  return null;
}

function isImageLikeUrl(url) {
  if (!url) return false;
  if (IMAGE_EXT_RE.test(url)) return true;
  if (VIDEO_EXT_RE.test(url)) return false;
  const ext = extFromUrl(url);
  if (!ext) return false;
  return Boolean(EXT_MIME[ext] && EXT_MIME[ext].startsWith("image/"));
}

function isVideoLikeUrl(url) {
  if (!url) return false;
  if (VIDEO_EXT_RE.test(url)) return true;
  const ext = extFromUrl(url);
  if (!ext) return false;
  const mime = EXT_MIME[ext];
  return Boolean(mime && mime.startsWith("video/"));
}

/**
 * Resolve the MIME type of a variant. The explicit upstream MIME wins, then
 * the file extension, then the media kind. The result is always consistent
 * with the media kind (an image item can never become video/mp4).
 */
export function resolveMime(rawMime, url, kind) {
  const explicit = typeof rawMime === "string" ? rawMime.split(";")[0].trim().toLowerCase() : "";
  const ext = extFromUrl(url);
  const extMime = ext ? EXT_MIME[ext] : null;

  let mime = "";
  if (explicit && explicit.includes("/")) mime = explicit;
  else if (extMime) mime = extMime;

  if (kind === "image") {
    if (mime.startsWith("image/")) return mime;
    if (extMime && extMime.startsWith("image/")) return extMime;
    return "image/jpeg";
  }
  if (kind === "video") {
    if (mime.startsWith("video/")) return mime;
    if (extMime && extMime.startsWith("video/")) return extMime;
    return "video/mp4";
  }
  return mime || "application/octet-stream";
}

/** The file extension always comes from the resolved MIME type. */
export function extensionForMime(mime) {
  return MIME_EXT[String(mime || "").toLowerCase()] || "bin";
}

/**
 * Extract a human-readable quality label from a variant object/string.
 * Never invents a quality: if nothing is known we return "default".
 */
export function deriveQualityLabel(raw, kind) {
  const src = raw && typeof raw === "object" ? raw : {};
  const label = pickFirst(src.quality, src.label, src.resolution, src.quality_label);
  if (typeof label === "string" && label.trim()) return sanitizeQuality(label, "default");
  const h = num(pickFirst(src.height, src.h));
  const w = num(pickFirst(src.width, src.w));
  if (h && w) return `${w}x${h}`;
  if (h) return `${h}p`;
  const br = num(pickFirst(src.bitrate, src.bit_rate));
  if (br) return `${Math.round(br / 1000)}kbps`;
  return kind === "video" ? "default" : "original";
}

function hasQualityHints(v) {
  if (!v || typeof v !== "object") return false;
  return ["quality", "label", "resolution", "quality_label", "width", "w", "height", "h", "bitrate", "bit_rate"].some(
    (k) => v[k] !== undefined && v[k] !== null && v[k] !== "",
  );
}

function variantFromVideo(v) {
  if (typeof v === "string") {
    const url = sanitizeUrl(v);
    if (!url) return null;
    const mime = resolveMime(undefined, url, "video");
    return {
      url,
      quality: "default",
      width: undefined,
      height: undefined,
      bitrate: undefined,
      size: undefined,
      mime,
      has_audio: null,
    };
  }
  if (!v || typeof v !== "object") return null;
  const raw = pickFirst(v.video, v.url, v.src, v.download_url, v.link);
  const url = sanitizeUrl(raw);
  if (!url) return null;
  const mime = resolveMime(pickFirst(v.mime, v.mime_type, v.type), url, "video");
  return {
    url,
    quality: deriveQualityLabel(v, "video"),
    width: num(pickFirst(v.width, v.w)),
    height: num(pickFirst(v.height, v.h)),
    bitrate: num(pickFirst(v.bitrate, v.bit_rate)),
    size: num(pickFirst(v.size, v.file_size, v.filesize)),
    mime,
    has_audio: typeof v.has_audio === "boolean" ? v.has_audio : null,
  };
}

function variantFromImage(v) {
  if (typeof v === "string") {
    const url = sanitizeUrl(v);
    if (!url) return null;
    const mime = resolveMime(undefined, url, "image");
    return {
      url,
      quality: "original",
      width: undefined,
      height: undefined,
      bitrate: undefined,
      size: undefined,
      mime,
      has_audio: null,
    };
  }
  if (!v || typeof v !== "object") return null;
  const raw = pickFirst(v.url, v.image, v.src, v.display_url, v.download_url);
  const url = sanitizeUrl(raw);
  if (!url) return null;
  const mime = resolveMime(pickFirst(v.mime, v.mime_type, v.type), url, "image");
  return {
    url,
    quality: deriveQualityLabel(v, "image"),
    width: num(pickFirst(v.width, v.w)),
    height: num(pickFirst(v.height, v.h)),
    bitrate: undefined,
    size: num(pickFirst(v.size, v.file_size, v.filesize)),
    mime,
    has_audio: null,
  };
}

function thumbnailOf(v) {
  if (!v || typeof v !== "object") return null;
  const raw = pickFirst(v.thumbnail, v.thumb, v.preview, v.thumbnail_src, v.cover, v.display_url);
  return sanitizeUrl(raw);
}

/**
 * Make `quality` unique across the variants of ONE item (mutates in place).
 * @param {Array<{quality:string}>} variants
 */
export function uniquifyQualityLabels(variants) {
  if (!Array.isArray(variants) || variants.length < 2) return variants;
  const counts = new Map();
  for (const v of variants) counts.set(v.quality, (counts.get(v.quality) || 0) + 1);
  const seen = new Map();
  variants.forEach((v, i) => {
    const label = v.quality;
    if ((counts.get(label) || 0) < 2) return;
    if (label === "default" || label === "original") {
      v.quality = `option-${i + 1}`;
      return;
    }
    const n = (seen.get(label) || 0) + 1;
    seen.set(label, n);
    if (n > 1) v.quality = `${label}-${n}`;
  });
  // A generated label could in theory collide with a real one: de-duplicate once more.
  const used = new Set();
  for (const v of variants) {
    let q = v.quality;
    let k = 2;
    while (used.has(q)) q = `${v.quality}-${k++}`;
    v.quality = q;
    used.add(q);
  }
  return variants;
}

/**
 * Group flat upstream entries into media objects.
 * Entries that share a thumbnail, or that carry explicit quality hints, are
 * qualities of the SAME clip and end up as variants of one item.
 */
function groupFlatEntries(entries, kind) {
  const groups = [];
  const byKey = new Map();
  for (const entry of entries) {
    const variant = kind === "video" ? variantFromVideo(entry) : variantFromImage(entry);
    if (!variant) continue;
    const thumb = thumbnailOf(entry);
    let key = null;
    if (thumb) key = `t:${thumb}`;
    else if (hasQualityHints(entry)) key = `q:${kind}`;
    if (key && byKey.has(key)) {
      byKey.get(key).variants.push(variant);
      continue;
    }
    const group = { thumbnail: thumb, variants: [variant] };
    if (key) byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}

/**
 * @param {any} payload raw upstream JSON
 * @param {{kind:string, shortcode:string, canonical:string}} ctx
 * @param {string} provider provider name for provenance
 * @returns {object|null} normalised result, or null when nothing usable
 */
export function normalizeUpstream(payload, ctx, provider = "upstream") {
  // Guard: a null / non-object payload can never be normalised.
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (!ctx || typeof ctx !== "object") return null;

  const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : payload;

  const videos = asArray(pickFirst(data.video, data.videos, data.video_list));
  const images = asArray(pickFirst(data.image, data.images, data.image_list, data.pictures));
  const itemsRaw = asArray(pickFirst(data.items, data.medias, data.carousel, data.children));

  const items = [];

  // Structured items[] (preferred when present): each entry is already a
  // media object, its `*_versions` arrays hold the qualities.
  for (const it of itemsRaw) {
    if (!it || typeof it !== "object") continue;
    const isVideo =
      it.type === "video" ||
      it.media_type === 2 ||
      pickFirst(it.video, it.video_url, it.video_versions) !== undefined;
    if (isVideo) {
      const variants = asArray(pickFirst(it.video_versions, it.variants, it.video))
        .map(variantFromVideo)
        .filter(Boolean);
      if (variants.length) {
        items.push({ type: "video", thumbnail: thumbnailOf(it), variants });
      }
    } else {
      const variants = asArray(pickFirst(it.image_versions, it.variants, it.image, it.display_url))
        .map(variantFromImage)
        .filter(Boolean);
      if (variants.length) {
        items.push({ type: "image", thumbnail: thumbnailOf(it), variants });
      }
    }
  }

  // Flat video[] / image[] (legacy catplus shape).
  if (items.length === 0) {
    for (const group of groupFlatEntries(videos, "video")) {
      items.push({ type: "video", thumbnail: group.thumbnail, variants: group.variants });
    }
    for (const group of groupFlatEntries(images, "image")) {
      items.push({ type: "image", thumbnail: group.thumbnail, variants: group.variants });
    }
  }

  // Deduplicate variants by URL — globally, so the same media never shows up
  // twice (not even as two items).
  const seenUrls = new Set();
  for (const item of items) {
    item.variants = item.variants.filter((v) => {
      if (!v || !v.url || seenUrls.has(v.url)) return false;
      seenUrls.add(v.url);
      return true;
    });
  }

  // Quality labels must be unique inside an item, otherwise the download
  // endpoint (which selects by label) could never reach the second variant.
  // We never invent a resolution: unlabeled variants become option-1, option-2…
  // and repeated real labels get a numeric suffix (720p, 720p-2).
  for (const item of items) uniquifyQualityLabels(item.variants);

  const usable = items.filter((i) => i.variants.length > 0);
  if (usable.length === 0) return null;

  // The type must describe the media we actually got: a single item is always
  // typed by its own kind (a reel URL that resolves to a photo is an image,
  // not a video). Only multiple items make an album.
  const type = usable.length > 1 ? "album" : usable[0].type;

  const author = normalizeAuthor(data);
  const caption = sanitizeText(
    pickFirst(
      typeof data.caption === "string" ? data.caption : undefined,
      data.caption && typeof data.caption === "object" ? data.caption.text : undefined,
      data.description,
      data.title,
    ),
  );

  const duration = normalizeDuration(data);

  // The top level thumbnail must be an IMAGE. A video URL is never promoted
  // to a thumbnail (that would break <img> rendering downstream).
  let thumbnail = sanitizeUrl(pickFirst(data.thumbnail, data.thumbnail_src, data.cover));
  if (!thumbnail && isImageLikeUrl(pickFirst(data.display_url))) {
    thumbnail = sanitizeUrl(data.display_url);
  }
  if (!thumbnail) {
    for (const item of usable) {
      if (item.thumbnail && isImageLikeUrl(item.thumbnail)) {
        thumbnail = item.thumbnail;
        break;
      }
    }
  }
  if (!thumbnail) {
    for (const item of usable) {
      if (item.type === "image") {
        thumbnail = item.variants[0].url;
        break;
      }
    }
  }

  usable.forEach((item, i) => {
    item.index = i;
    item.type = item.type === "album" ? "image" : item.type;
    // Only image-like URLs may be used as a thumbnail.
    if (!item.thumbnail || !isImageLikeUrl(item.thumbnail)) {
      item.thumbnail = item.type === "image" ? item.variants[0]?.url || null : null;
    }
    item.variants.forEach((v) => {
      v.filename = buildFilename(
        author.username || "instagram",
        ctx.shortcode,
        usable.length > 1 ? i + 1 : 0,
        extensionForMime(v.mime),
      );
    });
  });

  return {
    type,
    author,
    caption: caption || "",
    thumbnail: thumbnail || null,
    items: usable,
    duration: duration || null,
    source_url: ctx.canonical,
    shortcode: ctx.shortcode,
    provider,
    variants_count: usable.reduce((sum, i) => sum + i.variants.length, 0),
  };
}

/**
 * Durations are normalised to SECONDS. Upstreams report either seconds
 * (`duration`) or milliseconds (`duration_ms`); the millisecond field wins
 * because it is explicit.
 */
export function normalizeDuration(data) {
  const ms = num(pickFirst(data.duration_ms, data.durationMs, data.video_duration_ms));
  if (ms) return ms / 1000;
  const sec = num(pickFirst(data.duration, data.duration_seconds, data.length, data.video_duration));
  return sec || undefined;
}

function normalizeAuthor(data) {
  const a = (data.author && typeof data.author === "object" ? data.author : null) ||
    (data.owner && typeof data.owner === "object" ? data.owner : null) ||
    {};
  const username = pickFirst(
    typeof data.author === "string" ? data.author : undefined,
    data.username,
    data.owner_username,
    a.username,
    a.user_name,
  );
  const fullName = pickFirst(data.full_name, data.owner_full_name, a.full_name, a.name);
  const avatar = pickFirst(data.avatar, data.profile_pic_url, data.owner_profile_pic_url, a.avatar, a.profile_pic_url);
  return {
    username: sanitizeUsername(username),
    full_name: sanitizeText(fullName, 120),
    avatar: sanitizeUrl(avatar),
  };
}
