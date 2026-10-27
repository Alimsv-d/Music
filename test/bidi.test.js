'use strict';
// Locks the visual (logical->display) order of mixed RTL/LTR panel text via
// bidi-js so a refactor can't silently break rendered label order.
const test = require('node:test');
const assert = require('node:assert');
const bidi = require('bidi-js')();
const { cleanTrackMeta } = require('../src/services/trackMeta');

const visual = (s) => bidi.getReorderedString(s, bidi.getEmbeddingLevels(s));

test('audio caption: title/artist/duration visual order is stable', () => {
  const m = cleanTrackMeta({ title: 'Noghteye Payan', artist: 'Googoosh' });
  assert.equal(visual(`🎵 ${m.title}\n👤 ${m.artist}\n⏱ 3:25`), '🎵 Noghteye Payan\n👤 Googoosh\n⏱ 3:25');
});

test('results heading (fa query + count) visual order is stable', () => {
  assert.equal(visual('🔎 نتایج «مجید خراطها»\n۲۴ آهنگ · صفحه ۱ از ۴'), '🔎 اهطارخ دیجم» جیاتن»\n۴ زا ۱ هحفص · گنهآ ۲۴');
});

test('duplicate-title button label disambiguates with artist', () => {
  const m = cleanTrackMeta({ title: 'کنسل', artist: 'مجید خراطها' });
  assert.equal(visual(`${m.title} · ${m.artist}`), 'اهطارخ دیجم · لسنک');
});

test('invite line keeps the LTR url intact inside RTL text', () => {
  assert.equal(visual('🔗 لینک اختصاصی شما:\nhttps://t.me/x?start=ref_abc123'), '🔗 امش یصاصتخا کنیل:\nhttps://t.me/x?start=ref_abc123');
});
