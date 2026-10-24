// Cryptographic helpers: HMAC-SHA256 signing for /dl/ proxy links and any
// other signed tokens. Uses Web Crypto only (Worker-native).

const te = new TextEncoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    te.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function hmacHex(secret, data) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(String(data)));
  return bytesToHex(new Uint8Array(sig));
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare. */
export function timingSafeEqualStr(a, b) {
  const x = te.encode(String(a));
  const y = te.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Sign a payload for the /dl/ route.
 * Token format: base64url(`${exp}.${id}`) + "." + hmac(secret, `${exp}.${id}`)
 * We sign `${id}.${exp}` and concatenate.
 */
export async function signLink(secret, id, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = `${id}.${exp}`;
  const sig = await hmacHex(secret, body);
  return `${body}.${sig}`;
}

/**
 * Verify a signed link token. Returns { ok:true, id } or { ok:false }.
 * Checks HMAC and expiry.
 */
export async function verifyLink(secret, token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return { ok: false };
  const [id, expStr, sig] = parts;
  const exp = parseInt(expStr, 10);
  if (!isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return { ok: false };
  const expected = await hmacHex(secret, `${id}.${exp}`);
  if (!timingSafeEqualStr(expected, sig)) return { ok: false };
  return { ok: true, id };
}

/** Hash a string to hex (SHA-256) — used for cache keys. */
export async function sha256Hex(data) {
  const buf = await crypto.subtle.digest("SHA-256", te.encode(String(data)));
  return bytesToHex(new Uint8Array(buf));
}
