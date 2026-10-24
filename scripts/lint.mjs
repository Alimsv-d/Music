// Lightweight "lint": node --check every source file + verify all imports resolve.

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

let bad = 0;
function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== "node_modules" && e !== ".git") walk(p); continue; }
    if (!/\.(js|mjs)$/.test(e)) continue;
    try { execSync(`node --check "${p}"`, { stdio: "pipe" }); }
    catch (err) { console.log(`SYNTAX FAIL ${p}\n${err.stderr}`); bad++; }
    // check relative imports resolve
    const src = readFileSync(p, "utf8");
    for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const rel = m[1];
      const cand = resolve(dirname(p), rel);
      if (!existsSync(cand) && !existsSync(cand + ".js")) {
        console.log(`BAD IMPORT in ${p}: ${rel}`); bad++;
      }
    }
  }
}
walk("src");
walk("test");
walk("scripts");
console.log(bad ? `❌ ${bad} problem(s)` : "✅ lint clean");
process.exit(bad ? 1 : 0);
