# PROGRESS — Music bot professional overhaul

Track: live cPanel Node app (`~/music`, branch `cpanel-app`). GitHub `Alimsv-d/Music` main = Cloudflare worker (separate, already pushed).

- [x] Phase 0: inventory + runtime verification
- [x] B1 audio integrity: root cause reproduced; HLS stitching + progressive fallback + validation + MP3 duration; long HLS >48MB rejects safely. One 619s test was interrupted and remains explicitly unverified.
- [x] B6 panel model (/start new message, per-message nav stack)
- [x] B2 group operation + /diag (privacy mode external prerequisite)
- [x] B3 inline -> InlineQueryResultAudio via signed proxy /m/
- [x] B4 inline Instagram -> video result + music callback path (manual Telegram client test pending)
- [x] B5/B8 auto-detect flows; Instagram tracker-strip; actual media gets controls
- [x] B10 direct audio (no deep-link redirects)
- [x] B9 text/UI polish + fmt.js markup + admin dashboard/toggles
- [x] B7 no location usage (verified)
- [x] B11 channel posts cover/caption/buttons/voice demo
- [x] gates (force-join multi-channel)
- [x] admin panel dashboard, toggles, health, tickets, `/admin`, `/diag`
- [x] i18n parity
- [x] final local/live regression, secret scan, npm audit
- [x] push: `cpanel-app` branch at `9a0232c`; worker `main` at `4b90fb8`
- [x] manual Telegram inline client test; full 200-load test; complete 619s HLS under upload budget
- [x] R1 canonical public base + local validated media cache for inline (HEAD/GET/Range verified)
- [x] R2 encrypted-source detection + auto-alternate + RMS validation (forensics documented)
- [x] R3 cleanTrackMeta (artist not uploader) + uniform bidi labels
- [x] R4 search engine (variants/ranking/lyrics/error-vs-empty/learning)
- [x] R5 button color semantics + UI polish
- [x] 2026-10-26: Inspected current cpanel-app and `main`; created local backup tags for both branch tips before changes.
- [x] 2026-10-26: Local edits started for centralized inline button styles, narrow Telegram rejection fallback, known-artist-before-uploader parsing, Persian start/result labels.
- [ ] Live Bot API style payload, keyboard snapshots, owner-chat test, metadata golden fixtures, real inline selection, HLS/Instagram/channel E2E, final 200-update load test, audit, repo visibility/history scan, pushes, and Cloudflare build/deploy evidence remain unverified.

- [ ] 2026-10-26 requested live-app pass: group routing/diagnostics, all-entry force-join, result-list UX, clean audio metadata, Instagram background recognition, lyric search evaluation, and inline readiness.
- [x] 2026-10-26: Central middleware force-join, bounded membership cache, membership-update invalidation, group diagnostics/drop logging, `/gatetest`, title-only result buttons, clean ID3 metadata/cache version, lyric windows/verification, background inline warm-up, and manual test documents implemented.
- [x] 2026-10-26: `node --check`, `npm test` (20/20), `git diff --check`, and `npm audit --omit=dev` passed after the implementation.
- [x] 2026-10-26: Live Bot API evidence: `getWebhookInfo` returned pending `0` and allowed updates included `my_chat_member`/`chat_member`; `getChatMember(@MusicMsvD, owner)` returned `status=creator`.
- [x] 2026-10-26: Checker API evidence: bot is `administrator` with `can_delete_messages=true`; direct `sendMessage` succeeded with message id `1263`; synthetic supergroup/topic `/diag` fixtures were accepted by the test harness.
- [ ] Live Checker messages, non-member account, real media metadata, reel recognition, 15-line lyric corpus, inline client selection, and push remain unverified.
- [x] 2026-10-26: Reel resolver evidence recorded: `Dai1eHIAfLI` returned `E_PRIVATE_OR_NOT_FOUND`/404; no false recognition result was recorded.


## 2026-10-26 — direct-send overhaul (this session)
- [x] Phase A audit: docs/API_AUDIT.md. Catalog is 100% HLS; /stream & /download
      assemble one m4a for direct mode; browser mode -> /hls + /hls-seg.
      Telegram URL-sends m4a as document; uploading as .mp3 returns real audio.
      IG worker is down (resolve 404s all public URLs); Shazam needs WAV/signature.
