// Cryptographic helpers used by the router (constant-time comparison of API
// keys).

/**
 * Constant-time string comparison.
 *
 * Both values are hashed with SHA-256 first, so the comparison always runs
 * over 32 bytes and the result does not depend on the length of the input.
 */
export async function timingSafeEqual(a, b) {
  const digest = async (value) => {
    const data = new TextEncoder().encode(String(value == null ? "" : value));
    const d = await crypto.subtle.digest("SHA-256", data);
    return new Uint8Array(d);
  };
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}
