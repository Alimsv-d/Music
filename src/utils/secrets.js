// Auto-derived runtime secrets. When a secret (e.g. WEBHOOK_SECRET) is not set
// as a real Worker secret, it is derived deterministically from BOT_TOKEN +
// OWNER_ID so a Deploy-to-Cloudflare user only needs to enter those two values.
// Setting the real env secret always wins (GitHub Action / wrangler path).

import { hmacHex } from "./crypto.js";

const cache = new Map();

async function derive(env, name) {
  const ck = `${env.BOT_TOKEN}::${env.OWNER_ID}::${name}`;
  if (cache.has(ck)) return cache.get(ck);
  const v = await hmacHex(`${env.BOT_TOKEN}:${env.OWNER_ID}`, `music-bot:${name}`);
  cache.set(ck, v);
  return v;
}

/**
 * Resolve a secret: explicit env value wins, else deterministic derivation.
 * Returns "" only when BOT_TOKEN itself is missing (nothing to derive from).
 */
export async function secret(env, name) {
  if (env[name]) return env[name];
  if (!env.BOT_TOKEN) return "";
  return derive(env, name);
}
