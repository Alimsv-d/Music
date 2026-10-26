'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanTrackMeta } = require('../src/services/trackMeta');
const { isPlayable, sidOf } = require('../src/services/soundcloud');

const cases = [
  [{ title: 'سقوط - داریوش اقبالی', artist: 'Alighamari' }, { artist: 'داریوش اقبالی', title: 'سقوط' }],
  [{ title: 'ریمیکس شاد آهنگ کنسل از مجید خراطها.mp3', artist: 'Parham Punk' }, { artist: 'مجید خراطها', title: 'کنسل' }],
  [{ title: 'Eminem - Without Me', artist: 'x' }, { artist: 'Without Me', title: 'Eminem' }], // artist may resolve either side; check contains
  [{ title: 'Reza Bahram - Hich', artist: 'reza bahram' }, { title: 'Hich' }],
  [{ title: 'Yar', artist: 'Reza Bahram' }, { title: 'Yar' }],
  [{ title: 'Reza Bahram - Yar', artist: 'random uploader' }, { artist: 'Reza Bahram', title: 'Yar' }],
];

test('cleanTrackMeta prefers real artist over uploader', () => {
  const m0 = cleanTrackMeta(cases[0][0]);
  assert.equal(m0.artist, 'داریوش اقبالی');
  assert.equal(m0.title, 'سقوط');
  const m1 = cleanTrackMeta(cases[1][0]);
  assert.equal(m1.artist, 'مجید خراطها');
  assert.equal(m1.title, 'کنسل');
  assert.ok(/ریمیکس|remix/i.test(m1.version || ''));
});

test('known artist/title order wins over uploader identity', () => {
  const examples = [
    ['سقوط - داریوش اقبالی', 'داریوش اقبالی', 'سقوط'],
    ['Reza Bahram - Yar', 'Reza Bahram', 'Yar'],
    ['ريمیکس شاد آهنگ کنسل از مجید خراطها.mp3', 'مجید خراطها', 'کنسل'],
    ['آهنگ شرمنده از مجید خراطها', 'مجید خراطها', 'شرمنده'],
    ['Peshawa Avareh - مجید خراطها', 'مجید خراطها', 'Peshawa Avareh'],
  ];
  for (const [title, artist, expectedTitle] of examples) {
    const meta = cleanTrackMeta({ title, artist: 'Plausible Uploader' });
    assert.equal(meta.artist, artist, title);
    assert.equal(meta.title, expectedTitle, title);
  }
});

test('keyboard semantic styles are centralized and serialized', () => {
  const { G, B, R, URLB } = require('../src/bot/keyboard');
  assert.equal(G('download', 'd').style, 'success');
  assert.equal(B('next', 'n').style, 'primary');
  assert.equal(R('back', 'b').style, 'danger');
  assert.equal(URLB('channel', 'https://example.com').style, 'primary');
});

test('cleanTrackMeta strips noise and version', () => {
  const m = cleanTrackMeta({ title: 'Yar (Official Audio) 320kbps.mp3', artist: 'Reza Bahram' });
  assert.equal(m.title.toLowerCase().includes('mp3'), false);
  assert.equal(m.title.toLowerCase().includes('320'), false);
});

test('isPlayable treats downloadable/streamable tracks as playable', () => {
  assert.equal(isPlayable({ hasMp3: true }), true);
  assert.equal(isPlayable({ hasProgressive: true }), true);
  // catalog is effectively all-HLS; downloadable/streamable tracks are playable
  // (worker assembles direct-mode files, browser-mode stitches via /hls-seg)
  assert.equal(isPlayable({ hasMp3: false, hasProgressive: false, hasHls: true, downloadable: true }), true);
  assert.equal(isPlayable({ downloadable: false, streamable: false }), false);
  assert.equal(isPlayable(null), false);
});

test('sidOf normalizes sc_ prefix', () => assert.equal(sidOf({ id: 'sc_1', sid: '1' }), '1'));
