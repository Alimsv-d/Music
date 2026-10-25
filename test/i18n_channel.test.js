'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../src/i18n/engine');
const channel = require('../src/bot/channel');

const base = i18n.loadLocale('fa').strings;
const locales = i18n.availableLocales();

function keysOf(obj, prefix = '') {
  const out = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') out.push(...keysOf(v, prefix + k + '.'));
    else out.push(prefix + k);
  }
  return out;
}
function placeholders(s) {
  const m = String(s).match(/\{(\w+)\}/g) || [];
  return new Set(m);
}

for (const code of locales) {
  const meta = (i18n.loadLocale(code) || {}).meta || {};
  // Strict parity required only for reviewed locales; Tier-2 fall back to en/fa.
  if (meta.reviewed === false) continue;
  test(`locale ${code} has key + placeholder parity with fa`, () => {
    const loc = i18n.loadLocale(code).strings;
    const baseKeys = keysOf(base);
    const locKeys = new Set(keysOf(loc));
    const missing = baseKeys.filter((k) => !locKeys.has(k));
    assert.equal(missing.length, 0, `${code} missing keys: ${missing.slice(0, 8).join(',')}`);
    for (const bk of baseKeys) {
      const bv = getNested(base, bk), lv = getNested(loc, bk);
      if (typeof bv === 'string' && typeof lv === 'string') {
        const bp = placeholders(bv), lp = placeholders(lv);
        for (const p of bp) assert.ok(lp.has(p), `${code}.${bk} missing placeholder ${p}`);
      }
    }
  });
}
function getNested(obj, path) { return path.split('.').reduce((o, k) => o && o[k], obj); }

test('channel post caption uses only real API fields', () => {
  const tr = {
    sid: '123', title: 'Test Song', artist: 'Test Artist',
    duration: '3:45', duration_ms: 225000, created_at: '2026-01-15T10:00:00Z',
    genre: 'Pop', plays: 12345, cover: 'https://x/c.jpg', page_url: 'https://soundcloud.com/a/b',
  };
  const cap = channel.postCaption(tr, { signature: '@MusicMsvD' }, 'fa');
  assert.match(cap, /Test Song/);
  assert.match(cap, /Test Artist/);
  assert.match(cap, /@MusicMsvD/);
  assert.match(cap, /#Test_Artist|#TestArtist/);
  assert.ok(cap.length < 1024);
});
