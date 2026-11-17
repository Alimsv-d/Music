// Rate-limit buckets + escalation, shared across handlers (host-parity
// behavior: per-user KV windows with increasing penalty waits).

// ── rate limit (host buckets; per-user KV windows + escalation) ─────────────
export const BUCKETS = { action: { limit: 8, window: 10 }, search: { limit: 1, window: 2 }, download: { limit: 6, window: 60 }, recognize: { limit: 4, window: 60 }, group: { limit: 20, window: 60 }, ticket: { limit: 3, window: 3600 }, mp3convert: { limit: 6, window: 300 } };
const PENALTIES = [60, 600, 3600, 86400];

const H = {
  get: (ctx, table, key) => ctx.store.get(`${table}:${key}`),
  set: (ctx, table, key, v) => ctx.store.put(`${table}:${key}`, v),
};

export function fmtWait(sec) { return sec >= 3600 ? `${Math.ceil(sec / 3600)} ساعت` : sec >= 60 ? `${Math.ceil(sec / 60)} دقیقه` : `${sec} ثانیه`; }

export async function rlCheck(ctx, uid, bucket) {
  if (!uid) return null;
  const role = await ctx.roleOf(uid);
  if (role !== "user") return null;
  const cfg = BUCKETS[bucket] || BUCKETS.action;
  const now = Date.now();
  const cur = (await H.get(ctx, "rlx", `${uid}:${bucket}`)) || { n: 0, win: 0, pen: 0 };
  if (cur.pen && now < cur.pen) return Math.ceil((cur.pen - now) / 1000);
  if (cur.win !== Math.floor(now / (cfg.window * 1000))) { cur.win = Math.floor(now / (cfg.window * 1000)); cur.n = 0; }
  cur.n++;
  if (cur.n > cfg.limit) {
    cur.pen = now + PENALTIES[Math.min((cur.penCount || 0), PENALTIES.length - 1)] * 1000;
    cur.penCount = (cur.penCount || 0) + 1;
    cur.n = 0;
    await H.set(ctx, "rlx", `${uid}:${bucket}`, cur);
    return Math.ceil((cur.pen - now) / 1000);
  }
  await H.set(ctx, "rlx", `${uid}:${bucket}`, cur);
  return null;
}
