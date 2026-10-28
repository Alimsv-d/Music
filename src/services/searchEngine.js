'use strict';
// Search engine: query intent, variant fan-out, merge, ranking, and explicit
// empty/error distinction. Provider adapters remain separate.
const sc = require('./soundcloud');
const sh = require('./shazam');
const { normalize, transliterate, aliasFor, similarity } = require('./query');
const { cleanTrackMeta } = require('./trackMeta');
const { getStore } = require('../core/store');

const STOP = new Set(['آهنگ','موزیک','دانلود','متن','ترانه','song','music','download','lyrics','the','official','audio']);
function storeIncr(field) {
  try { getStore().incrStats(field); } catch (_) {}
}
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
function lyricWindows(raw) {
  const words = String(raw || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= 6) return [String(raw || '').trim()];
  const windows = [];
  for (let i = 0; i + 6 <= words.length && windows.length < 4; i += 4) windows.push(words.slice(i, i + 6).join(' '));
  const last = words.slice(-6).join(' ');
  if (last && !windows.includes(last)) windows.push(last);
  return windows;
}
function lyricOverlap(query, lyrics) {
  const tokens = (s) => new Set(normalize(s).split(/\s+/).filter((x) => x.length > 1));
  const a = tokens(query), b = tokens(lyrics);
  if (!a.size || !b.size) return 0;
  let hit = 0; for (const x of a) if (b.has(x)) hit++;
  return hit / a.size;
}
async function search(raw, lang) {
  const a = analyze(raw);
  if (a.long || !a.normalized) return { kind: 'invalid', query: a };
  const settled = await Promise.allSettled(a.variants.slice(0, 2).map((q) => sc.search(q, 1, lang)));
  const errors = settled.filter((x) => x.status === 'rejected');
  const merged = new Map();
  for (const x of settled) if (x.status === 'fulfilled') for (const tr of (x.value.results || [])) merged.set(sc.sidOf(tr), tr);
  if (a.lyric) {
    for (const window of lyricWindows(raw)) {
      try {
        const d = await sh.searchText(window, 8, true);
        const candidates = [...(d && d.results || [])];
        if (d && (d.found || d.artist || d.title)) candidates.unshift(d);
        const scoredCandidates = [];
        for (const candidate of candidates.slice(0, 5)) {
          if (!candidate.artist || !candidate.title) continue;
          const verified = await sh.lyrics(candidate.artist, candidate.title);
          if (!verified || !verified.text) continue;
          const overlap = lyricOverlap(window, verified.text);
          if (overlap >= 0.55) scoredCandidates.push({ candidate, overlap });
        }
        scoredCandidates.sort((x, y) => y.overlap - x.overlap);
        for (const { candidate, overlap } of scoredCandidates.slice(0, 3)) {
          const x = await sc.search(`${candidate.artist} ${candidate.title}`, 1, lang);
          for (const tr of (x.results || [])) {
            const sid = sc.sidOf(tr);
            if (merged.has(sid)) continue;
            merged.set(sid, tr);
            storeIncr('lyric_success');
            if (overlap >= 0.55) break;
          }
          if (overlap >= 0.75) break;
        }
      } catch (_) {}
    }
  }
  const items = [...merged.values()].map((tr) => ({ tr, score: score(a.normalized, tr) })).sort((x,y) => y.score - x.score);
  return { kind: items.length ? 'ok' : (errors.length === settled.length ? 'error' : 'empty'), query: a, items, errors };
}
module.exports = { analyze, search, score, lyricWindows, lyricOverlap };
