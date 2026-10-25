# QA CHECKLIST

Status legend: ✅ verified with evidence; ⚠️ partial/upstream or manual verification; ⬜ not completed.

## B1–B11 regressions
- [x] B1 root cause reproduced: download JSON manifest + stream 413 for HLS-only track.
- [x] B1 full progressive files validated with ffprobe: 218.671s/metadata 218.622s and 290.366s/metadata 290s.
- [ ] B1 HLS-only >=8-minute source completely stitched and validated end-to-end. 619s test interrupted; do not claim this green.
- [x] B2 `/diag` and explicit group command/mention/reply paths; privacy limitation recorded.
- [x] B3 inline answers audio results using signed `/m/` and cached audio file_id.
- [ ] B3 actual Telegram client inline selection test.
- [x] B4 inline Instagram video result schema + callback path implemented.
- [ ] B4 actual Telegram inline Instagram result/button test.
- [x] B5 Instagram link is routed to resolve, tracker parameters removed, actual media gets controls.
- [ ] Instagram story capability: service OpenAPI does not document stories; real upstream story resolve not confirmed.
- [x] B6 `/start` uses fresh message; navigation keyed by message id.
- [x] B7 source scan confirms no location request/read.
- [x] B8 mode-select buttons removed; auto-detect remains.
- [x] B9 admin dashboard/feature switches/gates and concise welcome added.
- [x] B10 search selection + deep link send file to current private chat; inline audio result does not deep-link.
- [x] B11 cover/caption/action buttons + voice demo fallback implemented.

## Operational/security
- [x] 11 cPanel Node unit tests pass.
- [x] 53 worker Vitest tests pass.
- [x] 19 worker E2E tests pass.
- [x] Worker lint and secret scan pass.
- [x] cPanel `node --check` of changed Node files.
- [x] cPanel app `/health` healthy after restart; RSS ~79MB.
- [x] Webhook synthetic update responds HTTP 200; `getWebhookInfo` old last-error timestamp predates restart, pending count 0.
- [x] New cPanel app commit pushed to private repo branch `cpanel-app`; worker `main` remains separate.
- [ ] Full 200-update host load test after latest code changes.
- [ ] `npm audit` on host dependencies.
- [ ] Verify repo visibility is private using GitHub API / `gh` (not available on this host).
- [ ] Full historical secret scan / history rewrite (not performed; do not rewrite shared repo history without explicit backup and review).
