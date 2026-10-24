import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/utils/kv.js";
import { MockKV } from "./mock-kv.js";

describe("Store", () => {
  let store;
  beforeEach(() => { store = new Store(new MockKV()); });

  it("user upsert/get", async () => {
    await store.upsertUser("1", { first_name: "Ali" });
    const u = await store.getUser("1");
    expect(u.first_name).toBe("Ali");
    expect(u.id).toBe("1");
    expect(u.lastSeen).toBeTypeOf("number");
  });

  it("admins add/remove/list", async () => {
    await store.addAdmin("111");
    expect(await store.isAdmin("111")).toBe(true);
    expect((await store.getAdmins()).length).toBe(1);
    await store.removeAdmin("111");
    expect(await store.isAdmin("111")).toBe(false);
  });

  it("channels", async () => {
    await store.putChannel("-100x", { title: "C" });
    const chans = await store.getChannels();
    expect(chans.length).toBe(1);
    expect(chans[0].enabled).toBe(true);
  });

  it("search handle ttl store/get", async () => {
    await store.putSearch("abc", { kind: "search", items: [1, 2] });
    const r = await store.getSearch("abc");
    expect(r.items).toEqual([1, 2]);
  });

  it("favorites add/remove/dedupe", async () => {
    const tr = { key: "sc:1", id: "1", title: "T" };
    await store.addFav("u1", tr);
    await store.addFav("u1", tr); // dedupe
    expect((await store.getFavs("u1")).length).toBe(1);
    await store.removeFav("u1", "sc:1");
    expect((await store.getFavs("u1")).length).toBe(0);
  });

  it("history max 10 dedupe", async () => {
    for (let i = 0; i < 15; i++) await store.pushHistory("u", "q" + i);
    const h = await store.getHistory("u");
    expect(h.length).toBe(10);
    expect(h[0]).toBe("q14");
  });

  it("stats bump/get", async () => {
    await store.bump("searches");
    await store.bump("searches", 4);
    expect(await store.getStat("searches")).toBe(5);
    expect(await store.getStatTotal("searches")).toBe(5);
  });

  it("rate limit window", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await store.rateLimit("u", 5);
      if (i < 4) expect(r.allowed).toBe(true);
    }
    const r = await store.rateLimit("u", 5);
    expect(r.allowed).toBe(false);
  });

  it("dedupe updates", async () => {
    expect(await store.seenUpdate(1)).toBe(false);
    expect(await store.seenUpdate(1)).toBe(true);
    expect(await store.seenUpdate(2)).toBe(false);
  });

  it("membership cache", async () => {
    await store.putMembership("u", "c", true);
    const m = await store.getMembership("u", "c");
    expect(m.ok).toBe(true);
  });
});
