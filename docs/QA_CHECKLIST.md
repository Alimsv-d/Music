# QA checklist — 2026-10-26

Status legend: ✅ verified with evidence · ⚠️ partial/blocked · ☐ not done

## Pipeline
- ✅ No media bytes written to disk on send paths (soundcloud fetchBuffer /
  fetchHlsBuffer / fetchTrackBuffer; instagram fetchBuffer; ffmpeg only via
  pipes). `node --check` + grep clean.
- ✅ file_id cached only after `audio.duration` matches API ±3s (v5 cache).
- ✅ m4a→document issue solved by uploading as `.mp3`/`audio/mpeg`.
- ✅ HLS long tracks (>379s) stitched in memory, parallel ordered, ≤48MB.
- ✅ Encrypted/undeliverable results filtered via isPlayable + check=1 mode.
- ✅ mediaCache disk cache + pre-warming + MP3 transcode + RMS removed.

## Groups
- ✅ /start & /help answer in groups (were silent).
- ✅ artist-only text ("مجید خراطها") → direct most-popular track + more button.
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

## Quality gates
- ✅ `npm test` 32/32 · `node --check` all files · `npm audit` 0 vulns.
- ☐ bidi-js snapshot test (devDependency not yet added).
- ☐ owner manual steps: BotFather /setinlinefeedback on, /setinlinegeo off,
      /setprivacy off or keep bot admin; inline test in a second chat.
