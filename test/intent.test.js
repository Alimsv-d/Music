import { describe, it, expect } from "vitest";
import { looksLikeLyrics, extractInstagramUrl } from "../src/utils/text.js";

describe("lyrics and media intent", () => {
  it("detects Persian lyrics query", () => {
    expect(looksLikeLyrics("به تو از تو می نویسم به تو ای همیشه در یاد")).toBe(true);
  });
  it("extracts public Instagram story URLs", () => {
    expect(extractInstagramUrl("https://www.instagram.com/stories/music/123456/")).toContain("stories/music");
  });
});
