# AUDIT — Music bot (live cPanel Node app)

## Critical
- **B1 audio**: `/api/v1/download` returns an HLS *manifest* (`mode:"browser"`, `use /api/v1/hls`) or an error for many tracks — never raw audio. The bot then falls back to `/api/v1/stream`, which for **streamable (progressive) tracks** returns a complete m4a/mp3 but for **HLS-only / encrypted tracks** returns a short or unusable blob. Result: 12-second silent file with wrong metadata duration. Root cause to confirm per-track and fix by selecting `hasProgressive`/`hasMp3`/`downloadable` tracks and validating real duration via ffmpeg before send.
- **B6 panel**: `/start` reuses/edits the first panel message (msgId persisted per user) instead of sending a fresh menu; back-stack confusion → broken keyboards. Needs per-message nav model + fresh /start.
- **B2 group**: privacy mode (`can_read_all_group_messages=false`) means arbitrary group text never reaches the bot. Only commands/mentions/replies/topics work — must harden those paths and document `/setprivacy`. Add `/diag`.
- **B3/B4 inline**: previous inline returns articles/deep-links. Must return real media (InlineQueryResultAudio/Video) via signed proxy `/m/` `/v/`.
- **B5 insta-in-bot**: Instagram URL was being searched as text → "not found". Must route through provider resolve→download→send + music button.

## Important
- **B7**: ensure no location usage anywhere (spec says none exists; verify + document).
- **B8**: remove mode-select buttons; auto-detect input.
- **B10**: no deep-link-to-bot for file delivery; send file directly.
- **B9**: UI/typography polish; `src/core/fmt.js` markdown-like → Telegram HTML.
- **file_id cache**: persistently stores unvalidated IDs → must invalidate (cache version).

## Minor
- Dead/unused files in cPanel app: `src/services/insta.js`, `src/services/lyrics.js`, `src/services/track.js`, `src/worker.js` (worker source kept for CF but not used by Node app).
- No location request exists — confirmed.
- Admin panel needs professional dashboard + feature toggles + health.

## Security/perf
- Never log Telegram file URLs (they embed the token); always download bytes.
- Webhook secret + cron secret enforced; SSRF allowlist on service domains.
- Rate-limit token bucket + circuit breaker per service; per-chat ordered queue; ack<100ms.
