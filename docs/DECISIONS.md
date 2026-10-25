# Decisions

- Use plain CommonJS and Node's built-in `http`, `node:sqlite`, and `worker_threads`; only grammY is an external runtime dependency. The configured cPanel runtime is Node 22.23.4 and supports `node:sqlite`.
- Persist application state in `data/store.db` (SQLite WAL); keep the whole `data/` directory ignored and local to the host.
- Build the webhook route from a SHA-256 digest of the webhook secret rather than including any part of the secret in a URL/path.
- Acknowledge webhook requests after reading and validating their bounded JSON body, before scheduling update handling. Serialize each chat's updates and cap global active work at 32.
- SoundCloud track requests require the numeric `sid`, even though search `id` is prefixed `sc_`; always strip that prefix.
- SoundCloud streams are the lawful fallback for tracks without an enabled download endpoint. They are uploaded as temporary Telegram audio and deleted immediately after send.
- The Shazam fingerprint is a direct JavaScript port of the live service's public `/static/fingerprint.js`, executed in a `worker_threads` Worker. PCM input is capped at 12 seconds, mono, 16 kHz.
- The Instagram worker's OpenAPI was nested under `data`; its download endpoint takes the original Instagram post URL, optional `quality`, and `index`, not the CDN media URL.
- Telegram's documented core `InlineKeyboardButton` schema did not expose a stable color/style field in the documentation retrieved during implementation, so buttons use color emojis and do not send speculative `style` fields.
- Locale coverage is deliberately progressive: Persian and English are reviewed; other locale files are marked `reviewed:false` so untranslated/fallback strings are not represented as vetted translations.
- No live Instagram content is inferred: errors from the resolver are reported as unavailable. The upstream resolver rejects most tested public URLs; a single stable public fixture was verified during investigation.
- Do not run real owner-chat E2E, publish/delete a live test post, alter Telegram webhook, or create a GitHub repository without a secure confirmed deployment context and verification that the owner authorizes those external side effects. The current `.env` exists on disk, but its secrets must never be echoed or committed.

- cPanel app mount: the Node app serves at the domain root `https://DevCoder.ir/`, not under `/music`. `PUBLIC_URL` is kept for reference; the live webhook was set to `https://DevCoder.ir/wh/<sha256(secret)>`. `/health` is live at root.
- cPanel `crontab -e` fails on this host because cagefs `/tmp` cannot create `.crontab.lock`. As a fallback the app runs its own 5-minute `setInterval` for scheduled tasks in addition to the external `/cron/<secret>` endpoint.
- grammy's `bot.api.config.use` signature differs across versions; call logging was removed rather than risk a wrong transformer.
- `sendAudio` omits `thumbnail` (URL thumbnails are unreliable); only `title/performer/duration` are set.
- Webhook ack measured ~4.7ms for a single update; under 200-way synthetic concurrency the shared-host server answered all 200s (p95 ~1.1s, dominated by connection queuing, not the ack itself). RSS ~74–95MB, well under the 200MB budget.

## UX redesign (post-feedback)
- Removed mode-select buttons (search/insta/recognize) from the main menu — everything is auto-detected: plain text → search, voice/audio/video → recognize, Instagram URL → auto-download media + 🎵 music button, SoundCloud URL → track card.
- Panel engine rewritten: each interaction edits THE SAME message that was tapped; nav stack keyed by message_id so Back restores the prior screen on that message. No cross-message confusion.
- Instagram: items downloaded & sent directly (video→sendVideo, image→sendPhoto, carousel sequential). A follow-up card offers "🎵 دانلود موزیک" that parses artist/title from caption, searches SoundCloud and sends the audio file directly (full duration, not the inline preview).
- Group & PV: audio is sent directly to the chat via sendAudio (not a deep-link to the bot). Channel deep-links are only used inside channel posts.
- Channel post: redesigned caption (title, artist, jalali+gregorian date, duration, genre, plays, ≤6 hashtags, signature) on the cover photo, URL buttons (download-in-bot / search-more / soundcloud), plus a ~30s demo audio clip (ffmpeg mp3 cut) sent as a reply to the post. Manual `disable_notification` support.
- Admin panel texts and main menu strings made cleaner with emojis; awaiting-state kept only for support tickets & admin inputs.

## Round-2 fixes (user feedback)
- Instagram card now ALWAYS offers a music button: "🎵 شناسایی و دانلود آهنگ" fingerprints the downloaded reel's audio with Shazam → finds the song → downloads it from SoundCloud. A second "🔍 جستجو در ساندکلود" button searches by caption when available.
- Text/lyrics recognition: `/lyrics <query>` and lyric-line text go through the Shazam text-search endpoint (`/api/v1/search`) and can fetch full lyrics via `/api/v1/lyrics`.
- Audio duration fix: downloaded tracks are transcoded to real MP3 (libmp3lame 128k) via ffmpeg before sendAudio, so Telegram shows the correct seek bar + full duration instead of a short preview. Tiny/DRM-encrypted sources (which ffmpeg can't decode) fall back to sending the raw file.
- `/api/v1/download` returns an HLS manifest (mode:"browser") for some tracks → the bot prefers the real file, then `/stream`, then transcodes. DRM/encrypted tracks are a known upstream limitation.
- Force-join is now multi-channel: owner manages a list via 🛠 → ⚙️ → 🔒 عضویت اجباری (add/remove); user must join ALL listed channels.
- Audio messages now carry a clean caption (title, artist, duration/genre/plays).
- Group limitation documented: the bot runs in Telegram privacy mode (`can_read_all_group_messages=false`), so in groups it only sees commands/mentions/replies unless privacy is disabled in BotFather (/setprivacy → Disable). Command/mention/reply paths are verified working.
