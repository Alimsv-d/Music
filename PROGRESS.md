# PROGRESS — ورک فلو شناخت آهنگ روی Cloudflare Worker (شاخه cf-bot)

## وضعیت: مرحله ۱ تکمیل شد (شناخت + تحویل خودکار) ✅
تاریخ: 2026-10-29

## انجام‌شده
- سرویس رمزگشای داخلی `/svc/dec` ساخته شد: `src/services/workers/decode.js`
  - کدک‌ها: opus (OGG)، aac (MP4/M4A فریم خام)، aac-file، mp3
  - خروجی: Int16 مونو 16kHz (برای اثر انگشت Shazam)
  - هر chunk = ساب‌ریکوئست جداگانه → بودجه CPU تازه (طراحی برای محدودیت 10ms پلن رایگان)
- مبدل PCM و پارسرها: `src/utils/audioparse.js`
  - parseOggPages/oggChunkRanges (رفتیم به باگ stsz/stco کوچک — ثابت شد)
  - parseMp4Audio (باگ بزرگ stsc: «تعداد نمونه در چانک» اشتباه محاسبه می‌شد — ثابت شد)
  - parseWav (باگ اندیِن چانک‌سایز — ثابت شد)، pcmToWav، toMono16k، bytesToB64/b64ToBytes
- پایپ‌لاین شناخت در `src/handlers/recognize.js`:
  - recognizeBytes(ctx, bytes, cacheKey) — sniff → wav مستقیم / ogg|mp4|mp3 → decode chunkی → Shazam pcm_base64
  - کش نتیجه شناخت در Cache API (کلیید recоg:tg:<file_id> و recоg:ig:<url>؛ TTL 6h) → ارسال مجدد همان فایل بدون هیچ درخواست آپ‌استریم
  - شناخت 15 ثانیه اول صدا کافی است (سقف 15 ثانیه، ≤ ~40 ساب‌ریکوئست)
- Shazam.recognizePcm در `src/services/shazam.js` (import bytesToB64 هم از audioparse آمده)
- **تحویل خودکار**: voice/audio/video/document → شناخت → سرچ SoundCloud → deliverTrack (ارسال مستقیم آهنگ در ربات). اگر تحویل نشد، کارت شناخت با دکمه‌های قدیمی.
- رییل اینستاگرام (`src/handlers/insta.js`):
  - باگ برطرف شد: `sent` بدون تعریف بود (خطای ReferenceError جریان را می‌بست! و در پروड هم جلوی شناخت را می‌گرفت)
  - has_audio:null هم اکنون شناخت را اجرا می‌کند (سرویس واقعی همیشه null می‌فرستد)
  - پس از ارسال ویدیو، در پس‌زمینه: دانلود بایت‌ها (سقف 30MB) → شناخت → تحویل خودکار آهنگ؛ فال‌بک: دکمه «🎵 Artist – Title» روی همان ویدیو
- تست‌ها:
  - `test/audio.test.js` جدید + فیکسچرها در test/fixtures (voice10s.ogg از ffmpeg، audio3s.m4a، video3s.mp4، audio10s.mp3 — همه ساخت دست ما چون موزیک لایسنس‌دار نداریم)
  - `npm test` → 64/64 ✅
  - `npm run e2e` → 29/29 ✅ (ای‌پی۲ای MockKV + محاکمه کامل: پوشش voice/m4a/mp3/reel/کش)
  - `npm run lint` ✅، bundle: **1438KB raw / 490KB gzip** (بعد از حذف opus-ml)

## بازهٔ بعدی (صف)
1. بهینه‌سازی کوتا: انتقال seenUpdate/rateLimit/bump به Cache API (پوشش شمارنده‌ها بدون سهمیه KV)؛ upsertUser شرطی؛ فلاش ساعتی با کرون
2. کشِ نتیجه SC search/track در سطح isolate با coalescing (کاهش فشار پلن رایگان)
3. i18n رشته‌های جدید (اگر لازم شد) + بازبینی پیام‌ها
4. push شاخه (بکاپ) و سپس deploy اصلی: main و تغییر webhook از devcoder.ir (که الان 500 می‌دهد) به worker

## اعداد مهم
- مدل آخر: `wrangler deploy --dry-run` → Total Upload: 1438.22 KiB / gzip: 489.79 KiB ✅ (سقف پلن رایگان: 3MB بعد از gzip)
- شاخه کاری: `cf-bot` (بازرفتی می‌کند به origin/merge-cf-bot) — درخواست دیپلوی فقط برای push به main/master/merge-cf-bot می‌آید
- نکته: wg «Duplicate key "lang"» در بعضی فایل‌ها (هشدار، بی‌خطر) — بعداً پاک می‌کنیم
- نکته: `.env` با توکن ربات فقط local است و هرگز کامیت نمی‌شود (Secret scan بغلط هم زنگ می‌زند) — اگر این توکن (8558672701:AAEmooYuv…) فعال است، پیشنهاد revoke در BotFather

## محیط
- هاست cPanel اشتراکی، استفاده دیسک 85% — بعد از این کامیت پاکسازی می‌کنیم
