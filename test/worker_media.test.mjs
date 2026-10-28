import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const calls = [];
const originalFetch = globalThis.fetch;

function json(value) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function makeEnv() {
  return {
    BOT_TOKEN: 'test-token', OWNER_ID: '1', WEBHOOK_SECRET: 'test-secret',
    SOUNDCLOUD_API_URL: 'https://sc.test', SHAZAM_API_URL: 'https://sh.test',
    INSTA_API_URL: 'https://ig.test', BOT_USERNAME: 'SearcherMusiic_Bot',
  };
}

async function loadWorker() {
  const { buildSync } = await import('esbuild');
  const res = buildSync({
    entryPoints: ['src/worker.js'], bundle: true, format: 'cjs', platform: 'neutral',
    write: false, logLevel: 'silent',
    banner: { js: 'var module={exports:{}};var exports=module.exports;' },
    footer: { js: 'globalThis.__wk=module.exports.default||module.exports;' },
  });
  new Function(res.outputFiles[0].text)();
  return globalThis.__wk;
}

function webhookPath() { return '/wh/' + createHash('sha256').update('test-secret').digest('hex').slice(0, 24); }

function request(update) {
  return new Request('https://worker.test' + webhookPath(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'test-secret' },
    body: JSON.stringify(update),
  });
}

function installMockFetch() {
  calls.length = 0;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, options });
    if (u.includes('api.telegram.org') && u.endsWith('/getFile')) return json({ ok: true, result: { file_path: 'voice.ogg', file_size: 4 } });
    if (u.includes('api.telegram.org/file/')) return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'audio/ogg' } });
    if (u === 'https://sh.test/api/v1/recognize' || u === 'https://sh.test/api/v1/recognize/url') return json({ ok: true, data: { found: true, artist: 'Artist', title: 'Song' } });
    if (u.startsWith('https://sc.test/api/v1/search')) return json({ ok: true, results: [{ sid: '42', artist: 'Artist', title: 'Song', duration_ms: 1000 }] });
    if (u.startsWith('https://sc.test/api/v1/track')) return json({ ok: true, track: { sid: '42', artist: 'Artist', title: 'Song' } });
    if (u === 'https://sc.test/api/v1/stream?id=42' || u === 'https://sc.test/api/v1/download?id=42') return new Response(new Uint8Array([9, 9, 9]), { headers: { 'content-type': 'audio/mpeg' } });
    if (u.includes('api.telegram.org')) return json({ ok: true, result: { message_id: 9, audio: { file_id: 'audio-id' } } });
    return json({ ok: true });
  };
}

test('Telegram voice submits supported media to Shzm and sends recognized track', async () => {
  installMockFetch();
  const worker = await loadWorker();
  let pending;
  const response = await worker.fetch(request({ message: { chat: { id: 7 }, from: { id: 2 }, voice: { file_id: 'voice-id' } } }), makeEnv(), { waitUntil(p) { pending = p; } });
  assert.equal(response.status, 200);
  await pending;
  const shazam = calls.find((x) => x.url === 'https://sh.test/api/v1/recognize' || x.url === 'https://sh.test/api/v1/recognize/url');
  assert.ok(shazam);
  assert.ok(shazam.options.body instanceof FormData || typeof shazam.options.body === 'string');
  assert.equal(calls.filter((x) => x.url.includes('/sendAudio') || x.url.includes('/sendMessage')).length > 0, true);
});

test('Instagram reel uses /api/v1/resolve, selects video and submits supported media', async () => {
  installMockFetch();
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, options });
    if (u === 'https://ig.test/api/v1/resolve?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FABC%2F') return json({ ok: true, data: { items: [{ type: 'video', variants: [{ url: 'https://cdn.test/thumb.jpg', mime: 'image/jpeg' }, { url: 'https://cdn.test/reel.mp4', mime: 'video/mp4', has_audio: true }] }] } });
    if (u === 'https://cdn.test/reel.mp4') return new Response(new Uint8Array([5, 6, 7]), { headers: { 'content-type': 'video/mp4' } });
    if (u === 'https://sh.test/api/v1/recognize' || u === 'https://sh.test/api/v1/recognize/url') return json({ ok: true, data: { found: true, artist: 'Artist', title: 'Song' } });
    if (u.startsWith('https://sc.test/api/v1/search')) return json({ ok: true, results: [{ sid: '42', artist: 'Artist', title: 'Song' }] });
    if (u.includes('api.telegram.org')) return json({ ok: true, result: { message_id: 9, audio: { file_id: 'audio-id' } } });
    return json({ ok: true });
  };
  const worker = await loadWorker();
  const encoded = btoa('https://www.instagram.com/reel/ABC/').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  let pending;
  const response = await worker.fetch(request({ callback_query: { id: 'cb', data: 'igr:' + encoded, from: { id: 2 }, message: { chat: { id: 7 }, message_id: 4 } } }), makeEnv(), { waitUntil(p) { pending = p; } });
  assert.equal(response.status, 200);
  await pending;
  const resolve = calls.find((x) => x.url.startsWith('https://ig.test/api/v1/resolve'));
  assert.ok(resolve);
  const shazam = calls.find((x) => x.url === 'https://sh.test/api/v1/recognize' || x.url === 'https://sh.test/api/v1/recognize/url');
  assert.ok(shazam);
  assert.ok(shazam.options.body instanceof FormData || typeof shazam.options.body === 'string');
  assert.equal(calls.filter((x) => x.url.includes('/sendAudio') || x.url.includes('/sendMessage')).length > 0, true);
});

test.after(() => { globalThis.fetch = originalFetch; });
