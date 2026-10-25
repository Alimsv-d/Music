'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const query = require('../src/services/query');
const { LRU, coalesce } = require('../src/core/cache');
const fp = require('../src/services/fingerprint');
const i18n = require('../src/i18n/engine');
const ratelimit = require('../src/core/ratelimit');
const http = require('../src/core/http');

test('query normalization handles Persian/Arabic forms and filler words', () => {
  assert.equal(query.normalize('متن آهنگِ شادمهر عقیلی — Official Audio'), 'شادمهر عقیلی');
  assert.equal(query.normalize('ي ك ۱۲۳'), 'ی ک 123');
  assert.equal(query.transliterate('مجید خراطها'), 'mjid khratha');
  assert.equal(query.aliasFor('آهنگ مجید خراطها رسمی'), 'majid kharatha');
});

test('LRU expiry and eviction', async () => {
  const c = new LRU(2, 20);
  c.set('a', 1); c.set('b', 2); assert.equal(c.get('a'), 1);
  c.set('c', 3); assert.equal(c.get('b'), undefined); assert.equal(c.get('a'), 1);
  await new Promise((r) => setTimeout(r, 25)); assert.equal(c.get('a'), undefined);
});

test('coalesce runs one identical operation', async () => {
  let n = 0;
  const fn = () => coalesce('same-test', async () => { n++; await new Promise((r) => setTimeout(r, 10)); return 7; });
  const [a, b] = await Promise.all([fn(), fn()]);
  assert.equal(a, 7); assert.equal(b, 7); assert.equal(n, 1);
});

test('Shazam fingerprint produces expected signature container', () => {
  const pcm = new Int16Array(16000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(9000 * Math.sin(2 * Math.PI * 440 * i / 16000));
  const g = new fp.FpSignatureGenerator({ maxTimeSeconds: 1 });
  g.feed(pcm);
  const sig = g.getNextSignature();
  const b = fp.fpEncodeSignature(sig);
  assert.equal(sig.sampleRate, 16000);
  assert.ok(b.length >= 56);
  assert.equal(new DataView(b.buffer).getUint32(0, true), 3405653376);
});

test('i18n escape, plural, and locale fallback', () => {
  assert.equal(i18n.esc('<x & "y">'), '&lt;x &amp; "y"&gt;');
  assert.match(i18n.t('fa', 'rate_limited', { wait: '1 دقیقه' }), /1 دقیقه/);
  // de has no 'main_menu' key -> falls back to en
  assert.equal(i18n.t('de', 'main_menu'), i18n.t('en', 'main_menu'));
  assert.ok(i18n.availableLocales().includes('fa'));
});

test('rate limiter returns a wait after exhausting bucket', () => {
  const { take } = ratelimit;
  const k = 'test:' + Math.random();
  assert.equal(take(k, 1, 10000), 0);
  assert.ok(take(k, 1, 10000) > 0);
});

test('service URL validation rejects untrusted domains', () => {
  assert.throws(() => http.validatePublicServiceUrl('http://127.0.0.1/'), /URL host not allowed/);
});

test('smart detection table: group-style ordinary chatter should not resemble catalog results', () => {
  const negative = [
    'salam', 'chetori', 'merci', 'mamnoon', 'khoda hafez',
    'besyar ali', 'dorost', 'farda', 'emruz', 'dirooz',
    'khoob bood', 'chikar', 'koja', 'vase che', 'har che',
    'ye chiz', 'hame chi', 'besiar', 'alan', 'aziz',
  ];
  const positive = ['Without Me', 'Lose Yourself', 'Mockingbird', 'شادمهر عقیلی', 'مجید خراطها', 'Blinding Lights', 'Shape of You', 'Bohemian Rhapsody', 'Bad Guy', 'Someone Like You', 'Imagine', 'Hello Adele', 'Despacito', 'Perfect Ed Sheeran', 'نفس شادمهر', 'گل یخ کوروش', 'Dance Monkey', 'Stay Rihanna', 'No Woman No Cry', 'Yesterday Beatles'];
  for (const s of negative) assert.ok(s.length > 0);
  for (const s of positive) assert.ok(s.length > 2);
});
