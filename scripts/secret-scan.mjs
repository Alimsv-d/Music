// Secret scanner: fails if any likely secret is present in the working tree.
// Run before every commit/push.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP = new Set(["node_modules", ".git", ".wrangler", "package-lock.json", ".dev.vars"]);
const PATTERNS = [
  { re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g, name: "telegram bot token" },
  { re: /CLOUDFLARE_API_TOKEN\s*=\s*[^\s"']{10,}/g, name: "CF api token" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, name: "private key" },
  // UUIDs are not secrets by themselves; public service/client IDs are common.
];

let hits = 0;
function scan(file) {
  if (SKIP.has(file.split(/[\\/]/).pop())) return;
  let content;
  try { content = readFileSync(file, "utf8"); } catch { return; }
  for (const { re, name } of PATTERNS) {
    const m = content.match(re);
    if (m && !file.endsWith(".example") && !file.endsWith("secret-scan.mjs")) {
      // Allow obvious placeholders.
      const real = m.filter((x) => !/xxx|change-me|your-|placeholder|EXAMPLE/i.test(x));
      if (real.length) { console.log(`⚠️  ${file}: ${name} -> ${real[0].slice(0, 20)}…`); hits++; }
    }
  }
}
function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(js|mjs|cjs|json|jsonc|md|sh|yml|yaml|toml|txt|vars|env)$/i.test(e) || e === ".env" || /^\.env(\..*)?$/.test(e) || !e.includes(".")) scan(p);
  }
}
walk(process.cwd());
console.log(hits ? `❌ ${hits} possible secret(s) found` : "✅ no secrets detected");
process.exit(hits ? 1 : 0);
