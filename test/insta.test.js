import { describe, it, expect } from "vitest";
import { Insta } from "../src/services/insta.js";

describe("Instagram media normalization", () => {
  it("chooses video variant rather than thumbnail-like first variant", () => {
    const insta = new Insta({ INSTA_API_URL: "https://insta.test" });
    const out = insta._normWorker({
      type: "video",
      items: [{ index: 0, type: "video", thumbnail: "https://cdn/thumb.jpg", variants: [
        { url: "https://cdn/thumb.jpg", mime: "image/jpeg", has_audio: null, quality: "thumbnail" },
        { url: "https://cdn/video.mp4", mime: "video/mp4", has_audio: true, quality: "original" },
      ] }],
    }, "https://www.instagram.com/reel/ABC123/");
    expect(out.items[0].type).toBe("video");
    expect(out.items[0].url).toBe("https://cdn/video.mp4");
    expect(out.items[0].proxyUrl).toContain("quality=original");
  });

  it("does not classify an image post as a video", () => {
    const insta = new Insta({ INSTA_API_URL: "https://insta.test" });
    const out = insta._normWorker({
      type: "image",
      items: [{ index: 0, type: "image", variants: [{ url: "https://cdn/photo.jpg", mime: "image/jpeg" }] }],
    }, "https://www.instagram.com/p/ABC123/");
    expect(out.items[0].type).toBe("image");
  });
});