- [x] Phase B: in-memory send pipeline (fetchTrackBuffer: stream/download single
      GET, HLS parallel-stitch <=48MB). No disk, no transcode, no ffprobe/RMS.
      file_id cached only after Telegram-returned duration +-3s. mediaCache removed.
- [x] Phase C: perf.js (event-loop monitor, stage timings, /perf). E2E verified:
      private+group synthetic updates -> file_id cached via 'stream' in ~5-7s.
- [x] Phase D: group /start & /help respond; smartDetect uses searchEngine
      ranking, artist-only >=0.75 direct-send + more button; negcache v2. Webhook
      allowed_updates += edited_message + chosen_inline_result.
- [x] Phase E: results panel (query heading, title-only buttons, pagination,
      pop/new filter, close), audio buttons (more-by-artist, share), recog card.
- [x] Phase F: IG send by URL (<=20MB) or memory relay (<=48MB); recognition via
      ffmpeg-pipe PCM -> signature. IG worker itself is down (owner to fix).
- [x] Phase G: referral core (codes, evaluate, maybeVerify, anti-fraud, tiers,
      /invite /top, menu). Unit-tested 5/5.
- [x] Phase H: webhook watchdog (5min), startup self-test, crash guards,
      shared/heavy facade, cf_readiness test, ALWAYS_ON + CLOUDFLARE_READINESS.
- [ ] Live client-side verification of group replies & inline selection; real
      reel resolve (blocked on dead IG worker); owner manual steps.
- [x] chosen_inline_result handler (stats + learned boost for picked track)
- [x] referral owner panel (/admin -> 👥 دعوت‌ها): toggle, status counts, held
      queue approve/reject, CSV export
- [x] bidi-js devDependency + visual-order snapshot tests (4) — panel/label RTL
      order locked
- [x] live evidence: group `/music googoosh` -> file_id hit, stats++ (no refetch);
      group smartDetect earlier produced a verified send for an artist query

## 2026-10-26 — requested verification pass
- [x] E2E helper safety reviewed: `tools/e2e` remains gitignored; strict
      destination allowlist, hidden credential prompts, no secret output, and
      logout cleanup are in place. No `.env.e2e` or session contents were read.
- [x] Local unit/regression suite now passes 38/38; `node --check` covers the
      changed application and E2E helper files; `npm audit --omit=dev` reports
      zero production vulnerabilities.
- [x] Implemented requester-scoped group results, group link-rate limits,
      supported-link auto-handling, safer direct-vs-list gate, `file_id`
      duration revalidation, channel publish policy/status controls, and
      scheduled queue timestamps.
 - [ ] Real Telegram account E2E and channel-post evidence remain pending until
      `data/e2e.session` is produced by `node tools/e2e/login.js`; no live
      result is claimed without that session/API evidence.

## 2026-10-26 — root-cause overhaul (Phase 1)
- [x] F1 root cause CONFIRMED with evidence. Bytes sent for «سقوط – داریوش
      اقبالی» (sid 76587881, API 333s) via `fetchTrackBuffer→stream` are
      **4,067,023 bytes, ffprobe duration 333.47s** — complete, not truncated.
      `mp4check` box tree shows `moof:34, mdat:34, sidx:34, mvex:1` → a
      **fragmented MP4** (one moof+mdat per ~10s HLS/AAC segment). Telegram's
      player reads only the first fragment timeline → ~12s playback. Bytes are
      whole; the container structure is wrong. See docs/AUDIO_ROOT_CAUSE.md.
- [x] Built `src/lib/mp4check.js` — pure-JS in-memory MP4/fMP4 validator
      (box tree, moov-before-mdat, mvhd/mdhd/stts duration vs API ±2s, ©nam/©ART
      tags, fragmentation detection). Verified: source A flags
      `fragmented:true`; ffmpeg `-c copy -movflags +faststart` remux → `ok:true,
      progressive, stts 333.48s`.
- [x] Added owner-only `/audiotest <query|sid>` sending A(current upload),
      B(m4a `-c copy` faststart), C(mp3 libmp3lame), D(URL send) each with an
      mp4check verdict caption. All media in memory; nothing written to disk.
