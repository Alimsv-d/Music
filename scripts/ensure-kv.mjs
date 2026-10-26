// Ensure exactly the named KV namespace exists and inject its id into wrangler.jsonc.
// Requires wrangler auth (CF API token or `wrangler login`).

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const FILE = "wrangler.jsonc";
const NAME = "music-bot-kv";

function run(args) {
  try {
    return execFileSync("npx", ["wrangler", ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return e.stdout || "";
  }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

const src = readFileSync(FILE, "utf8");
const existing = src.match(/"id"\s*:\s*"([0-9a-f]{32})"/i)?.[1];
if (existing) {
  console.log("kv id already present, skipping.");
  process.exit(0);
}

let id = null;
const created = parseJson(run(["kv", "namespace", "create", NAME, "--json"]));
if (created?.id) id = created.id;

if (!id) {
  const listed = parseJson(run(["kv", "namespace", "list", "--json"]));
  const found = Array.isArray(listed) ? listed.find((n) => n.title === NAME) : null;
  if (found?.id) id = found.id;
}

if (!id || !/^[0-9a-f]{32}$/i.test(id)) {
  console.error(`Could not create/find KV namespace named ${NAME}.`);
  process.exit(1);
}

const binding = /\{\s*"binding"\s*:\s*"KV"\s*\}/;
const updated = binding.test(src)
  ? src.replace(binding, `{ "binding": "KV", "id": "${id}" }`)
  : src.replace(/("kv_namespaces"\s*:\s*\[)/, `$1\n    { "binding": "KV", "id": "${id}" },`);
writeFileSync(FILE, updated);
console.log("kv namespace configured");
