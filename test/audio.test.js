import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import {
  parseOggPages, oggChunkRanges, parseMp4Audio, parseWav, pcmToWav,
  toMono16k, bytesToB64, b64ToBytes,
} from "../src/utils/audioparse.js";
import { sniffAudio } from "../src/utils/audio.js";
import decWorker from "../src/services/workers/decode.js";

const load = async (p) => new Uint8Array(await readFile(new URL(`./fixtures/${p}`, import.meta.url)));

describe("sniffAudio", () => {
  it("detects ogg/mp4/mp3/wav magic", async () => {
    expect(sniffAudio(await load("voice10s.ogg"))).toBe("ogg");
    expect(sniffAudio(await load("audio3s.m4a"))).toBe("mp4");
    expect(sniffAudio(await load("video3s.mp4"))).toBe("mp4");
    expect(sniffAudio(await load("audio10s.mp3"))).toBe("mp3");
    const wav = pcmToWav(new Int16Array(1600), 16000);
    expect(sniffAudio(wav)).toBe("wav");
  });
});

describe("parseOggPages", () => {
  it("finds header boundary and page-aligned ranges", async () => {
    const bytes = await load("voice10s.ogg");
    const pages = parseOggPages(bytes);
    expect(pages).not.toBeNull();
    expect(pages.headEnd).toBeGreaterThan(0);
    expect(pages.pages.length).toBeGreaterThanOrEqual(3);
    const ranges = oggChunkRanges(pages.pages, pages.headEnd, 50);
    expect(ranges.length).toBeGreaterThan(1);
    // ranges cover the data region contiguously
    expect(ranges[0][0]).toBe(pages.headEnd);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1]);
  });
});

describe("parseMp4Audio", () => {
  it("extracts asc + frames from an m4a", async () => {
    const p = parseMp4Audio(await load("audio3s.m4a"));
    expect(p).not.toBeNull();
    expect(p.sampleRate).toBeGreaterThan(8000);
    expect(p.channels).toBeGreaterThan(0);
    expect(p.asc).toBeInstanceOf(Uint8Array);
    expect(p.frames.length).toBeGreaterThan(50);
    for (const f of p.frames) expect(f.s).toBeGreaterThan(0);
  });

  it("extracts audio frames from an interleaved video mp4", async () => {
    const p = parseMp4Audio(await load("video3s.mp4"));
    expect(p).not.toBeNull();
    expect(p.sampleRate).toBe(44100);
    expect(p.frames.length).toBe(131); // stsz count
    // frames decode-able? offsets must be inside the file
    const bytes = await load("video3s.mp4");
    for (const f of p.frames.slice(0, 5)) {
      expect(f.o + f.s).toBeLessThanOrEqual(bytes.length);
    }
  });
});

describe("decode worker (/svc/dec)", () => {
  const call = (body) => decWorker.fetch(new Request("https://x/svc/dec", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })).then((r) => r.json());

  it("decodes opus pages to 16k mono int16", async () => {
    const bytes = await load("voice10s.ogg");
    const pages = parseOggPages(bytes);
    const r = await call({ codec: "opus", head: bytesToB64(bytes.subarray(0, pages.headEnd)), data: bytesToB64(bytes.subarray(pages.headEnd, pages.headEnd + 3520)) });
    expect(r.ok).toBe(true);
    expect(r.rate).toBe(16000);
    expect(r.samples).toBeGreaterThan(14000); // ~1 s slice -> ~16k samples
    expect(r.pcm.length).toBeGreaterThan(0);
  });

  it("decodes aac frames (mp4) with skip", async () => {
    const bytes = await load("audio3s.m4a");
    const p = parseMp4Audio(bytes);
    const r = await call({ codec: "aac", asc: bytesToB64(p.asc), skip: 8000, frames: p.frames.slice(0, 26).map((f) => bytesToB64(bytes.subarray(f.o, f.o + f.s))) });
    expect(r.ok).toBe(true);
    expect(r.samples).toBeGreaterThan(1000); // after 0.5 s warmup skip
  });

  it("decodes mp3 bytes", async () => {
    const bytes = await load("audio10s.mp3");
    const r = await call({ codec: "mp3", data: bytesToB64(bytes.subarray(0, 16000)) });
    expect(r.ok).toBe(true);
    expect(r.samples).toBeGreaterThan(14000); // ~1 s slice
  });

  it("rejects unknown codecs and bad json", async () => {
    expect((await call({ codec: "flac" })).ok).toBe(false);
    const r = await decWorker.fetch(new Request("https://x/svc/dec", { method: "POST", body: "not json" }));
    expect(r.ok).toBe(false);
  });
});

describe("b64 helpers", () => {
  it("round-trips binary", async () => {
    const bytes = await load("voice10s.ogg");
    const rt = b64ToBytes(bytesToB64(bytes));
    expect(rt.length).toBe(bytes.length);
    for (let i = 0; i < 100; i++) expect(rt[i]).toBe(bytes[i]);
  });
});

describe("pcmToWav / toMono16k", () => {
  it("builds a wav with a correct header and round-trip data", () => {
    const samples = new Int16Array(1600);
    for (let i = 0; i < samples.length; i++) samples[i] = i % 32767;
    const wav = pcmToWav(samples, 16000);
    expect(wav.length).toBe(44 + 3200);
    const parsed = parseWav(wav);
    expect(parsed.sampleRate).toBe(16000);
    expect(parsed.bits).toBe(16);
    expect(parsed.dataLen).toBe(3200);
    const rt = new Int16Array(wav.buffer, 44, 1600);
    expect(rt[3]).toBe(3);
  });

  it("resamples stereo 48k to mono 16k", () => {
    const ch = new Float32Array(48000);
    for (let i = 0; i < ch.length; i++) ch[i] = ((i % 480) / 480) * 2 - 1;
    const mono = toMono16k([ch, ch], 48000, 16000);
    expect(mono.length).toBe(16000);
    expect(Math.max(...mono) / 32767).toBeLessThanOrEqual(1.01);
    expect(Math.min(...mono) / 32768).toBeGreaterThanOrEqual(-1.01);
  });
});
