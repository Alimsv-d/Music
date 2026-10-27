# REGRESSION — reproduced behavior and evidence

Commands below were run on the cPanel Node app checkout (Node 22.23.4). No bot/API secrets are included here.

## B1 — audio shortened/silent despite 4–10 minute metadata

### Reproduction, before fix

```sh
curl -sS 'https://soundcloud-worker.alighost5920.workers.dev/api/v1/download?id=254976254&check=1'
curl -sS -o /dev/null -w 'status=%{http_code} type=%{content_type} bytes=%{size_download}\n' 'https://soundcloud-worker.alighost5920.workers.dev/api/v1/download?id=254976254'
curl -sSI 'https://soundcloud-worker.alighost5920.workers.dev/api/v1/stream?id=254976254'
```

Observed: check response `mode:"browser", ext:"m4a", segments:492, dur_sec:4909, hls:true`; actual `/download` response was JSON (`application/json`, 178 bytes), and `/stream` returned HTTP 413. Earlier bot code treated these bodies as audio and supplied duration from track metadata, so Telegram displayed a long duration over a short/invalid body.

### Fix / validation

- Download pipeline tries direct `/download`, then `/stream`, then HLS manifest stitching (`/api/v1/hls` init segment plus ordered `/api/v1/hls-seg` media segments).
- JSON/HLS manifests are rejected as audio; partial HLS output is unlinked on failure.
- ffprobe validates decoded duration against metadata (tolerance 8 seconds); ffmpeg transcodes valid input to MP3 and output duration is used for Telegram metadata.
- Old file_id cache entries without the `audio-v2` validation marker are invalidated.

Reproduced complete progressive track:

```sh
node -e 'const sc=require("./src/services/soundcloud"); ... sc.downloadFile("256257257",...); ffprobe ...'
```

Observed: `via stream`, 5,865,884 bytes, decoded duration `290.366440` seconds for metadata `290` seconds. ✅

Other validated full track: `sid=2413206960`, metadata 218.622 sec; direct stream contained AAC audio and ffmpeg MP3 output decoded to 218.671 sec. ✅

A 619-second HLS-only source (`sid=2281224671`) was identified and fetch was started, but the run was interrupted before completion. HLS full-length verification remains **not confirmed**; no green claim is made for that case. The 82-minute track exceeds the 48MB upload budget and must be rejected cleanly rather than sent as partial audio.

## B2 — groups

- Confirmed Telegram bot privacy field earlier: `can_read_all_group_messages=false`. Telegram does not deliver arbitrary group text in privacy mode; code cannot override that setting.
- Bot now processes `/music`, `/find`, mention, and replies to bot; random unrelated chatter remains silent.
- Added `/diag` for group admins showing bot membership status, visible-message limitation, smart-detect state and topic id.
- Live synthetic `/diag` webhook update returned HTTP 200. Ordinary arbitrary group text cannot be verified until BotFather privacy is disabled; this is documented as an external prerequisite.

## B3 — inline audio, not bot deep link

- Replaced inline article/deep-link result with `InlineQueryResultAudio` using signed `/m/<token>.mp3`; cached validated `file_id` uses cached audio result.
- Proxy HMAC token verified; HEAD returned HTTP 200 and `Accept-Ranges: bytes`. Range request returned data from the upstream stream.
- Actual Telegram inline client selection cannot be simulated by webhook fixture; manual owner test is required.

## B4 — Instagram in inline mode

- Added inline URL recognition + `InlineQueryResultVideo` proxy URL and music callback.
- Callback recognizes the resolved video and sends matched audio to the user’s private chat. If user has not started the bot, callback fallback uses a start deep-link.
- Actual inline client insertion/button behavior requires manual Telegram client validation; schema path exists but remains pending manual test.

## B5 — Instagram URLs in bot chat

- Instagram is routed before text search; tracker parameters are stripped (`igsh`, `dlrf`, `utm_*`) via `cleanUrl()`.
- Resolved video item is selected before preview/image variants; music controls attach to the actual `sendVideo` message. Still images are sent as photos. No separate thumbnail card is sent for a video.
- Live public image fixture resolved and media delivery synthetic webhook returned 200. Upstream worker OpenAPI documents posts/reels/IGTV but not stories; story URL syntax is accepted, but actual story resolution remains upstream-dependent.

## B6 — `/start` stale panel

- Panel state now keyed by `chat_id + message_id`, each message owns a stack.
- `/start` calls `freshMenu()` which clears old navigation state and sends a new menu.
- Live `/start` synthetic webhook returned HTTP 200. Callback race/stale-panel behavior has unit coverage only; real client manual check remains useful.

## B7 — location

```sh
grep -RniE 'sendLocation|request_location|KeyboardButton.*location' src
```

Observed no location request or read in the cPanel app source. ✅

## B8 — no mode-select menu

Main menu has no search/recognize/Instagram mode buttons; input type is auto-routed. ✅

## B9 — UI/admin

Clean new welcome, add-group/channel buttons, admin dashboard, per-feature switches, multi-channel forced join, `/admin` owner command. `/diag` group-admin command. Live synthetic `/admin`, feature screen and gate list returned HTTP 200. Real screen layout still needs visual owner review.

## B10 — direct delivery

- Search list callback uses `pick:<sid>` → `runDownload()` to current `chat_id`; `/start t_<sid>` also sends the file.
- Inline audio uses audio result/proxy rather than article deeplink.
- Live synthetic selected-track callback returned HTTP 200; worker API download verified a complete progressive track. ✅

## B11 — news channel

Channel post includes cover, clean caption, buttons, and 30-second audio demo sent as `sendVoice` reply when ffmpeg can produce the sample. Live real channel test from earlier run was posted then deleted; this pass did not repeat a public channel post to avoid redundant live content.

