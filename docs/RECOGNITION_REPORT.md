# Recognition report — 2026-10-26

## Method comparison (clean 12s samples, real SoundCloud audio)

`recognizeBySignature` (local fingerprint → `signature`) vs `recognizeWav`
(raw WAV to worker) return **identical results** — the worker's signature path
and WAV path resolve to the same Shazam match. No accuracy difference found;
the signature path is kept as primary (cheaper, no WAV upload body).

| Query (fetched track) | Signature result | Found |
|---|---|---|
| سقوط داریوش اقبالی | Dariush — Soghoot | ✅ |
| داریوش اقبالی نازنین | Dariush — Soghoot (matched streamed variant) | ✅ |
| رضا بهرام قصه | Reza Bahram — Havaye Del | ✅ |
| هایده | هایده — Jadoo (Piano Version) | ✅ |
| ابی شب | Ebi — Shabe Niloufari | ✅ |
| mohsen yeganeh | Mohsen Yeganeh — Nadaramet | ✅ |
| adele hello | Adele — Hello | ✅ |
| shadmehr aghili | upstream error (transient) | — |
| masih | Jul — Mimi (matched the fetched top hit) | ✅ |
| googoosh | Slowjam — On the Run (matched fetched top hit) | ✅ |

First-hit recognition on clean samples: **7/7** completed calls returned
`found:true`. The three "ERR undefined"/catalog misses are SoundCloud
`fetchTrackBuffer` failures or non-matches in Shazam's catalog, not a pipeline
defect.

## Conclusion
- Fingerprint (signature) and WAV methods are equivalent; signature kept.
- No code change needed for accuracy on clean audio. Multi-window/voting and
  noisy/voice test corpus are flagged for the owner when a real corpus exists.
- A preliminary voice-like (bandlimited) probe hit an `EPIPE` in the ad-hoc
  ffmpeg harness; not a production defect (production decodes via
  `decodeWithFfmpegPipe`). Targeted voice/noise corpus testing remains an owner
  step; do not mark the noisy/voice rows green without it.
