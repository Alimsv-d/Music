# 🎧 Music — Telegram Music Bot on Cloudflare Workers

> An always-on Telegram bot that **searches, recognizes, and downloads music**.
> Built on Cloudflare Workers + KV, backed by the owner's SoundCloud / Shazam /
> Instagram / LRCLIB services. Persian-first UI with an English option.
>
> **Creator: Ali Mousavi — [@AliMsvD](https://t.me/AliMsvD)**

---

## ✨ Features

| Area | What it does |
|---|---|
| 🔎 Smart search | Artist → top tracks; `Artist – Title` → direct delivery; ambiguous → paginated list (10/page) |
| ⬇️ Delivery | `sendAudio` upload w/ caption + artwork, **file_id cached in KV** → instant resend, auto-lyrics |
| ♾ Inline mode | `@bot <query>` in any chat → audio results via signed `/dl/` proxy |
| 🎙 Recognition | voice / audio / video → Shazam; lyrics-snippet → song |
| 📲 Instagram | reel/post → media + background music recognition button |
| 👪 Groups | `/music`, `/find` reply, `/settings`, forced-join aware |
| 👑 Panel | stats, forced-join, broadcast, ban, settings, webhook tools, CSV export, self-test |
| 🌐 i18n | Persian (default) + English, RTL-friendly |

---

## 🏗 Architecture

```mermaid
flowchart LR
  TG[Telegram] -- webhook + secret --> W[ONE Cloudflare Worker]
  W --> KV[(Cloudflare KV)]
  W --> SC[Bundled SoundCloud routes /svc/sc]
  W --> SHZ[Bundled Shazam routes /svc/shz]
  W --> IG[Bundled Instagram routes /svc/ig]
  W --> LR[LRCLIB]
  W -- direct URL-send --> TG
  Cron[Cron */5min] --> W
```

The repository contains the bot **and the three service workers** in one deploy:

- `src/index.js` — bot router + `/svc/*` bundled-service router
- `src/services/workers/soundcloud.js` — SoundCloud search/HLS/remux/direct-file service
- `src/services/workers/shazam.js` — Shazam recognition/search/lyrics service
- `src/services/workers/insta.js` + `src/services/workers/lib/` — Instagram resolver/download service
- `src/handlers/*` — message, callback, search, recognize, insta, inline, admin, gate
- `src/services/*` — bot adapters; when `*_API_URL` is empty they self-route to the bundled `/svc/*` routes
- `src/utils/*` — escaping, HTTP retry, KV store, crypto

Audio delivery is URL-only: the bot passes `/svc/sc/f/<sid>/...mp3` to Telegram;
the Worker does not download, buffer, or store music bytes. Telegram fetches the
validated progressive file directly.

---

## 🚀 Deploy — one click to Cloudflare

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Alimsv-d/Music)

> The button above takes you to Cloudflare's deploy page — it copies the repo's
> `wrangler.jsonc`, creates the KV binding, provisions secrets, and deploys the
> single Worker containing the bot + SoundCloud + Shazam + Instagram services.
> The README and `deploy.yml` workflow below are the safer, more repeatable way
> to deploy (they also set the webhook properly).

### One-click deploy via GitHub Actions (recommended)

Repo → **Actions → deploy → Run workflow**, fill the fields and hit **Run**:

| Field | What to paste |
|---|---|
| `CLOUDFLARE_API_TOKEN` | `dash.cloudflare.com` → API Tokens → Custom: Workers **Edit**, Workers KV **Edit**, Account Settings **Read** |
| `CLOUDFLARE_ACCOUNT_ID` | dash → Workers → right sidebar |
| `BOT_TOKEN` | from **@BotFather** |
| `WEBHOOK_SECRET` | `openssl rand -hex 24` |
| `LINK_SECRET` | `openssl rand -hex 24` |
| `ADMIN_SETUP_KEY` | `openssl rand -hex 16` |
| `SHAZAM_BACKEND_URL`/`_KEY` | (optional) ffmpeg backend for video/voice recognition |
| `activate` | tick to register the webhook → bot goes live on Cloudflare (replaces the cPanel webhook) |

The action validates the fields, runs tests, provisions the KV namespace, uploads
the secrets, deploys the single Worker containing the bot + SoundCloud + Shazam
+ Instagram services, and — only when `activate` is ticked — registers the
webhook + verifies it. Values you type are **not** stored in the repo. To avoid
retyping every run, save the same names as repository secrets and any field left
blank falls back to that secret.

- `activate = false` → Worker deployed + health-checked; webhook untouched.
- `activate = true` → Worker deployed + `/setup` runs → webhook moved to Cloudflare (final cutover from cPanel).

### 4 — BotFather checklist (one-time, required)
```
/setinline            -> enable inline mode
/setinlinefeedback    -> enable (for stats)
/setprivacy           -> Disable   (so /music works in groups)
/setjoingroups        -> Enable
```
Then send `/start` to your bot. Done.

---

## 🖥 Manual / local deploy (cPanel host or Termux)

