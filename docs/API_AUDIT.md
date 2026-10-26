# API Audit — live web services (2026-10-26)

All numbers measured on this host with `curl`/`time` and real calls. No secrets shown.

## SoundCloud worker `https://soundcloud-worker.alighost5920.workers.dev`

OpenAPI 3.0.3 served at `/openapi.json` (200, ~0.12s). Endpoints:
`/api/v1/search`, `/track`, `/stream`, `/download`, `/hls`, `/hls-seg`,
`/resolve`, `/cover`, `/health`, plus legacy aliases.

| Endpoint | Result | Notes |
|---|---|---|
| `/health` | 200 ~0.1s | `?deep=1` probes upstream |
| `search?q&page&lang` | 200, ttfb ~0.6s, 24/page | returns `id,sid,title,artist,duration_ms,cover,genre,streamable,downloadable,hasProgressive,hasHls` |
| `track?id` | 200 | adds transcodings |
| `download?id&check=1` | 200 ~0.9s | `{ok,mode,ext,segments,dur_sec,size,hls,subrequest_limit}` |
| `download?id` | 200, single file, ~2s/4MB | `mode=direct` returns assembled m4a |
| `stream?id` | 200, `audio/mp4`, ~2–4s | same assembled file, better content-type |
| `hls?id` | 200 | m3u8, `#EXT-X-MAP` init + N segs, all proxied via `/hls-seg` |
| `resolve?url` | 200 | track object |

### Decisive finding — catalog is 100% HLS
Across 4 queries (fa+en, ~96 results) **every** track reports
`hasProgressive:false, hasHls:true`. There is **no progressive-MP3 category**.
The worker's `/download` and `/stream` endpoints already assemble the fMP4/m4a
server-side, so a *single* HTTP GET yields a complete file.

`check=1` `mode` values:
- `mode:"direct"` → `dur_sec ≤ 379` → `download`/`stream` return one m4a (ftyp `iso5`).
- `mode:"browser"` → `dur_sec > 379` → returns JSON `{mode:"browser",...,"detail":"use /api/v1/hls + /hls-seg"}`; the manifest + `/hls-seg` must be stitched client-side.
- `mode:"browser"` also returned for `TRACK_TOO_LONG` (max_direct_seconds 379) and `NOT_DOWNLOADABLE` (some tracks reject `check=1` with `ok:false` — see below).

### Headers / limits (measured)
- `/download` → `content-type: application/octet-stream`, `Content-Disposition: attachment; filename="*.m4a"`, **no `Accept-Ranges`** (a `Range:` request returned `200` and ignored the range). `/stream` → `content-type: audio/mp4`, same body, also ignores Range.
- No `Content-Length` cap issues seen up to ~6.5MB; `subrequest_limit:45` governs client segment fan-out.
- Sizes seen: 2.4–6.5MB for 200–290s tracks (~1.3–2MB/min at 160kbps AAC).

## Telegram sendAudio — verified
- **By URL** (`sendAudio&audio=<worker /stream URL>`): accepted, returns **`document`**
  (`mime_type audio/mp4`, `file_name stream.m4a`), **NOT `audio`** → no seek-bar /
  no `audio.duration`. Telegram uses the `Content-Disposition` filename/mime.
- **By upload** (m4a bytes, `filename=*.mp3`, `type=audio/mpeg`): returns a real
  **`audio`** object with correct `duration` (205s vs API 205s) and `file_id` →
  seek-bar + duration verification work.

**Conclusion:** m4a is a valid audio container; only the filename/mime decides
document-vs-audio. ⇒ pipeline relays bytes **in memory** and uploads as `.mp3`.

## Instagram worker `https://insta-worker.alighost5920.workers.dev`
- `/openapi.json` → 200, OpenAPI 3.0.3 (nested under `data`). Endpoints:
  `/api/v1/resolve?url` (ETag/304), `/api/v1/download?url&quality&index&inline`.
- **DEFECT:** every tested public URL (3 reels/posts incl. `reel/Dai1eHIAfLI`)
  returns `404 E_PRIVATE_OR_NOT_FOUND` (~3–6s). Upstream session appears dead →
  resolver is effectively down. **Owner must fix the IG worker.**
- `/download` streams a variant once `resolve` succeeds (unverified — resolve fails first).

## Shazam worker `https://shazam-worker.alighost5920.workers.dev`
- `/health` → `backend_configured:false`; `signature.algorithm=shazam-signature-v1`,
  `sample_rate 16000`, `max_seconds 12`, `audio_upload:true` (WAV only), `fingerprint:true`.
- `POST /api/v1/recognize` (multipart `audio=`):
  - m4a → `415 E_UNSUPPORTED_FORMAT` ("only WAV natively; send fingerprint").
  - WAV 16k/mono/12s → **200, found:true** (~1.8s) → matched a track.
  - `{signature}` path (fingerprint computed in `worker_threads`) also supported.
- `POST /api/v1/search` `{query}` → 200, `found:true`, real artist/title list (~0.5s).
- `/api/v1/lyrics` exists; `400 E_MISSING_INPUT` without query.

## Track classification (cheap rule — no ffmpeg)
Usable signals: `check=1.mode`, `downloadable`, `streamable`, `dur_sec`, `size`.
- **A — direct (single GET):** `check.ok && mode=="direct"` ⇒ `/stream?id=` one m4a.
- **B — stitch (segment concat):** `check.ok && mode=="browser"` ⇒ `/hls` + `/hls-seg`, concat in memory.
- **C — not offered:** `check.ok==false` (`NOT_DOWNLOADABLE`/`TRACK_TOO_LONG`>cap) or
  `streamable==false && downloadable==false`.
Note: a non-empty `check` result costs one ~0.9s call; fall back to
`downloadable||streamable` then verify on send.

## Service defects to report to owner (not bot bugs)
1. **IG worker dead** — `resolve` 404s every public URL (session/upstream broken).
2. **SC `/download` & `/stream` ignore `Range`** and serve `application/octet-stream` +
   `*.m4a` filename → Telegram URL-sends land as `document`, not `audio`. Serving
   `audio/mpeg`+`.mp3` filename, or honoring Range, would enable true URL sendAudio.
3. **SC has no progressive-mp3** — everything is HLS; `mode`/`dur_sec` are the only
   reliable selectors (the `hasProgressive`/`hasMp3` flags are always false/absent).
4. **Shazam `recognize` rejects m4a** (`backend_configured:false`); requires WAV or a
   client-computed signature — bot must convert via ffmpeg pipe (allowed for sampling).
