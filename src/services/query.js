'use strict';
// Query normalization: Persian/Arabic digits, ی/ي, ک/ك, ZWNJ, bidi marks,
// filler words, transliteration retry, artist aliases.
const AR_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const FILLER = ['official', 'audio', 'lyrics', 'music', 'video', 'متن', 'آهنگ', 'موزیک', 'رسمی', 'فول', 'کامل', 'hd', 'hq', 'feat', 'ft', 'the', 'a', 'of'];

const ALIASES = {
  'مجید خراطها': 'majid kharatha', 'شادمهر': 'shadmehr', 'شادمهر عقیلی': 'shadmehr aghili',
  'ابی': 'eblis', 'محسن یگانه': 'mohsen yeganeh', 'بهنام بانی': 'behnam bani',
  'مسیح': 'masih', 'مسیح و آرش': 'masih arash', 'سیروان': 'sirvan khosravi',
  'حمید عسکری': 'hamid askari', 'رضا صادقی': 'reza sadeghi', 'علیرضا طلیسچی': 'alireza talischi',
};

function normalizeDigits(s) {
  return String(s).replace(/[۰-۹]/g, (d) => String(AR_DIGITS.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}
function normalize(s) {
  if (!s) return '';
  let x = String(s);
  x = x.replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/‌/g, ' '); // ی/ك/ZWNJ
  x = x.replace(/[‎‏‪-‮]/g, ''); // bidi marks
  x = normalizeDigits(x);
  x = x.replace(/https?:\/\/\S+/g, ' ');
  x = x.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const words = x.split(' ').filter((w) => w && !FILLER.includes(w));
  return words.join(' ');
}

const FA_TO_LAT = {
  'آ': 'a', 'أ': 'a', 'إ': 'e', 'ب': 'b', 'پ': 'p', 'ت': 't', 'ث': 's', 'ج': 'j', 'چ': 'ch', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'z', 'غ': 'gh',
  'ر': 'r', 'ز': 'z', 'ژ': 'zh', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'z', 'ط': 't', 'ظ': 'z', 'ع': 'a', 'ا': 'a',
  'ف': 'f', 'ق': 'gh', 'ک': 'k', 'ك': 'k', 'گ': 'g', 'ل': 'l', 'م': 'm', 'ن': 'n', 'و': 'o', 'ه': 'h', 'ی': 'i', 'ي': 'i', 'ء': '', 'ئ': 'y', 'ؤ': 'o', 'ۀ': 'h', 'ة': 'h', 'ً': '', 'ٌ': '', 'ٍ': '', 'َ': 'a', 'ُ': 'o', 'ِ': 'e', 'ّ': '',
};
function transliterate(s) {
  let out = '';
  for (const ch of s) {
    if (FA_TO_LAT[ch] !== undefined) out += FA_TO_LAT[ch];
    else out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}
function aliasFor(s) {
  const n = normalize(s);
  for (const k of Object.keys(ALIASES)) {
    if (n.includes(normalize(k))) return n.replace(normalize(k), ALIASES[k]);
  }
  return null;
}

const SC_RE = /(?:https?:\/\/)?(?:www\.)?soundcloud\.com\/[^\s]+/i;
function isSoundCloudUrl(s) { return SC_RE.test(s || ''); }

// crude similarity for smart-detect
function similarity(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  const sa = new Set(a.split(' ')), sb = new Set(b.split(' '));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / Math.max(sa.size, sb.size);
}

module.exports = { normalize, transliterate, aliasFor, isSoundCloudUrl, similarity, normalizeDigits };