```bash
# clone needs auth because the repo is private:
git clone https://<TOKEN>@github.com/Alimsv-d/Music.git   # fine-grained PAT
# or with SSH:  git clone git@github.com:Alimsv-d/Music.git

cd Music
./scripts/bootstrap.sh          # checks node, installs, .dev.vars, tests, gh secrets
# then either:
npm run deploy                  # wrangler login + creates KV + deploys
curl "<worker>/setup?key=<ADMIN_SETUP_KEY>"   # register webhook
```

`bootstrap.sh` also sets GitHub secrets for you if `gh` is authenticated.

### `.dev.vars` (local secrets — gitignored)
Copy `.dev.vars.example`, fill `BOT_TOKEN` and the three generated secrets.
Never commit it.

---

## ⚙️ Env / secrets table

| Name | Kind | Purpose |
|---|---|---|
| `BOT_TOKEN` | secret | Telegram token |
| `WEBHOOK_SECRET` | secret | verify `X-Telegram-Bot-Api-Secret-Token` |
| `LINK_SECRET` | secret | HMAC-sign `/dl/` proxy URLs |
| `ADMIN_SETUP_KEY` | secret | guard `/setup` |
| `OWNER_ID` | var | owner numeric id (`8437014959`) |
| `SOUNDCLOUD_API_URL` / `SHAZAM_API_URL` / `INSTA_API_URL` | var (optional) | Leave empty for the bundled in-worker services; set only to override with external workers |
| `LEGACY_INSTA_API_URL` | var (optional) | Optional legacy Instagram fallback; empty uses bundled Instagram routes |
| `LRCLIB_API_URL` | var | `https://lrclib.net` |
| `SHAZAM_BACKEND_URL` / `_KEY` | secret (opt) | ffmpeg backend for OGG/video recognition |
| `TELEGRAM_API_BASE` | var (opt) | override for e2e tests |
| `PUBLIC_URL` | var (opt) | worker public origin for webhook/links |

---

## 👑 Admin guide

`/panel` (private, owner/admin). Owner-only: admins, settings, tools.
- **Stats** — users/DAU, groups, searches/downloads, cache hit %, API health.
- **Forced join** — add `@chan` / `t.me/…` / `-100…` or invite link; per-channel
  toggle; global toggle in KV; `✅ عضو شدم` re-check; **fail-open** on TG errors.
- **Broadcast** — send text/media/forward → pick target → chunked ~25 msg/s via
  cron + `waitUntil`; honors `retry_after`, marks blocked inactive, live report.
- **Ban** — by id / reply / forward; reason; list.
- **Settings** — maintenance, auto-lyrics, inline, page size, rate, lang,
  welcome text, support button — all live in KV.
- **Tools** — webhook set/info/delete, self-test, clear cache, CSV export, errors.

---

## 🧪 Testing

```bash
npm test               # 49 unit tests
node scripts/e2e.mjs   # worker-level e2e (mock TG + real SC backend)
node scripts/live-check.mjs   # live backend latency check
node scripts/lint.mjs         # syntax + import resolution
node scripts/secret-scan.mjs  # before every push
```

> **Host note:** this cPanel host caps OS threads, so `wrangler dev`/`workerd`
> cannot run locally. The e2e harness runs the *real* worker code (`src/index.js`)
> directly against a stubbed Telegram + live SoundCloud — it needs no workerd.

## ⚠️ Known limits
- Telegram upload **50 MB**, `getFile` **20 MB**; large files → direct-link button.
- SoundCloud serves **m4a (audio/mp4)** — delivered as `.m4a` audio.
- OGG-Opus voice/video needs an ffmpeg backend (`SHAZAM_BACKEND_URL`) to
  fingerprint; without it the bot replies "send a clearer clip" (fail-soft).
- Free-plan Worker: 128 MB RAM, ~50 subrequests, 10 ms CPU — the code streams
  audio and batches broadcast to stay inside it.

## 🔧 Troubleshooting
| Symptom | Fix |
|---|---|
| Bot silent | `curl <worker>/health` → check `webhook.error`; re-run `/setup?key=` |
| 403 on webhook | `WEBHOOK_SECRET` must match `setWebhook` `secret_token` (Action does this) |
| Inline empty | `/setinline` + `/setprivacy Disable` in @BotFather |
| Voice not recognized | set `SHAZAM_BACKEND_URL` (ffmpeg) — see Known limits |
| Group ignores /music | `/setprivacy Disable`, re-add bot, check `/settings` enabled |

## ❓ FAQ
- **Why GitHub Actions, not the deploy button?** Private repo — the button can't see it.
- **Can users self-host?** They'd need their own tokens + the backend services.
- **Stats exact?** Approximate (KV). Swap to D1 if precision needed.

---

<div align="center">
Made with ❤️ by <b>Ali Mousavi</b> — <a href="https://t.me/AliMsvD">@AliMsvD</a><br>
Running on Cloudflare Workers · MIT License
</div>
