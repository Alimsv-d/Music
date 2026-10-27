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
- **C — MP3** via `libmp3lame -q:a 5` (remuxed progressive input, in-memory):
  owner-confirmed in Telegram: full playback and correct seek bar. ffmpeg decodes
  through **5:33.5** (333.5s); packet timestamps also end at 333.5s. Note: ffprobe's
  MP3 container-duration estimate over a non-seekable pipe reports 7:15.5 from
  average bitrate; that estimate is not the decoded playback duration.
- **D — URL send**: the current `/stream`/`/download` return `application/octet-stream` +
  `*.m4a` filename and ignore `Range` → Telegram URL-send lands as `document`
  (per API_AUDIT). The new worker `/f/` endpoint is not deployed yet.

## Decision

- **Owner selected C (MP3)** after real Telegram playback: full duration, correct
  seek bar, and music header. `AUDIO_FORMAT` default is **`mp3`**; only an explicit
  owner setting of `m4a` selects the progressive-M4A remux path.
- Pipeline order for C: fetch HLS bytes → pure-JS progressive remux →
  `libmp3lame -q:a 5` → multipart upload with `.mp3` filename and explicit
  `title`/`performer`. The progressive remux before encoding avoids fMP4 `tfdt`
  timestamp gaps. No media is written to disk.
- The file_id duration echo is NOT validation (F2); cache acceptance requires
  correct output metadata/container checks. Telegram's returned duration alone
  is not used as proof of file integrity.
- Forensic checker `src/lib/mp4check.js` rejects fragmented (`moof/mvex/sidx`)
  files and validates mvhd/mdhd/stts duration vs API ±2s.
- Variant D remains blocked until worker staging is deployed and URL-send is
  confirmed to return Telegram `audio` (not `document`).
