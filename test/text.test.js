import { describe, it, expect } from "vitest";
import {
  esc, toAsciiDigits, toFaDigits, normalize, splitArtistTitle, similarity,
  matchScore, fmtDuration, splitText, shortId, looksLikeLyrics,
  extractInstagramUrl, extractSoundCloudUrl,
} from "../src/utils/text.js";

describe("esc", () => {
  it("escapes html", () => {
    expect(esc('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });
  it("handles null", () => expect(esc(null)).toBe(""));
});

describe("digits", () => {
  it("fa->ascii", () => expect(toAsciiDigits("۵:۳۱")).toBe("5:31"));
  it("ar->ascii", () => expect(toAsciiDigits("٣")).toBe("3"));
  it("ascii->fa", () => expect(toFaDigits("5:31")).toBe("۵:۳۱"));
});

describe("normalize", () => {
  it("unifies arabic/persian chars & noise", () => {
    expect(normalize("Ebi - Goriz (Official Video)")).toBe("ebi goriz");
    expect(normalize("ابی - گریز")).toContain("ابی");
  });
  it("normalizes digits & punctuation", () => {
    expect(normalize("Track ۵ (feat. X)")).toBe("track 5");
  });
});

describe("splitArtistTitle", () => {
  it("splits A - B", () => {
    expect(splitArtistTitle("Ebi - Goriz")).toEqual({ artist: "Ebi", title: "Goriz" });
  });
  it("returns null without sep", () => expect(splitArtistTitle("Goriz")).toBeNull());
});

describe("similarity/matchScore", () => {
  it("exact match = 1", () => expect(similarity("ebi goriz", "ebi goriz")).toBe(1));
  it("subset scores high", () => expect(similarity("ebi goriz", "ebi goriz slowed")).toBeGreaterThan(0.7));
  it("different = low", () => expect(similarity("ebi goriz", "metallica one")).toBeLessThan(0.4));
  it("matchScore compares artist+title", () => {
    const s = matchScore("goriz ebi", { title: "Goriz", artist: "Ebi" });
    expect(s).toBeGreaterThan(0.7);
  });
});

describe("fmtDuration", () => {
  it("formats", () => expect(fmtDuration(229871)).toBe("3:50"));
  it("fa digits", () => expect(fmtDuration(229871, "fa")).toBe("۳:۵۰"));
});

describe("splitText", () => {
  it("keeps short text whole", () => expect(splitText("hello", 100)).toEqual(["hello"]));
  it("splits long text on paragraphs", () => {
    const long = Array(50).fill("line of lyrics here").join("\n\n");
    const chunks = splitText(long, 200);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(200));
  });
});

describe("detectors", () => {
  it("looksLikeLyrics", () => {
    expect(looksLikeLyrics("به تو از تو می نویسم به تو ای همیشه در یاد")).toBe(true);
    expect(looksLikeLyrics("Ebi - Goriz")).toBe(false);
  });
  it("extractInstagramUrl", () => {
    expect(extractInstagramUrl("look https://www.instagram.com/reel/ABC123/ x")).toContain("reel/ABC123");
    expect(extractInstagramUrl("no link")).toBeNull();
  });
  it("extractSoundCloudUrl", () => {
    expect(extractSoundCloudUrl("https://soundcloud.com/a/b")).toContain("soundcloud");
  });
});

describe("shortId", () => {
  it("is url-safe & unique", () => {
    const a = shortId(), b = shortId();
    expect(a).not.toBe(b);
    expect(a.length).toBe(8);
  });
});
