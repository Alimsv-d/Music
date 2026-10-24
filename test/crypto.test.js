import { describe, it, expect } from "vitest";
import { signLink, verifyLink, hmacHex, timingSafeEqualStr } from "../src/utils/crypto.js";
import { sniffAudio, pcmToWav } from "../src/utils/audio.js";

describe("signed links", () => {
  it("sign + verify roundtrip", async () => {
    const tok = await signLink("secret", "sc:123", 3600);
    const v = await verifyLink("secret", tok);
    expect(v.ok).toBe(true);
    expect(v.id).toBe("sc:123");
  });
  it("rejects wrong secret", async () => {
    const tok = await signLink("secret", "sc:123", 3600);
    const v = await verifyLink("other", tok);
    expect(v.ok).toBe(false);
  });
  it("rejects expired", async () => {
    const tok = await signLink("secret", "sc:123", -10);
    const v = await verifyLink("secret", tok);
    expect(v.ok).toBe(false);
  });
  it("rejects malformed", async () => {
    expect((await verifyLink("s", "a.b")).ok).toBe(false);
    expect((await verifyLink("s", "")).ok).toBe(false);
  });
});

describe("hmac", () => {
  it("produces hex", async () => {
    const h = await hmacHex("k", "data");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("timingSafeEqualStr", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
  });
});

describe("audio", () => {
  it("sniff wav", () => {
    const wav = pcmToWav(new Int16Array(100), 16000);
    expect(sniffAudio(wav)).toBe("wav");
  });
  it("sniff ogg", () => {
    const b = new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...new Array(20).fill(0)]);
    expect(sniffAudio(b)).toBe("ogg");
  });
  it("pcmToWav header", () => {
    const w = pcmToWav(new Int16Array([1, 2, 3]), 16000);
    expect(String.fromCharCode(...w.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...w.subarray(8, 12))).toBe("WAVE");
  });
});
