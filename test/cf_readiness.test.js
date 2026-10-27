'use strict';
// Verifies the portable core (pure logic, no fs/child_process/disk) imports and
// runs without Node-only APIs — the subset that must run on Cloudflare Workers.
const test = require('node:test');
const assert = require('node:assert');

// modules that must stay platform-agnostic
const PORTABLE = [
  '../src/core/fmt.js',
  '../src/core/log.js',
  '../src/core/ratelimit.js',
  '../src/core/cache.js',
  '../src/services/query.js',
  '../src/services/trackMeta.js',
];

for (const m of PORTABLE) {
  test(`portable module loads without fs/child_process: ${m}`, () => {
    const src = require('node:fs').readFileSync(require.resolve(m), 'utf8');
    assert.equal(/require\(['"]node?:(fs|child_process|worker_threads)['"]\)/.test(src), false, `${m} uses node-only api`);
    assert.doesNotThrow(() => require(m));
  });
}

test('heavy facade exposes a uniform run() interface', () => {
  const heavy = require('../src/shared/heavy');
  assert.equal(typeof heavy.run, 'function');
  assert.equal(typeof heavy.registerLocal, 'function');
});
