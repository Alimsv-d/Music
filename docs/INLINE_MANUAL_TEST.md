# Inline manual test

1. Start the live bot in a private chat and satisfy all configured gates.
2. In any chat, type `@SearcherMusiic_Bot Reza Bahram` and wait for up to eight audio results.
3. Select a result. A cached audio result uses `file_id`; a fresh result uses the signed `/m/` proxy which streams the worker's assembled bytes as `audio/mpeg` (no disk, no "preparing" placeholder). Only playable tracks are offered.
4. Type the cleaned Instagram reel URL inline. The result is a video whose `video_url` points at the worker `/api/v1/download` endpoint with `🎵 تشخیص و دریافت موزیک`; selecting that button fingerprints the reel's audio and sends the matched full track to the user's private chat. (NOTE: the IG worker currently resolves every public URL to 404 E_PRIVATE_OR_NOT_FOUND — verify after it is fixed.)
5. If the bot was not started, confirm Telegram offers the start deep-link.
6. Record the selected result type, response time, audio title/performer, and whether a preparation article appeared. Do not mark this checklist green without a real Telegram client response.
