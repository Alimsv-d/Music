# QA checklist — 2026-10-26

Status legend: ✅ verified with evidence · ⚠️ partial/blocked · ☐ not done

## Pipeline
- ✅ No media bytes written to disk on send paths (soundcloud fetchBuffer /
  fetchHlsBuffer / fetchTrackBuffer; instagram fetchBuffer; ffmpeg only via
  pipes). `node --check` + grep clean.
- ✅ **F1 root cause fixed**: send bytes were fragmented MP4 (34 moof/sidx). Now
  `normalizeAudio` remuxes to a progressive MP4 in memory (mp4remux) or mp3
  fallback; verified progressive + correct duration (333s) + ©nam/©ART tags.
- ⚠️ file_id "verified by duration" claims were based on Telegram echoing the
  input `duration` — NOT a real content check. Now gated on `mp4check` structure;
  the echo-comparison is kept only as a cheap regression guard.
- ⚠️ HLS long tracks (>379s) still stitched in memory; live ≥48MB send unverified.
- ✅ Encrypted/undeliverable results filtered via isPlayable + check=1 mode.
- ✅ mediaCache disk cache + pre-warming + RMS removed.

## Groups
- ✅ /start & /help answer in groups (were silent).
- ✅ artist-only / ambiguous text in groups → result card (F6: no auto-direct).
- ✅ stale negative-cache key invalidated (neg2:).
- ✅ webhook allowed_updates includes edited_message + chosen_inline_result.
- ⚠️ real Telegram delivery to Checker verified only via webhook-accepted
  synthetic updates + no-drop logging (client-side view still recommended).

## Inline
- ✅ results use cached `file_id` or signed `/m/` proxy streaming worker bytes
  as audio/mpeg; only playable tracks; no "preparing" placeholder.
- ⚠️ live client selection unverified (needs a second Telegram client).

## Instagram
- ✅ resolve → sendVideo/sendPhoto by worker URL (≤20MB) or memory relay (≤48MB);
  music button → ffmpeg-pipe PCM → signature recognize → SC match → send.
- ⚠️ worker `resolve` 404s ALL public URLs (E_PRIVATE_OR_NOT_FOUND) — owner fix.

## Shazam
- ✅ recognize accepts WAV or precomputed signature; fingerprint in worker
  threads; WAV path verified found:true (~1.8s).

## Perf / reliability
- ✅ event-loop delay monitor + per-stage timings + owner /perf.
- ✅ webhook watchdog (5min) re-sets on drift/error + owner alert.
- ✅ startup self-test + uncaughtException/unhandledRejection guards.

## Referral
- ✅ codes/links, evaluate (self/dup/not-new/rate-cap→held), maybeVerify on
  first use, points/tiers, /invite /top, menu button. 5/5 unit tests.

## Quality gates — 2026-10-26 update
- ✅ `npm test` 38/38 · `node --check` changed files · `npm audit --omit=dev`
  reports 0 vulnerabilities.
- ✅ E2E helpers: gitignored `tools/e2e`, hidden credentials, restricted
  destinations, no session/token output, `logout.js` removes local test
  credentials after calling Telegram logout when a session exists.
- ✅ Group links: supported Instagram/SoundCloud links are processed without
  reply/mention and bounded per user/chat; ordinary chatter remains filtered.
- ✅ Direct-vs-list: exact artist/title intent only (score >=0.92, >=0.15 gap,
  non-artist token); ambiguous or artist-only queries return a results panel.
- ✅ Group result panels are requester-owned and expire after 10 minutes.
- ✅ `file_id` reuse verifies Telegram-returned duration against API duration
  before trusting the cache.
- ✅ Channel policy defaults: 3 posts/day, 3-hour gap, Tehran 01:00-08:00 quiet
  hours, preview mode, queue and publish-now admin controls.
- ⚠️ Live Telegram E2E/channel verification is still blocked until the owner
  completes `node tools/e2e/login.js` and `data/e2e.session` exists.
