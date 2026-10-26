# E2E report — 2026-10-26

| Scenario | Input | Observed result | Response time | Status |
|---|---|---|---:|---|
| Private `/start` | `/start` | Not executed — no `data/e2e.session` | — | Pending |
| Exact private query | `سقوط داریوش اقبالی` | Direct-send gate implemented; live result not verified | — | Pending |
| Artist-only queries | `داریوش اقبالی`, `گوگوش` | Results panel implemented; live result not verified | — | Pending |
| Recognition media | voice/mp3/video | ffmpeg pipe path exists; live result not verified | — | Pending |
| Instagram reel private | sample reel | upstream resolver previously 404; live result not verified | — | Pending |
| Checker group | reel link, song queries, `/diag` | supported-link handling updated; live result not verified | — | Pending |
| Inline | `@bot داریوش اقبالی` | cached/proxy result path exists; live result not verified | — | Pending |
| Force join | non-owner leave/join | code path exists; live result not verified | — | Pending |
| Referral | E2E reset + new user | `debug_reset` exists only with `E2E_MODE=1`; live result not verified | — | Pending |
| Channel | post verification | publish policy implemented; live post not made without confirmed session | — | Pending |

No Telegram-account E2E was claimed without `data/e2e.session` and a real
Telegram API response. `.env.e2e` contents were not read, printed, or copied.
