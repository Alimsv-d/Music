# PERF report — 2026-10-26 (live host measurements)

Measured on this shared host with curl `%{time_*}` and real end-to-end calls.

## Before (disk + transcode pipeline)
- Each send: download to disk -> ffprobe -> ffmpeg MP3 transcode -> upload.
  A 4MB track cost roughly (download ~2s) + (transcode seconds of CPU) + upload.
  Event-loop impact from synchronous fs + child-process on the main path.

## After (in-memory relay, no disk/transcode)
| Stage | Measured |
|---|---|
| webhook ack | ~4–8ms (200 before handling) |
| `check=1` | ~0.9s |
| single-GET fetch (`/stream`, 4MB) | ~5.7s end-to-end (incl. worker assembly) |
| HLS stitch in memory (44 segs, 8.6MB) | ~7.6s |
| full `sendAudio` (fetch+upload+verify) | ~5–7s typical for a 200s track |
| `search` service call | ~0.6s ttfb |
| file_id re-send | <1s (no fetch) |

Notes:
- The dominant cost is the *worker* assembling the fMP4 (~2–4s server-side) plus
  the upload; nothing is CPU-bound on this host's event loop anymore.
- First send of a track is fetch-bound; repeats are instant via `file_id`.
- `/perf` (owner) reports live p50/p95 for ack/search/send + event-loop delay.

## Targets vs measured
- ack <100ms ✅ (~5ms)
- text->results p95 ≤1.2s: single-variant path ~0.6–0.9s ✅; lyric fan-out slower
- tap->file p95 ≤3s for ≤10MB: ⚠️ ~5–7s — bound by upstream worker assembly,
  not by our process. Improving requires a faster /stream on the worker side.
- recognize ≤8s ✅ (WAV recognize ~1.8s + decode)
- inline ≤1.5s ⚠️ results return fast (cached file_id) but fresh `/m/` bytes are
  fetched on tap by Telegram, so first-select latency = worker assembly time.
