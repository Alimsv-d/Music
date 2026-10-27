# Music — Telegram music bot

ربات تلگرام موزیک «Music» — سریع، امن و چندزبانه. کلاینتِ سه وب‌سرویس Cloudflare (ساندکلود، شناسایی، اینستاگرام).

## امکانات
- جستجو و دانلود آهنگ از ساندکلود (فارسی/لاتین/فینگلیش، نرمال‌سازی کوئری)
- شناسایی آهنگ از ویس/صدا/ویدیو (اثر انگشت صوتی سمت کلاینت، در worker thread)
- دانلود رسانه‌ی عمومی اینستاگرام (عکس، ویدیو، کاروسل)
- پنل edit-in-place، صفحه‌بندی، کاور، متن ترانه، آهنگ‌های مشابه
- علاقه‌مندی‌ها و تاریخچه
- رفتار هوشمند در گروه (پاسخ فقط هنگام نیاز)
- ضد اسپم و نرخ‌دهی تدریجی، پنل مالک، کانال خبری با صف انتشار
- چندزبانه: fa, en, ar, ru, zh + tier-2 (tr, az, ckb, ps, ur, hi, id, es, fr, de, pt)

## اجرا روی هاست (cPanel Node)
1. متغیرها را از `.env.example` در `.env` کپی و پر کنید (`.env` با دسترسی 600).
2. `npm install`
3. اپ را از طریق cPanel اجرا کنید؛ فایل شروع `app.js` است. برای ری‌استارت: `touch tmp/restart.txt`.
4. وب‌هوک: `npm run set-webhook` — به `PUBLIC_URL` + مسیر امن اشاره می‌کند.
5. برای تست محلی بدون وب‌هوک: `npm run dev` (long polling).

### وب‌سرویس‌ها
آدرس‌ها را در `.env` تنظیم کنید. فرمت دقیق در `docs/API_NOTES.md`.

### کرون
کارهای زمان‌بندی‌شده از مسیر `GET /cron/<CRON_SECRET>` اجرا می‌شوند. یک cron job در cPanel هر ۵ دقیقه این مسیر را صدا بزند، یا از تایمر داخلی اپ (هر ۵ دقیقه) به‌عنوان جایگزین استفاده می‌شود.

```
*/5 * * * * curl -sS -o /dev/null 'https://DevCoder.ir/cron/<CRON_SECRET>'
```

## دیپلوی به Cloudflare Workers
یک adapter در `src/worker.js` قرار دارد. دیپلوی از طریق workflow دستی `Deploy to Cloudflare Workers` (دکمه‌ی Run workflow) انجام می‌شود و کاملاً خودکار است: تست، ساخت/اتصال D1 و KV، migration، secrets، deploy و تنظیم وب‌هوک.

سکرت‌های موردنیاز گیتهاب: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` و متغیرهای ربات (`BOT_TOKEN`, `WEBHOOK_SECRET`, `CRON_SECRET`, `OWNER_ID`, `SOUNDCLOUD_API_URL`, `SHAZAM_API_URL`, `INSTA_API_URL`, `HEAVY_AUDIO_URL` اختیاری).

توکن کلودفلر به این دسترسی‌ها نیاز دارد: **Workers Scripts: Edit, D1: Edit, Workers KV Storage: Edit, Account Settings: Read**.

### محدودیت Workers (پلن رایگان)
شناسایی صوتی به‌خاطر محدودیت CPU روی پلن رایگان کار نمی‌کند؛ فقط اگر `HEAVY_AUDIO_URL` (endpoint امن اپ Node) تنظیم شود فعال می‌شود.

> توجه: فقط یک webhook در هر لحظه فعال است. دیپلوی Worker با `set_webhook=true` وب‌هوک هاست را جایگزین می‌کند. برای برگشت به هاست: `npm run set-webhook` را روی هاست اجرا کنید.

## تست
`npm test` — تست‌های واحد و یکپارچه (نرمال‌سازی، کش، اثر انگشت، i18n parity، قالب پست کانال، ضد اسپم).

## ساختار
```
src/
  config.js          تنظیمات و .env
  index.js           سرور HTTP، webhook، کرون، روتر callback
  worker.js          نسخه‌ی Cloudflare
  core/              store، http، cache، ratelimit، log، context
  services/          soundcloud، shazam(+fingerprint)، instagram، query
  bot/               panel، handlers، admin، channel، send، audio، keyboard
  i18n/              موتور + فایل‌های زبان
migrations/          D1 schema
docs/                API_NOTES، DECISIONS
```

---

# English

**Music** — a fast, secure, multilingual Telegram music bot. It is only an HTTP client of three Cloudflare services (SoundCloud, recognition, Instagram); no scraping or music detection lives in the bot.

## Features
- SoundCloud search & download (Persian/Latin/Finglish, query normalization)
- Song recognition from voice/audio/video (client-side fingerprint in a worker thread)
- Public Instagram media download (photo, video, carousel)
- Edit-in-place panel UI, pagination, covers, lyrics, similar tracks
- Favorites & history
- Smart group behavior (replies only when needed)
- Anti-spam, graduated rate limiting, owner panel, news channel with publish queue
- Multilingual: fa, en, ar, ru, zh + tier-2 locales

## Run on the host (cPanel Node)
1. Copy `.env.example` to `.env` and fill it (chmod 600).
2. `npm install`
3. Start the app via cPanel; startup file is `app.js`. Restart: `touch tmp/restart.txt`.
4. Webhook: `npm run set-webhook`.
5. Local testing without webhook: `npm run dev` (long polling).

### Cron
Scheduled tasks run at `GET /cron/<CRON_SECRET>`. Add a cPanel cron every 5 minutes, or rely on the app's internal 5-minute timer.

## Cloudflare Workers deploy
`src/worker.js` is the Worker adapter. The manual workflow **Deploy to Cloudflare Workers** runs tests, creates/binds D1 & KV, applies migrations, sets secrets, deploys and (optionally) sets the webhook.

Required GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, plus bot vars. Token scopes: Workers Scripts Edit, D1 Edit, Workers KV Storage Edit, Account Settings Read.

### Worker limitation (free plan)
Audio recognition is disabled unless `HEAVY_AUDIO_URL` (a secret-protected endpoint on the Node app) is set, because the free plan's CPU budget is too small for fingerprinting.

> Only one webhook is active at a time. Deploying with `set_webhook=true` replaces the host webhook. To switch back, run `npm run set-webhook` on the host.

## Tests
`npm test` — unit & integration tests (normalization, cache, fingerprint, i18n parity, channel post format, anti-spam).

## Author
Ali Mousavi — [@AliMsvD](https://t.me/AliMsvD)