## Latest aggregate tests

- Node app: 11 tests passing.
- Worker repo before cPanel-app branch: 53 Vitest + 19 E2E passing; lint and secret scan passing.
- Live synthetic webhook: /start, text, selected audio, lyrics, Instagram tracker URL, inline query, /admin, /diag all returned 200.
- `/health`: `ok:true`, RSS ~79MB after restart.

## Round 3 — R1..R5

### R1 inline ❗ → verified root cause + fix
- Root cause: `PUBLIC_URL` was `https://DevCoder.ir/music` but the cPanel Passenger app mounts at domain root. Inline `audio_url`/`video_url` pointed at `/m/...` under `/music` → 404. Reproduced: `HEAD /music/m/<token>.mp3` → 404; `/m/<token>.mp3` → 200. ✅
- Fix: `config.publicUrl` now derives the origin (or `PUBLIC_BASE_URL` when mounted under a path), so generated inline URLs always hit the live mount. ✅
- Second root cause: proxy used to forward to SoundCloud `/stream`, which returns HLS manifest/413 for some tracks → Telegram got invalid content. Now the proxy serves **validated local files** from `mediaCache` (LRU disk cache, TTL, size cap), with proper HEAD/GET/Range(206)/Content-Length/Accept-Ranges/Content-Disposition. Verified: HEAD 200, GET 200, Range 206. ✅
- Cache-eviction race found: LRU evicted the hot file between HEAD and GET because reads never refreshed mtime → updated mtime on every `cached()` hit. ✅
- Stale-production-app issue: `touch tmp/restart.txt` reload required before the proxy would serve cache hits (Passenger holds the process). ✅

### R2 12-second silent audio → verified root cause + fix
- Root cause (forensics): tracks with `hasMp3:false && hasProgressive:false && hasHls:true` are **DRM/CENC-encrypted AAC** (`Incorrect number of samples in encryption info`). ffprobe/ffmpeg cannot decode past the init segment → Telegram showed a short silent file while the duration label came from metadata. Reproduced on `Reza Bahram - Yar` (sid 2231629814): via stream, encrypted:true, valid:false. ✅
- Fix: `isPlayable()` prefers real mp3/progressive; `isEncryptedOrUndecodable()` (ffprobe signal) rejects encrypted/undecodable; RMS checks at 3 points reject silent audio; duration must match metadata ±3s; `tryAlternate()` auto-selects the next *playable* result for the same artist/title. ✅
- Verified playable alternates: `Cancel Majid Kharatha` → 221s valid; `Short MP3 progressive` → 175s valid; `Long HLS 619s` → HLS stitched 619s valid (7.5MB). ✅
- Stale `file_id` cache: migrated + versioned (`audio-v3-validated-rms`); only validated file_ids are reused/cached. ✅

### R3 wrong artist metadata + messy labels
- New `src/services/trackMeta.js` `cleanTrackMeta(raw)` returns `{artist,title,version,isRemix,confidence}`: prefers publisher metadata → `A - B` pattern (artist/title order, alias-index tie-break) → `X by Y`/`از` → `feat.` → alias index → uploader (low-confidence fallback). Strips noise (mp3/kbps/official/audio/lyrics/Persian fillers) and extracts version (ریمیکس شاد/remix/live/etc). Handles Persian word boundaries (\b fails on RTL). ✅
- Uniform labels via `card()` = `⁨artist⁩ ⁨—⁩ ⁨title⁩ · ⁨mm:ss⁩` with bidi isolates; Persian RTL-safe. ✅

### R4 text/lyrics search failed → search engine
- `src/services/searchEngine.js`: intent analysis (short name / artist+song / lyric-line / too-long), variant fan-out (normalized, stopword-stripped, alias, transliterated — parallel, cap 3), merge/dedupe by sid, hybrid ranking (similarity + playable bonus + popularity + remix/duration penalties).
- Lyrics path: Shazam `POST /api/v1/search` with `lyrics:true` → mapped to SoundCloud for the file.
- Explicit empty vs service-error distinction: errors → "⚠️ سرویس موقتاً در دسترس نیست" (retry/cache), empty → "چیزی پیدا نشد" (lyrics → offer voice recognition). ✅
- Learning: `search_learning` map (normalized query → chosen track) boosts repeat accuracy. ✅

### R5 buttons/UI
- Green `G` only for primary actions (download/confirm/add); blue `B` for navigation/selection; red `R` for back/close/delete. Removed unsupported `style` field (Telegram core docs don't expose it) — semantic color helpers retained as emoji. ✅
- Pagination `⬅️ | ۱/۴ | ➡️` single blue row; back `↩️ بازگشت`; confidence `🎯 اطمینان: n٪`; captions use cleaned meta (artist not uploader). ✅

### Inline media cache (B3/B4/B5 follow-through)
- `src/services/mediaCache.js`: bounded disk LRU (TTL + size cap), per-key locks, worker-pool cap (3), validates via `buildValidatedAudio` (download → ffprobe+duration+RMS → mp3), serves via `/m/` `/v/` signed proxies. Warm-ahead on every search result set (top 3). ✅
- Inline Instagram: `InlineQueryResultVideo` uses locally-prepared mp4 (faststart) + real thumbnail + music callback; photo items use `InlineQueryResultPhoto`. ✅

## Verified live on host (this round)
- `/start` fresh menu, search → results, `pick:` → direct audio, insta link → media+buttons, `/diag` group, `/admin` dashboard, lyrics-text trigger — all HTTP 200.
- Signed `/m/` proxy: HEAD 200, GET 200 (476935B mp3), Range 206 (1001B) — all real Telegram-fetchable.
- npm test: 18/18 pass. `npm audit --omit=dev`: 0 vulns.
