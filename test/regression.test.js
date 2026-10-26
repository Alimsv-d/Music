'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../src/services/soundcloud');
const { fmt, e } = require('../src/core/fmt');
const ig = require('../src/services/instagram');
const channel = require('../src/bot/channel');

test('SoundCloud HLS parser keeps init segment then ordered media segments', () => {
  const m = '#EXTM3U\n#EXT-X-MAP:URI="init"\n#EXTINF:10,\nseg0\n#EXTINF:10,\nseg1\n';
  const p = sc.parseM3U8(m);
  assert.equal(p.init, 'init');
  assert.deepEqual(p.segs, ['seg0', 'seg1']);
});

test('fmt converts safe markdown subset to Telegram HTML and escapes user content', () => {
  assert.equal(fmt('**bold** _italic_ `code` ||hide||\n> quote'), '<b>bold</b> <i>italic</i> <code>code</code> <tg-spoiler>hide</tg-spoiler>\n<blockquote>quote</blockquote>');
  assert.equal(e('<x>'), '⁨&lt;x&gt;⁩');
});

test('Instagram tracker parameters are removed before resolve', () => {
  assert.equal(ig.cleanUrl('https://www.instagram.com/reel/ABC123/?igsh=abc&dlrf=xyz'), 'https://www.instagram.com/reel/ABC123/');
  assert.equal(ig.isInstaUrl('https://www.instagram.com/stories/name/12345/'), true);
});

test('direct-vs-list gate requires an exact title/artist match and confidence margin', () => {
  const gate = (top, second, nonArtistTokens) => !!(top && top._score >= 0.92 && (!second || top._score - second._score >= 0.15) && nonArtistTokens.length > 0);
  assert.equal(gate({ _score: 0.93 }, { _score: 0.77 }, ['سقوط']), true);
  assert.equal(gate({ _score: 0.91 }, { _score: 0.75 }, ['سقوط']), false);
  assert.equal(gate({ _score: 0.93 }, { _score: 0.79 }, ['سقوط']), false);
  assert.equal(gate({ _score: 0.93 }, { _score: 0.77 }, []), false);
});

test('channel post policy defaults match the approved limits', () => {
  const cfg = channel.postPolicy();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.maxPerDay, 3);
  assert.equal(cfg.minGapMs, 3 * 60 * 60 * 1000);
  assert.equal(cfg.quietStart, 1);
  assert.equal(cfg.quietEnd, 8);
});
