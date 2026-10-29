// Bundled audio-decode worker (/svc/dec). The bot cannot decode OGG-Opus or
// MP4/AAC in one shot inside the 10 ms CPU budget of the Workers free plan,
// so recognition runs this route as a sequence of SELF-subrequests: every
// invocation gets a fresh CPU budget, decodes ~0.5-1 s of audio (WASM
// decoders below), and returns mono 16 kHz Int16 PCM. The bot assembles the
// chunks and hands a WAV/PCM blob to the Shazam service.
//
//   POST /svc/dec  { codec:"opus"|"aac"|"mp3", head?, asc?, skip?, data }
//     -> { ok:true, rate:16000, samples, pcm }

import { OggOpusDecoder } from "ogg-opus-decoder";
import aacDecode, { decoder as aacDecoder } from "@audio/decode-aac";
import { MPEGDecoder } from "mpg123-decoder";
import { toMono16k, bytesToB64, b64ToBytes } from "../../utils/audioparse.js";

const TARGET_RATE = 16000;

export default {
  async fetch(request) {
    if (request.method !== "POST") return jsonRes({ ok: false, error: "method" }, 405);
    let body;
    try { body = await request.json(); } catch { return jsonRes({ ok: false, error: "bad json" }, 400); }
    const t0 = performance.now();
    try {
      let channelData, srcRate;
      if (body.codec === "opus") {
        // head = OpusHead/OpusTags pages; data = page-aligned slice.
        let dec = new OggOpusDecoder();
        await dec.ready;
        const bytes = body.head
          ? concatBytes(b64ToBytes(body.head), b64ToBytes(body.data))
          : b64ToBytes(body.data);
        const out = await dec.decodeFile(bytes);
        channelData = out.channelData;
        srcRate = out.sampleRate;
      } else if (body.codec === "aac") {
        const dec = await aacDecoder({ asc: b64ToBytes(body.asc) });
        const frames = body.frames.map((f) => b64ToBytes(f));
        const out = dec.decode(frames);
        channelData = out.channelData;
        srcRate = out.sampleRate;
      } else if (body.codec === "aac-file") {
        // whole M4A/file slice (small audio-only files)
        const out = await aacDecode(b64ToBytes(body.data));
        channelData = out.channelData;
        srcRate = out.sampleRate;
      } else if (body.codec === "mp3") {
        const dec = new MPEGDecoder();
        await dec.ready;
        const out = dec.decode(b64ToBytes(body.data));
        channelData = out.channelData;
        srcRate = out.sampleRate;
      } else {
        return jsonRes({ ok: false, error: "unsupported codec" }, 400);
      }
      if (!channelData || !channelData.length || !channelData[0].length) {
        return jsonRes({ ok: true, rate: TARGET_RATE, samples: 0, pcm: "" });
      }
      let pcm = toMono16k(channelData, srcRate, TARGET_RATE);
      if (body.skip > 0) pcm = pcm.subarray(Math.min(body.skip, pcm.length));
      const pcmBytes = pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength
        ? new Uint8Array(pcm.buffer)
        : new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      return jsonRes({ ok: true, rate: TARGET_RATE, samples: pcm.length, pcm: bytesToB64(pcmBytes), ms: Math.round(performance.now() - t0) });
    } catch (e) {
      return jsonRes({ ok: false, error: String(e?.message || e), ms: Math.round(performance.now() - t0) }, 500);
    }
  },
};

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
