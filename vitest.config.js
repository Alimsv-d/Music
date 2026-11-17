import { defineConfig } from "vitest/config";
import fs from "node:fs";
import path from "node:path";

// .wasm imports compiled to real WebAssembly.Modules (matching wrangler's
// CompiledWasm handling) so that decode.js's shim chain works under vitest.
const wasmPlugin = {
  name: "wasm-bin-compile",
  enforce: "pre",
  resolveId(source, importer) {
    if (source.endsWith(".wasm") && !source.startsWith("\0wasm:")) {
      const abs = path.isAbsolute(source)
        ? source
        : path.resolve(path.dirname(importer ?? process.cwd()), source);
      return "\0wasm:" + abs;
    }
  },
  load(id) {
    if (id.startsWith("\0wasm:")) {
      const buf = fs.readFileSync(id.slice(6));
      const b64 = buf.toString("base64");
      return `const b = Uint8Array.from(atob("${b64}"), (c) => c.charCodeAt(0));
export default new WebAssembly.Module(b);
`;
    }
  },
};

export default defineConfig({
  plugins: [wasmPlugin],
  test: {
    include: ["test/**/*.test.js"], environment: "node",
    pool: "forks", poolOptions: { forks: { singleFork: true, maxForks: 1, minForks: 0 } },
    reporters: ["default"],
  },
});
