# TEST REPORT — Music bot

## Automated tests (`npm test`)
11 tests, all passing on the host (Node 22.23.4):
- Query normalization (Persian/Arabic forms, digits, fillers, transliteration, artist aliases)
- LRU cache expiry/eviction; request coalescing
- Shazam fingerprint: signature container magic + structure
- i18n: HTML escaping, plural, locale fallback, **parity (fa↔en/ar/ru/zh keys + placeholders)**
- Rate limiter token bucket
- SSRF: untrusted service hosts rejected
- Group smart-detect table (negative/positive cases)
- Channel post caption: only real API fields, signature, hashtags, <1024 chars

## Phase B — live verification on the host

| Check | Result |
|---|---|
| `getMe` | ✅ `@SearcherMusiic_Bot` |
| App mount | ✅ served at `https://DevCoder.ir/` root (uptime/RSS via `/health`) |
| `setWebhook` | ✅ `https://DevCoder.ir/wh/<sha256(secret)>` |
| `getWebhookInfo` | ✅ `last_error_message: null` |
| `/health` (external) | ✅ `{ok:true}` |
| Webhook ack latency | ✅ ~4.7 ms single update |
| 200 concurrent updates | ✅ all HTTP 200; p95 ~1.1 s (connection queuing on shared host, ack itself fast) |
| RSS memory | ✅ ~74–95 MB (< 200 MB budget) |
| Search (real) | ✅ results panel sent |
| Track page (real) | ✅ cover + editMessageMedia |
| Download (real) | ✅ audio sent to owner chat, temp file removed |
| Recognize WAV (real) | ✅ Eminem — Without Me, conf 95 |
| Recognize OGG/Opus voice (real) | ✅ Eminem — Without Me, conf 95 |
| Instagram resolve + download (real) | ✅ image resolved & downloaded |
| Channel `@MusicMsvD` admin | ✅ administrator, can_post=true |
| Live channel test post | ✅ published (mid 8) then deleted |
| Cron endpoint `/cron/<secret>` | ✅ `{ok:true}` |
| Group: normal chatter | ✅ silent |
| Group: trigger word + name | ✅ search reply |
| Non-owner admin callback | ✅ denied |
| cPanel `crontab -e` | ❌ host `/tmp` (cagefs) can't create lock → app runs internal 5-min timer fallback + external endpoint |

## Errors found & fixed during testing
- `bot.handleUpdate` failed until `await bot.init()` was added for webhook mode.
- Streamed downloads could save a JSON error body as audio → added content validation.
- `export` token check on worker.js resolved (it's ESM, correct for Workers).
- Duplicate identifier `ig`; i18n fallback order; fingerprint const-assignment; transliteration/alias fixes.

## Not fully exercised (require real owner interaction / secrets)
- Full interactive E2E through Telegram UI (relies on owner pressing buttons).
- GitHub push + Actions run — blocked on repo creation (no PAT on host).
