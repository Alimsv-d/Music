import { describe, it, expect } from "vitest";
import { Ctx } from "../src/ctx.js";
import { MockKV } from "./mock-kv.js";

const env = {
  KV: new MockKV(),
  OWNER_ID: "8437014959",
  BOT_TOKEN: "x:y",
  OWNER_USERNAME: "AliMsvD", CREATOR_NAME: "Ali Mousavi", BOT_NAME: "Music",
  SOUNDCLOUD_API_URL: "https://sc", SHAZAM_API_URL: "https://shz",
  INSTA_API_URL: "https://ig", LRCLIB_API_URL: "https://lr",
  LINK_SECRET: "s", WEBHOOK_SECRET: "w",
};

describe("roles", () => {
  it("owner resolves from OWNER_ID", async () => {
    const ctx = new Ctx(env, { waitUntil() {} });
    expect(await ctx.roleOf("8437014959")).toBe("owner");
  });
  it("admin via KV", async () => {
    const ctx = new Ctx(env, { waitUntil() {} });
    await ctx.store.addAdmin("555");
    expect(await ctx.roleOf("555")).toBe("admin");
  });
  it("plain user", async () => {
    const ctx = new Ctx(env, { waitUntil() {} });
    expect(await ctx.roleOf("999")).toBe("user");
  });
});

describe("cfg layering", () => {
  it("kv override beats env default", async () => {
    const ctx = new Ctx(env, { waitUntil() {} });
    expect(await ctx.cfg("page_size", 10)).toBe(10);
    await ctx.store.setCfg("page_size", 15);
    expect(await ctx.cfg("page_size", 10)).toBe(15);
  });
});
