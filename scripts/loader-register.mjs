// Bootstraps the node-side wasm loader hooks so that static wasm imports
// resolve outside workerd (vitest/e2e run on node).
// In workerd/wrangler the wasm imports are compiled at bundle time, so no
// registration is needed there.
import { register } from "node:module";

register("./wasm-hooks.mjs", import.meta.url);