- [x] Added `AUDIO_FORMAT` owner setting (`aset:audio_format`, admin settings
      panel). Default `mp3` pending owner's A/B/C/D playback confirmation.
- [x] F7 RESOLVED: `/api/v1/track` raw `transcodings` for سقوط/Yar/googoosh/
      shadmehr contain ONLY `hls` and `cbc/ctr-encrypted-hls` protocols — there
      is **no `progressive` protocol in the catalog**. `hasProgressive`/`hasMp3`
      flags are correct (false), not buggy. No server-side progressive-MP3 path
      can exist; the fix must be a worker-side progressive-M4A remux or bot-side
      remux (Phase 2/3).
- [x] Built `src/lib/mp4remux.js` — pure-JS in-memory fMP4→progressive MP4
      remuxer (parses moof/traf/tfhd/trun, rewrites mvhd/mdhd/stts/stsz/stsc/stco,
      embeds ©nam/©ART). Verified vs ffmpeg `-c copy +faststart`: identical
      duration 333.473s, all 14362 packets preserved, decodes cleanly to EOF.
- [x] Fixed the mp3-transcode pitfall: fMP4 `tfdt` base-time gaps made ffmpeg
      stretch output to 435s (vs 333s). `transcodeToMp3` now caps with `-t`.
- [x] Phase 3 partial: `send.js` `normalizeAudio()` now runs every send through
      the remuxer (default `audio_format=m4a`, owner-toggleable to `mp3`). Output
      verified: `via=stream+remux`, mp4check ok, progressive, correct tags.
      This is the actual F1 fix on the live path — needs owner /audiotest + a
      live sendAudio to confirm the Telegram player shows full seek bar.

## 2026-10-26 — Phases 4–6 evidence pass
- [x] Phase 4 (Instagram): root cause CONFIRMED with evidence. The worker
      `/health` is 200 (KV bound, breaker closed). Its single upstream
      `catplus.ir/api/insta` returns `404 "Invalid URL or Private Post"` for
      every public URL — an upstream provider outage, NOT a Cloudflare-IP block
      or worker bug. Embed/GraphQL need an authenticated session (disallowed).
      Owner must replace `UPSTREAM_URLS` with a live resolver. Documented in
      DECISIONS. No bot-side change can resolve a dead upstream.
- [x] Phase 5 (recognition): signature vs WAV are equivalent (identical
      results). Clean-sample corpus: 7/7 completed calls returned found:true.
      See docs/RECOGNITION_REPORT.md. Voice/noise corpus pending owner data.
- [x] Phase 6 (group decision): removed the stale "artist-only ≥0.75 → direct
      send" in smartDetect. Unsolicited group detection now always shows a
      compact result card (no auto file); direct file lives only in the
      explicit exact-match path (score ≥0.92, margin ≥0.15, non-artist token).
- [x] F2 corrected: duration-echo on sendAudio is not a content check; real
      structural validation now via mp4check (documented in DECISIONS/QA).

## 2026-10-26 — worker v2 + send-path URL preference
- [x] `SoundCloud-Worker` branch `fix/v2-soundcloud`: new `GET /f/<sid>/<slug>.<ext>`
      endpoint assembles HLS in memory and remuxes to a validated progressive MP4
      (in-worker pure-JS remuxer), returns Content-Length/Accept-Ranges(206)/
      ETag/X-Audio-Verified/X-Audio-Duration-Ms, 413 TOO_LONG_FOR_PLAN over the
      free-plan subrequest budget. Remux verified byte-equivalent to ffmpeg
      `-c copy +faststart` on a real 333s track.
- [x] Deploy workflow gained `env: staging|production` input (staging -> `<name>-staging`).
      No GitHub API token on host (git over SSH) — staging deploy needs owner to
      click "Run workflow" → env=staging on the branch.
- [x] Bot send path now prefers `sendAudio` by worker `/f/…mp3` URL (zero bytes
      through the bot), falls back to in-memory remux+upload. Confirmed prod /f/
      is 404 (not yet deployed) → fallback path verified working (m4a progressive).