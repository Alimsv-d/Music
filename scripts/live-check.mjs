// Live API verification: hits the REAL backend services and reports latency /
// failures. Run: node scripts/live-check.mjs

const SC = process.env.SC_URL || "https://soundcloud-worker.alighost5920.workers.dev";
const SHZ = process.env.SHZ_URL || "https://shazam-worker.alighost5920.workers.dev";
const IG = process.env.IG_URL || "https://insta-worker.alighost5920.workers.dev";
const LR = process.env.LR_URL || "https://lrclib.net";

const rows = [];
async function check(name, fn) {
  const t = Date.now();
  try {
    const info = await fn();
    rows.push([name, `${Date.now() - t}ms`, "✅", info || ""]);
  } catch (e) {
    rows.push([name, `${Date.now() - t}ms`, "❌", String(e.message).slice(0, 60)]);
  }
}
const j = async (u, o) => { const r = await fetch(u, o); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); };

await check("SC health", () => j(`${SC}/health`));
await check("SC search fa (Ebi)", async () => {
  const d = await j(`${SC}/api/v1/search?q=${encodeURIComponent("ابی")}`);
  if (!d.results?.length) throw new Error("no results");
  return `${d.results.length} results`;
});
await check("SC search intl", async () => {
  const d = await j(`${SC}/api/v1/search?q=metallica`);
  if (!d.results?.length) throw new Error("no results");
  return `${d.results.length} results`;
});
let sid;
await check("SC track", async () => {
  const s = await j(`${SC}/api/v1/search?q=ebi&page=1`);
  sid = s.results[0].sid;
  const d = await j(`${SC}/api/v1/track?id=${sid}`);
  if (!d.track) throw new Error("no track");
  return d.track.title;
});
await check("SC download check", async () => {
  const d = await j(`${SC}/api/v1/download?id=${sid}&check=1`);
  return `${d.mode}/${d.ext}/${d.segments}seg`;
});
await check("SC stream 1MB", async () => {
  const r = await fetch(`${SC}/api/v1/stream?id=${sid}`, { headers: { range: "bytes=0-1048575" } });
  if (!r.ok && r.status !== 206) throw new Error("HTTP " + r.status);
  const b = await r.arrayBuffer();
  return `${b.byteLength} bytes ${r.headers.get("content-type")}`;
});
await check("Shazam health", () => j(`${SHZ}/api/v1/health`));
await check("Shazam search", async () => {
  const d = await j(`${SHZ}/api/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "ebi goriz", limit: 5, lyrics: false }) });
  const dd = d.data || d;
  if (!dd.found) throw new Error("not found");
  return dd.results?.[0]?.title || "";
});
await check("Insta health", () => j(`${IG}/health`));
await check("LRCLIB search", async () => {
  const d = await j(`${LR}/api/search?track_name=Goriz&artist_name=Ebi`);
  if (!d.length) throw new Error("no results");
  return `${d.length} results, lyrics: ${d[0].plainLyrics ? "yes" : "no"}`;
});
await check("LRCLIB get", async () => {
  const d = await j(`${LR}/api/get?track_name=Goriz&artist_name=Ebi`);
  return d.plainLyrics ? `${d.plainLyrics.length} chars` : "none";
});

console.log("\n| check | latency | status | info |\n|---|---|---|---|");
for (const r of rows) console.log(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`);
const fails = rows.filter((r) => r[2] === "❌").length;
console.log(`\n${rows.length - fails}/${rows.length} passed`);
process.exit(fails ? 1 : 0);
