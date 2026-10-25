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
