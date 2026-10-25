'use strict';
// Search engine: query intent, variant fan-out, merge, ranking, and explicit
// empty/error distinction. Provider adapters remain separate.
const sc = require('./soundcloud');
const sh = require('./shazam');
const { normalize, transliterate, aliasFor, similarity } = require('./query');
const { cleanTrackMeta } = require('./trackMeta');

const STOP = new Set(['آهنگ','موزیک','دانلود','متن','ترانه','song','music','download','lyrics','the','official','audio']);
function analyze(raw) {
  const q = String(raw || '').trim();
  const n = normalize(q);
  const words = n.split(/\s+/).filter(Boolean);
  const lyric = words.length >= 4 || /[\n،؛]/.test(q);
  const long = q.length > 200;
  const compact = words.filter((x) => !STOP.has(x)).join(' ');
  const variants = [...new Set([n, compact, aliasFor(q), transliterate(compact)].filter((x) => x && x.length >= 2))].slice(0, 4);
  return { raw: q, normalized: n, words, lyric, long, variants };
}
function score(q, tr) {
  const meta = cleanTrackMeta(tr);
  let s = Math.max(similarity(q, meta.title), similarity(q, `${meta.artist} ${meta.title}`), similarity(q, meta.artist));
  if (sc.isPlayable(tr)) s += 0.18;
  if (meta.isRemix && !/remix|ریمیکس|slowed|live/i.test(q)) s -= 0.12;
  if (tr.plays) s += Math.min(0.05, Math.log10(tr.plays + 1) / 200);
  return Math.max(0, Math.min(1, s));
}
async function search(raw, lang) {
  const a = analyze(raw);
  if (a.long || !a.normalized) return { kind: 'invalid', query: a };
  const settled = await Promise.allSettled(a.variants.slice(0, 3).map((q) => sc.search(q, 1, lang)));
  const errors = settled.filter((x) => x.status === 'rejected');
  const merged = new Map();
  for (const x of settled) if (x.status === 'fulfilled') for (const tr of (x.value.results || [])) merged.set(sc.sidOf(tr), tr);
  if (!merged.size && a.lyric) {
    try {
      const d = await sh.searchText(raw, 8, true);
      if (d && d.found && (d.artist || d.title)) {
        const q = `${d.artist || ''} ${d.title || ''}`.trim();
        const x = await sc.search(q, 1, lang);
        for (const tr of (x.results || [])) merged.set(sc.sidOf(tr), tr);
      }
    } catch (_) {}
  }
  const items = [...merged.values()].map((tr) => ({ tr, score: score(a.normalized, tr) })).sort((x,y) => y.score - x.score);
  return { kind: items.length ? 'ok' : (errors.length === settled.length ? 'error' : 'empty'), query: a, items };
}
module.exports = { analyze, search, score };
