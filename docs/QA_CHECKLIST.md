## Current run (2026-10-26)
- ✅ Branch verified: `cpanel-app`; `main` was not changed.
- ✅ `node --check` for changed source files.
- ✅ `npm test` — 20/20 tests pass.
- ✅ `git diff --check` — clean.
- ✅ `npm audit --omit=dev` — 0 vulnerabilities.
- ✅ Bot API `getWebhookInfo`: webhook active, pending `0`, allowed updates include `message`, `callback_query`, `inline_query`, `my_chat_member`, `chat_member`.
- ✅ `set-webhook.js` response confirmed the expanded allowed-update list.
- ✅ Force-join `getChatMember` live check for owner returned `status=creator`; no non-member account available in this run.
- ✅ Live `sendMessage` to Checker returned `message_id=1263`; `getChatMember` returned bot `administrator`, `can_delete_messages=true`; owner gate check returned `creator`.
- ✅ Signed synthetic webhook `/diag` probes for Checker supergroup and topic were accepted at preparation level; actual Telegram-generated update handling still needs client confirmation.
- ⚠️ Live webhook previously reported HTTP 500; current API response has no active last-error message, but group delivery must still be tested in Telegram.
- ⬜ Owner/group live messages, non-member account, inline selection, real media uploads, and Instagram fixture remain manual.

## Requested features
- ✅ Group routing accepts commands with bot suffix, help text, mentions, replies, short smart-detect candidates, and topics; ordinary long/link chatter stays silent.
- ✅ `/diag` reports bot membership, send permission, latest update, and latest drop reason.
- ✅ Force-join now checks all configured gates, recognizes restricted `is_member`, uses bounded positive/negative cache, invalidates on membership updates, and sends a timed group lock notice.
- ✅ Audio transcode explicitly clears metadata and writes clean title/artist; cache version/key includes metadata.
- ✅ Result buttons contain title only, visual truncation, numbered detail lines, artist heading, duration, duplicate disambiguation, pagination, and red back row.
- ✅ Instagram captions no longer include the back button; existing automatic fingerprint path remains available.
- ✅ Lyric search uses bounded 4–6-word windows and lyrics overlap verification; no success-rate claim without the requested live corpus.
- ⚠️ Inline audio now warms up to eight candidates and uses metadata-keyed cache/proxy URLs; real Telegram client selection remains unverified.

## Existing regression evidence
- ✅ Query, cache, fingerprint, i18n, rate-limit, HTTP, Instagram URL, metadata, keyboard, SoundCloud, and audio-playability tests: 20/20.
- ⚠️ Live Instagram `reel/Dai1eHIAfLI`: resolver returned `E_PRIVATE_OR_NOT_FOUND` (HTTP 404); audio identification could not run.
- ⚠️ Lyric matching runtime fixture confirmed the requested Persian line creates two six-token windows; no validated Shazam lyric result and no ≥15-line success-rate corpus were available, so accuracy is unclaimed.
- ⬜ `/gatetest` live behavior, pending request replay after join, invalid-gate owner panel, Instagram background audio/music button, and signed proxy HEAD/GET wait remain unverified.
