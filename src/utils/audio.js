// Minimal audio helpers for the recognition path.

/** Detect a container/format from magic bytes. -> "wav"|"ogg"|"mp3"|"mp4"|"webm"|null */
export function sniffAudio(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const b = bytes;
  const tag = (o, s) => String.fromCharCode(...b.subarray(o, o + s.length)) === s;
  if (tag(0, "RIFF") && tag(8, "WAVE")) return "wav";
  if (tag(0, "OggS")) return "ogg";
  if (tag(4, "ftyp")) return "mp4";
  if (tag(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "mp3";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  return null;
}

/**
 * Build a 16-bit PCM WAV file (mono) from Int16 samples. Used if a future
 * decoder produces PCM and we want to ship a WAV to the recognize endpoint.
 */
export function pcmToWav(samples, sampleRate = 16000) {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); v.setUint32(4, 36 + dataLen, true); wstr(8, "WAVE");
  wstr(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);          // PCM
  v.setUint16(22, 1, true);          // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  wstr(36, "data"); v.setUint32(40, dataLen, true);
  new Int16Array(buf, 44).set(samples);
  return new Uint8Array(buf);
}
