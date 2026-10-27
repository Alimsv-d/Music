# Cloudflare readiness

Goal: the core runs on Workers without rewrite; host-specific pieces are
isolated behind interfaces. Verified by `test/cf_readiness.test.js`.

## Portable now (no fs / child_process / disk / sync Node APIs)
- `src/core/fmt.js` — markup + bidi
- `src/core/log.js` — writes to stdout ( Workers console )
- `src/core/ratelimit.js` — token buckets (in-memory)
- `src/core/cache.js` — LRU/coalesce (in-memory)
- `src/services/query.js`, `src/services/trackMeta.js` — pure text/meta logic
- `src/shared/heavy.js` — `heavy.run(task, payload)` facade: local impl today,
  `HEAVY_URL` + HMAC-signed POST when `CF_WORKER`/HEAVY_URL is set. `decodePcm`
  already registered (ffmpeg-pipe locally, remote on Workers).
- All Telegram sends use `fetch`/URL or uploaded bytes — no disk.

## Not portable yet (needs an adapter for Workers)
- `src/core/store.js` — uses `node:sqlite` (Node-only). The public API
  (`get/set/del/keys/all/incrStats`) is already an interface; a KV/D1 adapter
  with the same methods is the remaining work.
- `src/core/http.js` — uses `node:http/https` agents; must be swapped for
  `fetch` on Workers (same `request/getJson/postJson` surface).
- `src/config.js` — reads `.env` via `fs` (Worker env vars instead).
- `src/i18n/engine.js` — `fs`-loads locale JSON (bundle or KV on Workers).
- `src/services/fingerprint*.js` — `worker_threads`; on Workers the fingerprint
  runs in the main isolate (pure JS) or behind `heavy.run`.
- `src/services/mediaCache.js` — REMOVED (was disk cache).
- ffmpeg paths — already behind pipes/`heavy.run`; remote-only on Workers.

## Still on the table
- Swap `node:http` server in `index.js` for a `fetch` handler / `webhookCallback`
  export when deploying; the update pipeline (`enqueue`, `handleUpdate`) is
  transport-agnostic.
