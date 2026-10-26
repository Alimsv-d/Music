# Audio root cause — the "12-second" playback bug (F1)

## Confirmed mechanism (evidence)

Fetched the exact bytes the bot sends for **«سقوط – داریوش اقبالی»**
(sid 76587881, API duration_ms 333473 → 333s) via `fetchTrackBuffer` → `stream`:

- Size: **4,067,023 bytes** (complete — not truncated)
- `ffprobe format=duration` → **333.47s** (full audio is present)
- `mp4check.check` box tree:

```
counts: { moov:1, mdat:34, moof:34, mvex:1, sidx:34, mehd:0 }
fragmented: true   ok:false   reasons:[fragmented, duration-mismatch]
```

The worker assembles the track by **concatenating fMP4 fragments** (one `moof`+`mdat`
per ~10s HLS/AAC segment, each preceded by `styp`+`sidx`). Result: a **fragmented
MP4**, not a progressive file. Telegram's player reads only the first media
fragment's timeline → ~10–14s shown as playable with a partially-filled seek bar,
even though every byte is present.

## Fix validation (in-memory, no disk on send path)

- **B — progressive M4A** via `ffmpeg -i pipe:0 -c copy -movflags +faststart -f mp4`:
  `mp4check` → `ok:true`, `fragmented:false`, `moovBeforeMdat:true`,
  `stts:333.48s`, box order `ftyp,moov,free,mdat`. Structurally equivalent to a
  proper file. **No re-encode** — bitstream copied.
- **C — MP3** via `libmp3lame -q:a 5` (in-memory): 4,673,150 bytes, `ID3` header,
  `ffprobe duration 333.53s` — full length, correct.
- **D — URL send**: `/stream`/`/download` return `application/octet-stream` +
  `*.m4a` filename and ignore `Range` → Telegram URL-send lands as `document`
  (per API_AUDIT). Documented service defect; not a bot bug.

## Decision

- `AUDIO_FORMAT` default = **`m4a` path requires remux**; since the source is
  fMP4 the only way to a *progressive* file without re-encoding is an in-memory
  `-c copy -movflags +faststart` remux (variant B). If remux is unavailable or
  CPU-constrained, variant C (mp3) is the fallback.
- Forensic checker `src/lib/mp4check.js` rejects fragmented (`moof/mvex/sidx`)
  files and validates mvhd/mdhd/stts duration vs API ±2s.
- Owner compares real playback via `/audiotest <track>` (A/B/C/D) before flipping
  `settings.global.audio_format`.
