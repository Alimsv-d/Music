'use strict';
// cleanTrackMeta: derive the REAL artist/title/version from a raw track,
// not the uploader name. Uploader is last-resort fallback only.
const { normalize } = require('./query');

// Seed known-artist index (extendable from history/follows/admin pins).
const ARTIST_SEED = [
  'مجید خراطها', 'majid kharatha', 'شادمهر عقیلی', 'shadmehr aghili', 'رضا بهرام', 'reza bahram',
  'داریوش اقبالی', 'dariush eghbali', 'ابی', 'ebi', 'محسن یگانه', 'mohsen yeganeh', 'بهنام بانی', 'behnam bani',
  'ابراهیم تاتلیس', 'ebrahim tatlis', 'مسیح', 'masih', 'سیروان خسروی', 'sirvan khosravi',
];
let aliasIndex = null;
function setAliasIndex(list) { aliasIndex = list; }
function getAliasIndex() { return aliasIndex || ARTIST_SEED; }

// Word-boundary that works for Persian/Arabic too (\b fails on RTL letters).
const WB = '(?:^|\\s|[\\-_.,()[\\]«»"\'\']|‌)';
const NOISE = new RegExp(WB + '(mp3|320|128|kbps|\\d{2,3}\\s*kbps|official|audio|lyrics|video|hd|hq|full|complete|original|download|free|آهنگ|موزیک|دانلود|متن|ترانه|جدید|کامل|نسخه|ورژن|best|high quality)(?=\\s|$|[\\-_.,()[\\]«»"\'\'])', 'gi');
const VERSION = new RegExp(WB + '(remix|ریمیکس|live|زنده|acoustic|slowed|sped\\s*up|nightcore|bass\\s*boosted|8d|cover|کاور|instrumental|karaoke|unplugged|آنپلاگ|شاد|غمگین)(?=\\s|$|[\\-_.,()[\\]«»"\'\'])', 'gi');

function isLikelyArtist(s, uploader) {
  const n = normalize(s);
  if (!n) return 0;
  for (const a of getAliasIndex()) if (n === normalize(a) || n.includes(normalize(a)) || normalize(a).includes(n)) return 2;
  if (uploader && normalize(uploader) === n) return 0;
  // "Name Surname" shape (two or more words, latin) is a weak positive
  if (/^[a-z]+ [a-z]+/.test(n)) return 1;
  return 0;
}

function cleanTrackMeta(raw) {
  const uploader = raw.artist || '';
  let title = String(raw.title || '').trim();
  // capture ALL version descriptors, join as the version tag
  const vmatches = title.match(new RegExp(VERSION.source, 'gi')) || [];
  const version = vmatches.length ? vmatches.join(' ').replace(/\s+/g, ' ').trim() : null;
  // strip ALL version + noise + filename cruft from title for matching
  let cleanTitle = title
    .replace(/\.(mp3|m4a|wav|ogg|flac|aac|opus)$/i, '')
    .replace(new RegExp(VERSION.source, 'gi'), ' ')
    .replace(NOISE, ' ')
    .replace(/[\[\](){}#@*!؟?.,_'"|-]+/g, ' ')
    .replace(/\b(?:remix|live|slowed|cover)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  let artist = '';
  let conf = 0;

  // 1) publisher_metadata / uploader_is_artist hints if present
  if (raw.publisher_metadata && raw.publisher_metadata.artist) { artist = raw.publisher_metadata.artist; conf = 3; }

  // 2) "A - B" / "A – B" / "A | B" pattern in the RAW title (before punct-strip).
  if (!artist) {
    const m = title.split(/\s*[-–—|]\s*/);
    if (m.length >= 2) {
      const a0 = m[0].replace(/\.(mp3|m4a|wav|ogg)$/i, '').trim();
      const a1 = m.slice(1).join(' - ').replace(/\.(mp3|m4a|wav|ogg)$/i, '').trim();
      const s0 = isLikelyArtist(a0, uploader), s1 = isLikelyArtist(a1, uploader);
      // Convention "Artist - Title": switch to right side ONLY when it's a clearly
      // known artist (alias-index hit = 2). Otherwise keep left as artist.
      if (s1 >= 2 && s1 > s0) { artist = a1; cleanTitle = a0; conf = Math.max(conf, s1 ? 2 : 1); }
      else { artist = a0; cleanTitle = a1; conf = Math.max(conf, s0 ? 2 : 1); }
    }
  }

  // 3) "X by Y" or "آهنگ X از Y" — artist comes AFTER the preposition.
  if (!artist) {
    const m = cleanTitle.match(/(.+?)\s+(?:by|از)\s+(.+)/i);
    if (m) { cleanTitle = normalize(m[1].replace(new RegExp(VERSION.source, 'gi'), ' ').replace(NOISE, ' ').replace(/(?:^|\s)[رر][یي][مم][یي][کك]س(?=\s|$)/giu, ' ').replace(/\s+/g, ' ').trim()); artist = m[2].trim(); conf = Math.max(conf, 2); }
  }

  // 4) "featuring" / "feat"
  if (artist) {
    const m = cleanTitle.match(/(.+?)\s*(?:feat\.?|ft\.?|featuring)\s+(.+)/i);
    if (m) { cleanTitle = m[1].trim(); artist = artist || m[2].trim(); }
  }

  // 6) Prefer a known artist embedded in the title to a plausible uploader.
  //    Strip that artist's surrounding descriptor words, but keep the song title.
  if (!artist) {
    const normalizedTitle = normalize(cleanTitle);
    const cue = '(?:[رر][یي]م[یي][کك]س|remix|شاد|غمگین|آهنگ|موزیک|نسخه|کاور|cover|slowed|live|دانلود|جدید|کامل)';
    const cueClean = normalizedTitle.replace(new RegExp(cue, 'gi'), ' ').replace(/\s+/g, ' ').trim();
    for (const a of getAliasIndex()) {
      const escaped = String(a).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'i');
      if (cueClean.includes(normalize(a))) { artist = a; cleanTitle = normalize(cueClean.replace(re, ' ').replace(/[-–—|]/g, ' ').replace(/\s+/g, ' ').replace(/(?:^|\s)(?:از|by|of|from|برای)(?=\s|$)/giu, ' ').replace(/(?:^|\s)[رر][یي][مم][یي][کك]س(?=\s|$)/giu, ' ').replace(/\s+/g, ' ').trim()); conf = Math.max(conf, 2); break; }
    }
  }

  // 7) uploader-as-artist only if uploader looks like a real artist (alias index or shaped name)
  if (!artist) {
    const su = isLikelyArtist(uploader, null);
    if (su > 0) { artist = uploader; conf = Math.max(conf, su); }
  }

  // 8) last resort: uploader (low confidence) or cleaned title as artist
  if (!artist) { artist = uploader || cleanTitle; conf = 0; }
  if (!cleanTitle) cleanTitle = title || artist;

  return { artist: artist.trim(), title: cleanTitle.trim(), version, isRemix: /remix|ریمیکس/i.test(version || ''), confidence: conf };
}

module.exports = { cleanTrackMeta, setAliasIndex, getAliasIndex };
