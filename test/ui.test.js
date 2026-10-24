import { describe, it, expect } from "vitest";
import { trackList, joinButtons, kb, btn, truncate } from "../src/ui/keyboards.js";

const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i), title: "T" + i, artist: "A", duration_ms: 60000, source: "sc" }));

describe("pagination", () => {
  it("10 per page, correct nav", () => {
    const items = mk(25);
    const { markup, pages } = trackList("en", items, "id", 0, 10);
    expect(pages).toBe(3);
    const trackBtns = markup.inline_keyboard.filter((r) => r.length === 1 && r[0].text.startsWith("🎵"));
    expect(trackBtns.length).toBe(10);
    // nav row present with next
    const nav = markup.inline_keyboard.find((r) => r.some((b) => b.callback_data === "act:pg:id:1"));
    expect(nav).toBeTruthy();
  });

  it("last page has prev only", () => {
    const { markup } = trackList("en", mk(25), "id", 2, 10);
    const nav = markup.inline_keyboard.find((r) => r.some((b) => b.callback_data?.startsWith("act:pg:")));
    const labels = nav.map((b) => b.callback_data).join(",");
    expect(labels).toContain("act:pg:id:1");
    expect(labels).not.toContain("act:pg:id:3");
  });

  it("callback_data <= 64 bytes", () => {
    const { markup } = trackList("en", mk(10), "x".repeat(8), 0, 10);
    for (const row of markup.inline_keyboard)
      for (const b of row)
        if (b.callback_data) expect(b.callback_data.length).toBeLessThanOrEqual(64);
  });
});

describe("joinButtons", () => {
  it("one button per channel + recheck", () => {
    const chans = [{ id: "@a", username: "@a" }, { id: "-1001", invite: "https://t.me/+x" }];
    const m = joinButtons("en", chans);
    expect(m.inline_keyboard.length).toBe(3);
    expect(m.inline_keyboard[2][0].callback_data).toBe("act:joined");
  });
});

describe("truncate", () => {
  it("truncates", () => expect(truncate("x".repeat(70), 60).length).toBe(60));
});
