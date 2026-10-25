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

test('cleanTrackMeta strips noise and version', () => {
  const m = cleanTrackMeta({ title: 'Yar (Official Audio) 320kbps.mp3', artist: 'Reza Bahram' });
  assert.equal(m.title.toLowerCase().includes('mp3'), false);
  assert.equal(m.title.toLowerCase().includes('320'), false);
});

test('isPlayable prefers real mp3/progressive over encrypted hls', () => {
  assert.equal(isPlayable({ hasMp3: true }), true);
  assert.equal(isPlayable({ hasProgressive: true }), true);
  assert.equal(isPlayable({ hasMp3: false, hasProgressive: false, hasHls: true, downloadable: true }), false);
});

test('sidOf normalizes sc_ prefix', () => assert.equal(sidOf({ id: 'sc_1', sid: '1' }), '1'));
