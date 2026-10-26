'use strict';
const test = require('node:test');
const assert = require('node:assert');

// referral logic against the real store (temp data dir via env before require)
process.env.DATA_DIR = require('node:path').join(__dirname, '..', 'tmp', 'test_data_' + Date.now());
const REF = require('../src/services/referral');
const { getStore } = require('../src/core/store');
const store = getStore();

test('referral: code generation is stable and unguessable', () => {
  const c1 = REF.codeFor(111), c2 = REF.codeFor(111), c3 = REF.codeFor(222);
  assert.equal(c1, c2);
  assert.notEqual(c1, c3);
  assert.ok(c1.length >= 6);
});

test('referral: self-invite rejected', () => {
  const code = REF.codeFor(333);
  const r = REF.evaluate(333, code);
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'self');
});

test('referral: valid new user -> pending; duplicate rejected', () => {
  const inviter = 444, invitee = 555;
  const code = REF.codeFor(inviter);
  store.set('users', String(invitee), { first: Date.now() }); // brand new
  const r = REF.evaluate(invitee, code);
  assert.equal(r.status, 'pending');
  assert.equal(r.inviter, String(inviter));
  // already referred -> reject
  const r2 = REF.evaluate(invitee, code);
  assert.equal(r2.status, 'rejected');
});

test('referral: verify on first use within window', () => {
  const inviter = 666, invitee = 777;
  const code = REF.codeFor(inviter);
  store.set('users', String(invitee), { first: Date.now() });
  REF.evaluate(invitee, code);
  REF.maybeVerify(invitee);
  const u = store.get('users', String(invitee));
  assert.equal(u.ref_status, 'verified');
  const s = REF.statsFor(inviter);
  assert.ok(s.verified >= 1);
});

test('referral: stats and top aggregate correctly', () => {
  const s = REF.statsFor(666);
  assert.ok(s.points >= 1);
  const t = REF.top(10);
  assert.ok(Array.isArray(t));
});
