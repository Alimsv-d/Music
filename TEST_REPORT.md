# TEST REPORT — Music bot

## Automated tests (`npm test`)
14 tests, all passing on the host (Node 22.23.4):
- Query normalization, cache expiry/coalescing, fingerprint container, i18n parity/escaping
- Rate limiter, SSRF allowlist, smart group detection table, channel caption
- SoundCloud HLS manifest parsing/order
- fmt.js Telegram HTML subset + escaping
- Instagram tracker stripping/story URL classification and media variant selection

`npm audit --omit=dev`: 0 vulnerabilities.

## Phase B — live verification on the host

| Check | Result |
|---|---|
| `getMe` | ✅ `@SearcherMusiic_Bot` |
| App mount | ✅ `https://DevCoder.ir/` root, cPanel Node app |
| Webhook route | ✅ HTTP 200 for signed synthetic update; webhook URL configured |
| `/health` external | ✅ `{ok:true}`; RSS ~79MB |
| Search text / lyrics / direct pick | ✅ live synthetic updates HTTP 200 |
| Inline proxy HEAD/Range | ✅ signed `/m/<token>.mp3`, HTTP 200, `Accept-Ranges` |
| Instagram URL with tracker params | ✅ routed/cleaned; live public fixture delivered |
| Admin `/admin`, feature screen, gates | ✅ live synthetic updates HTTP 200 |
| Group `/diag` | ✅ live synthetic update HTTP 200 |
| Channel status | ✅ previous live check: administrator + can_post=true |
| Channel test post | ✅ previous live check: published then deleted |
| Cron | ✅ previous live check: `{ok:true}` |
| cPanel crontab | ⚠️ cagefs `/tmp` cannot create lock; internal 5-minute timer is enabled |

## B1 audio evidence

- Root cause reproduced: HLS-only `/download` returns JSON manifest (`mode:browser`, `hls:true`) and `/stream` can return 413; treating that body as an audio file produced the old short/silent Telegram file.
- Complete progressive validation: sid `256257257` → 5,865,884 bytes, ffprobe duration 290.366s for metadata 290s.
- Complete direct AAC validation: sid `2413206960` → ffprobe duration 218.622s; MP3 remux output 218.671s.
- HLS stitching implemented: `/api/v1/hls` manifest → init + ordered `/api/v1/hls-seg` segments, parallel batches with order preservation and cleanup on overflow/error.
- A 619-second HLS-only run was interrupted before completion; it is explicitly **not** marked green. Tracks over the 48MB upload budget are rejected rather than sending partial bytes.

## B1–B11 status

- B1: ✅ root cause + validation + progressive/HLS path; long HLS full-size evidence pending.
- B2: ✅ explicit group command/mention/reply paths + `/diag`; BotFather privacy mode remains external prerequisite for arbitrary text.
- B3: ✅ inline audio result + signed proxy; manual Telegram inline selection remains required.
- B4: ✅ inline Instagram video schema/callback; manual Telegram inline selection remains required.
- B5: ✅ Instagram routed before text search, tracker stripped, actual media gets controls; story upstream support is undocumented.
- B6: ✅ fresh `/start` message and per-message navigation.
- B7: ✅ no location API/read/request in source scan.
- B8: ✅ mode-select buttons removed; auto routing.
- B9: ✅ dashboard, toggles, health/gates, new welcome/UI.
- B10: ✅ selected search/deep-link audio sent directly to current private chat.
- B11: ✅ cover/caption/action buttons + voice demo path.

## Security

- Current tracked files: Telegram token-pattern scan clean.
- `.env` is ignored and mode 600; no values printed.
- Historical scan was not rewritten; no token-pattern hit was found in tracked history except placeholder example files. Rotate any externally exposed secrets as standard operational hygiene.

## Remaining manual checks

- Telegram client: inline audio selection, inline Instagram video insertion, group `/diag` in the real group, visual review of every admin/welcome screen.
- BotFather: disable privacy if arbitrary group messages should be visible; enable inline mode; keep inline location disabled.
- Cloudflare: the existing `main` branch is the Worker code; cPanel app is published separately as `cpanel-app` branch to avoid destructive mixing of two runtimes.