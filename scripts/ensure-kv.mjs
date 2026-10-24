// Ensure a KV namespace exists and inject its id into wrangler.jsonc.
// Used by `npm run deploy` and the GitHub Action so nobody edits config by hand.
// Requires wrangler auth (CF API token or `wrangler login`).

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const FILE = "wrangler.jsonc";
const NAME = "music-bot-kv";

function run(cmd) {
  try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { return e.stdout || ""; }
}

const src = readFileSync(FILE, "utf8");
if (/"id"\s*:\s*"[0-9a-f]{32}"/.test(src)) {
  console.log("kv id already present, skipping.");
  process.exit(0);
}

// Try to create / find the namespace.
let id = null;
const out = run(`npx wrangler kv namespace create "${NAME}" --json 2>/dev/null`) || run(`npx wrangler kv:namespace create "${NAME}" 2>/dev/null`);
const m = out.match(/"id"\s*:\s*"([0-9a-f]{32})"/) || out.match(/([0-9a-f]{32})/);
if (m) id = m[1];

if (!id) {
  // List existing and reuse if present.
  const list = run(`npx wrangler kv namespace list --json 2>/dev/null`) || run(`npx wrangler kv:namespace list 2>/dev/null`);
  const arr = (() => { try { return JSON.parse(list); } catch { return []; } })();
  const found = arr.find((n) => n.title && n.title.includes(NAME)) || arr[0];
  if (found) id = found.id;
}

if (!id) {
  console.error("Could not create/find KV namespace. Create it in the Cloudflare dashboard and put the id in wrangler.jsonc.");
  process.exit(1);
}

writeFileSync(FILE, src.replace(/"id"\s*:\s*""/, `"id": "${id}"`));
console.log(`kv id injected: ${id}`);
