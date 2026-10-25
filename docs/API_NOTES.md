# API Notes — live services

All three services are stateless Cloudflare Workers. The bot is only an HTTP client.

## SoundCloud — `SOUNDCLOUD_API_URL`
Base: `https://soundcloud-worker.alighost5920.workers.dev`
Envelope: success `{ok:true, request_id, ...}`; error `{ok:false, request_id, error:{code, message:{fa,en}}}`.

| Endpoint | Params | Notes |
|---|---|---|
| `GET /api/v1/search` | `q` (req), `page` (int), `lang` | `{query,page,count,results[]}` ~24/page. result: `{id:"sc_<sid>", sid, title, artist, duration:"m:ss" (localized digits), duration_ms, cover, page_url, genre, plays, likes, created_at(ISO), streamable, downloadable, hasProgressive, hasHls}` |
| `GET /api/v1/track` | `id` (req) | **id must be numeric sid** (`256257257`), NOT `sc_` prefix → else UPSTREAM_ERROR. returns `{track}` = search result + `description, tag_list, waveform_url, transcodings[]` |
| `GET /api/v1/stream` | `id` | audio proxy, supports Range. content-type e.g. `audio/mp4` |
| `GET /api/v1/download` | `id`, `check` | `check=1` → `{downloadable, size, ...}` else 403 `NOT_DOWNLOADABLE`. GET → file stream. |
| `GET /api/v1/resolve` | `url` | soundcloud.com track URL → `{track}` |
| `GET /api/v1/cover` | `url` | proxied cover image |

Error codes seen: `BAD_REQUEST, NOT_FOUND, RATE_LIMITED, UPSTREAM_ERROR, UPSTREAM_TIMEOUT, PAYLOAD_TOO_LARGE, NOT_DOWNLOADABLE, TRACK_TOO_LONG`.

## Shazam ("Shzm") — `SHAZAM_API_URL`
Base: `https://shazam-worker.alighost5920.workers.dev`
Envelope `{ok,status,lang,request_id,data}`; errors `error.code` = `E_*`.

| Endpoint | Body/Params | Notes |
|---|---|---|
| `POST /api/v1/recognize` | JSON `{signature}` (data URI `data:audio/vnd.shazam.sig;base64,<fp>`) + `samplems` + `lyrics`; **or** `{pcm}` (base64 s16le 16k mono); **or** multipart `file` WAV; **or** raw `audio/wav` | Worker can't compute fingerprint on free plan → bot MUST fingerprint client-side (see src/services/fingerprint.js, ported from `/static/fingerprint.js`). `data`: `{found,artist,title,album,year,genre,confidence,artwork,preview_url,links{},lyrics{available,text}}` |
| `POST /api/v1/recognize/url` | remote media URL | requires worker BACKEND_URL (likely unset) |
| `POST /api/v1/search` | `{query,limit,lyrics}` | text search → `data.results[]`, top fields incl artwork/preview/lyrics |
| `GET /api/v1/lyrics` | `artist`, `title` | `{available,source,text}` |
| `GET /health`, `/api/v1/info` | | |

Fingerprint input: mono 16 kHz, ≤12 s, s16le. Skip center for long files (UI skips to middle when >36s).

## Instagram — `INSTA_API_URL`
Base: `https://insta-worker.alighost5920.workers.dev`
Envelope `{ok,status,lang,request_id,data|error}`; errors `error.code` = `E_*` (E_INVALID_URL, E_PRIVATE_OR_NOT_FOUND, E_RATE_LIMITED...).

| Endpoint | Params | Notes |
|---|---|---|
| `GET /api/v1/resolve` | `url` | public post/reel/IGTV URL only → metadata + media variants |
| `GET /api/v1/download` | variant selector (per resolve) | streams media; max ~80MB |
| `GET /api/v1/thumbnail` | `url` | proxied thumb |
| `GET /health` | | providers + per-route rate limits (resolve 60, download 20, thumb 60) |
