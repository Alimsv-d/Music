'use strict';
// Worker thread that computes a Shazam fingerprint from PCM.
const { workerData, parentPort } = require('node:worker_threads');
const { FpSignatureGenerator, fpEncodeSignature, fpBase64 } = require('./fingerprint');

try {
  const { pcm, maxSeconds } = workerData;
  const gen = new FpSignatureGenerator({ maxTimeSeconds: maxSeconds || 12 });
  const arr = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) arr[i] = pcm[i];
  gen.feed(arr);
  const duration = arr.length / 16000;
  if (duration > 36) gen.skipSamples(16000 * (Math.floor(duration / 2) - 6));
  const sig = gen.getNextSignature();
  const bytes = fpEncodeSignature(sig);
  const uri = 'data:audio/vnd.shazam.sig;base64,' + fpBase64(bytes);
  const samplems = Math.trunc((sig.numberSamples / sig.sampleRate) * 1000);
  parentPort.postMessage({ ok: true, uri, samplems });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e && e.message || e) });
}
