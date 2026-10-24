# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] — 2026-10-24

### Added
- Full Telegram music bot on Cloudflare Workers (webhook-only).
- Smart text search: artist-only → popular tracks (10/page), "Artist – Title"
  high-confidence direct delivery, fuzzy matching with Persian/Arabic
  normalization, KV-backed paginated result sets (`act:id:page` ≤ 64 bytes).
- Track delivery via `sendAudio` with caption, artwork metadata, file_id
  caching in KV for instant resends, and auto-lyrics (Shazam → LRCLIB).
- Inline mode: `@bot <query>` returns `InlineQueryResultAudio` /
  `InlineQueryResultCachedAudio`, signed `/dl/<sig>` MP3 proxy with HTTP Range.
- Recognition: voice/audio/video → Shazam service; lyrics-snippet text search.
- Instagram reel/post: media download + background audio recognition that
  patches a "🎵 Artist – Title" button onto the message.
- Group support: `/music`, `/find` reply, `/settings` toggles, forced-join.
- Owner/admin panel: stats, forced-join channels, broadcast (cron-chained),
  ban/unban, live settings, webhook/tools, CSV export, error log.
- Reliability: webhook secret verification, update dedupe, cron webhook
  watchdog, KV rate limiting, central 429/403 handling, fail-open join check.
- i18n fa/en in a single file; Persian RTL-first UI.
- Tests: 49 unit tests (vitest), worker-level e2e harness, live API checker.
- GitHub Actions deploy (private-repo friendly), bootstrap.sh, secret scan.

### Notes / limits
- SoundCloud backend serves m4a (audio/mp4) — sent as `.m4a` audio.
- OGG-Opus recognition requires an ffmpeg backend (`SHAZAM_BACKEND_URL`);
  without it, voice/video recognition degrades gracefully.
