// Bilingual catalogue.
//
// Three layers live here:
//   * API_MESSAGES — stable error text used by the JSON API (English default;
//     `?lang=fa` selects Persian). This keeps the API contract unchanged.
//   * UI_MESSAGES  — every string rendered by the web page (Persian default).
//   * DOCS         — the public documentation catalogue rendered on the page.
//
// No user-visible English string is hard-coded in the Persian UI: the page is
// rendered on the server from this catalogue and the client script receives the
// same strings through its boot payload.

export const LANGS = ["en", "fa"];
export const DEFAULT_LANG = "en";
export const DEFAULT_UI_LANG = "fa";

const MESSAGES = {
  en: {
    E_INVALID_URL: "Invalid link. Only public Instagram post, reel or IGTV URLs are accepted.",
    E_INVALID_REQUEST: "Invalid request.",
    E_PRIVATE_OR_NOT_FOUND: "Content is not public, was removed, or is unavailable.",
    E_UPSTREAM_FAILED: "The upstream provider failed. Please try again shortly.",
    E_UPSTREAM_UNAVAILABLE: "No upstream provider is available.",
    E_UPSTREAM_TIMEOUT: "The upstream provider timed out. Please try again shortly.",
    E_RATE_LIMIT: "Too many requests. Please slow down.",
    E_TOO_LARGE: "The file exceeds the allowed size and cannot be downloaded.",
    E_NOT_ALLOWED_HOST: "The media host is not in the allowlist.",
    E_NOT_ALLOWED_TYPE: "The upstream returned a non-media content type.",
    E_BAD_QUALITY: "The selected quality is invalid.",
    E_BAD_INDEX: "The item index is invalid.",
    E_NO_VARIANTS: "No downloadable variant was found for this content.",
    E_METHOD: "Method not allowed.",
    E_NOT_FOUND: "Route not found.",
    E_UNAUTHORIZED: "Unauthorized.",
    E_INTERNAL: "Internal server error.",
  },
  fa: {
    E_INVALID_URL: "لینک نامعتبر است. فقط لینک عمومی پست، ریل یا IGTV اینستاگرام پذیرفته می‌شود.",
    E_INVALID_REQUEST: "درخواست نامعتبر است.",
    E_PRIVATE_OR_NOT_FOUND: "این محتوا عمومی نیست، حذف شده یا در دسترس نیست.",
    E_UPSTREAM_FAILED: "سرور منبع خطا داد. لطفاً کمی بعد دوباره تلاش کنید.",
    E_UPSTREAM_UNAVAILABLE: "هیچ سرور منبعی در دسترس نیست.",
    E_UPSTREAM_TIMEOUT: "سرور منبع پاسخ نداد. لطفاً کمی بعد دوباره تلاش کنید.",
    E_RATE_LIMIT: "تعداد درخواست‌ها زیاد است. لطفاً کمی صبر کنید.",
    E_TOO_LARGE: "حجم فایل از حد مجاز بیشتر است و قابل دانلود نیست.",
    E_NOT_ALLOWED_HOST: "میزبان فایل در فهرست مجاز نیست.",
    E_NOT_ALLOWED_TYPE: "نوع محتوای بازگشتی از منبع، رسانه نیست.",
    E_BAD_QUALITY: "کیفیت انتخاب‌شده معتبر نیست.",
    E_BAD_INDEX: "شماره آیتم معتبر نیست.",
    E_NO_VARIANTS: "هیچ کیفیت قابل دانلودی برای این محتوا پیدا نشد.",
    E_METHOD: "متد درخواست مجاز نیست.",
    E_NOT_FOUND: "مسیر یافت نشد.",
    E_UNAUTHORIZED: "دسترسی غیرمجاز.",
    E_INTERNAL: "خطای داخلی سرور.",
  },
};

const UI_MESSAGES = {
  fa: {
    dir: "rtl",
    langName: "فارسی",
    switch_lang: "English",
    switch_lang_label: "تغییر زبان به انگلیسی",
    brand: "اینستا دانلودر",
    tagline: "پست، ریل و IGTV عمومی اینستاگرام را سریع، تمیز و ایمن دانلود کنید.",
    skip_to_tool: "پرش به ابزار",
    nav_tool: "ابزار",
    nav_result: "نتیجه",
    nav_how: "چطور کار می‌کند",
    nav_docs: "مستندات API",
    nav_faq: "سؤالات متداول",
    nav_legal: "حقوقی",
    menu_open: "باز کردن منو",
    menu_close: "بستن منو",
    hero_title: "دانلود محتوای عمومی اینستاگرام",
    hero_lede: "لینک پست، ریل یا IGTV را بچسبانید؛ پیش‌نمایش، کیفیت‌ها و دانلود امن را همان‌جا ببینید.",
    input_label: "لینک اینستاگرام",
    input_placeholder: "https://www.instagram.com/reel/...",
    btn_analyze: "تحلیل",
    btn_paste: "چسباندن",
    btn_clear: "پاک کردن",
    paste_success: "لینک از کلیپ‌بورد خوانده شد.",
    paste_fail: "دسترسی به کلیپ‌بورد ممکن نشد؛ لینک را دستی بچسبانید.",
    api_key: "کلید API (اختیاری)",
    api_key_ph: "فقط اگر سرویس کلید اجباری دارد",
    api_key_help: "کلید فقط همراه همین درخواست فرستاده می‌شود و ذخیره نمی‌شود.",
    status_resolving: "در حال تحلیل لینک…",
    status_ok: "آماده است.",
    status_error: "خطا",
    err_prefix: "خطا",
    offline_hint: "ارتباط با سرویس برقرار نشد.",
    result_title: "نتیجه",
    result_placeholder: "پس از تحلیل لینک، پیش‌نمایش، کیفیت‌ها و دکمهٔ دانلود اینجا نمایش داده می‌شود.",
    preview: "پیش‌نمایش",
    author: "صاحب محتوا",
    duration: "مدت",
    caption: "کپشن",
    items: "آیتم",
    quality_label: "کیفیت / فرمت",
    quality_best: "بهترین",
    option_label: "گزینه",
    download: "دانلود",
    download_started: "دانلود آغاز شد.",
    only_one_quality: "منبع فقط یک نسخه برگرداند؛ کیفیت دیگری موجود نیست.",
    album_title: "آیتم‌های آلبوم",
    album_item: "آیتم",
    album_download: "دانلود این آیتم",
    btn_download_all: "دانلود همه (ZIP)",
    zip_preparing: "آماده‌سازی ZIP…",
    zip_progress: "دانلود آیتم‌ها…",
    zip_done: "ZIP آماده شد.",
    zip_failed: "ساخت ZIP ناموفق بود.",
    zip_partial: "بعضی آیتم‌ها دانلود نشدند؛ ZIP ناقص است.",
    zip_too_many: "تعداد آیتم‌ها برای ZIP زیاد است؛ لطفاً تک‌تک دانلود کنید.",
    zip_stream_unsupported: "مرورگر شما نوشتن مستقیم فایل را پشتیبانی نمی‌کند؛ ZIP در حافظه ساخته می‌شود.",
    type_video: "ویدیو",
    type_image: "عکس",
    type_album: "آلبوم",
    dimensions: "ابعاد",
    file_size: "حجم",
    source: "لینک اصلی",
    audio_only: "فقط صدا",
    no_result: "نتیجه‌ای پیدا نشد.",
    copy: "کپی لینک",
    copy_success: "کپی شد.",
    share: "اشتراک‌گذاری",
    how_title: "چطور کار می‌کند",
    how_intro: "سه مرحلهٔ ساده، بدون نصب و بدون ثبت‌نام.",
    step1_title: "لینک را بچسبانید",
    step1_desc: "لینک عمومی پست، ریل یا IGTV را از اینستاگرام کپی کنید و در کادر بالا بگذارید.",
    step2_title: "تحلیل کنید",
    step2_desc: "دکمهٔ «تحلیل» را بزنید تا متادیتا، پیش‌نمایش و کیفیت‌های واقعی از منبع خوانده شود.",
    step3_title: "دانلود کنید",
    step3_desc: "کیفیت دلخواه را انتخاب کنید یا در آلبوم هر آیتم را جداگانه دانلود کنید.",
    docs_title: "مستندات API",
    docs_intro: "همین سرویس یک API نسخه‌دار JSON است. پاسخ‌ها یک پاکت یکدست دارند و همهٔ مسیرها با GET و HEAD کار می‌کنند.",
    endpoints_title: "Endpointها",
    endpoint_desc: "توضیح",
    endpoint_params: "پارامترها",
    errors_title: "کدهای خطا",
    error_code: "کد",
    http_status: "HTTP",
    meaning: "معنی",
    samples_title: "نمونهٔ کد",
    sample_curl: "curl",
    sample_js: "JavaScript",
    sample_python: "Python",
    openapi_link: "مشاهدهٔ /openapi.json",
    faq_title: "سؤالات متداول",
    legal_title: "هشدار حقوقی",
    legal_notice: "این سرویس فقط برای محتوای عمومی و استفادهٔ شخصی است. همیشه نام صاحب محتوا و لینک اصلی را ذکر کنید و حق نشر و قوانین اینستاگرام را رعایت کنید.",
    footer_note: "پروژهٔ مستقل؛ وابسته به اینستاگرام یا متا نیست.",
    footer_api: "API",
    footer_docs: "مستندات",
    footer_source: "مخزن پروژه",
    build: "نسخه",
    debug_panel: "پنل خطاهای JavaScript",
    debug_clear: "پاک کردن",
    debug_empty: "خطایی ثبت نشده است.",
    noscript: "برای تحلیل و دانلود، JavaScript را فعال کنید. همهٔ بخش‌های اطلاعاتی صفحه بدون JavaScript قابل مشاهده است.",
  },
  en: {
    dir: "ltr",
    langName: "English",
    switch_lang: "فارسی",
    switch_lang_label: "Switch language to Persian",
    brand: "Insta Downloader",
    tagline: "Download public Instagram posts, reels and IGTV quickly, cleanly and safely.",
    skip_to_tool: "Skip to the tool",
    nav_tool: "Tool",
    nav_result: "Result",
    nav_how: "How it works",
    nav_docs: "API docs",
    nav_faq: "FAQ",
    nav_legal: "Legal",
    menu_open: "Open menu",
    menu_close: "Close menu",
    hero_title: "Download public Instagram content",
    hero_lede: "Paste a post, reel or IGTV link and see the preview, available qualities and a safe download right here.",
    input_label: "Instagram link",
    input_placeholder: "https://www.instagram.com/reel/...",
    btn_analyze: "Analyze",
    btn_paste: "Paste",
    btn_clear: "Clear",
    paste_success: "Link read from the clipboard.",
    paste_fail: "Clipboard access was denied; paste the link manually.",
    api_key: "API key (optional)",
    api_key_ph: "Only if the service requires a key",
    api_key_help: "The key is sent with this request only and is never stored.",
    status_resolving: "Analyzing the link…",
    status_ok: "Ready.",
    status_error: "Error",
    err_prefix: "Error",
    offline_hint: "Could not reach the service.",
    result_title: "Result",
    result_placeholder: "After analyzing a link, the preview, qualities and download button appear here.",
    preview: "Preview",
    author: "Author",
    duration: "Duration",
    caption: "Caption",
    items: "Items",
    quality_label: "Quality / format",
    quality_best: "Best",
    option_label: "Option",
    download: "Download",
    download_started: "Download started.",
    only_one_quality: "The source returned a single version; no other quality is available.",
    album_title: "Album items",
    album_item: "Item",
    album_download: "Download this item",
    btn_download_all: "Download all (ZIP)",
    zip_preparing: "Preparing the ZIP…",
    zip_progress: "Downloading items…",
    zip_done: "The ZIP is ready.",
    zip_failed: "Could not build the ZIP.",
    zip_partial: "Some items failed to download; the ZIP is incomplete.",
    zip_too_many: "Too many items for a ZIP; please download them one by one.",
    zip_stream_unsupported: "This browser cannot write files directly; the ZIP is built in memory.",
    type_video: "Video",
    type_image: "Image",
    type_album: "Album",
    dimensions: "Dimensions",
    file_size: "Size",
    source: "Source link",
    audio_only: "Audio only",
    no_result: "No result found.",
    copy: "Copy link",
    copy_success: "Copied.",
    share: "Share",
    how_title: "How it works",
    how_intro: "Three simple steps, no install and no sign-up.",
    step1_title: "Paste the link",
    step1_desc: "Copy a public post, reel or IGTV link from Instagram and put it in the box above.",
    step2_title: "Analyze it",
    step2_desc: "Press Analyze to read the metadata, preview and the real qualities from the source.",
    step3_title: "Download",
    step3_desc: "Pick a quality, or download each album item separately.",
    docs_title: "API documentation",
    docs_intro: "The same service exposes a versioned JSON API. Every response uses the same envelope and every route supports GET and HEAD.",
    endpoints_title: "Endpoints",
    endpoint_desc: "Description",
    endpoint_params: "Parameters",
    errors_title: "Error codes",
    error_code: "Code",
    http_status: "HTTP",
    meaning: "Meaning",
    samples_title: "Code samples",
    sample_curl: "curl",
    sample_js: "JavaScript",
    sample_python: "Python",
    openapi_link: "Open /openapi.json",
    faq_title: "Frequently asked questions",
    legal_title: "Legal notice",
    legal_notice: "This service is for public content and personal use only. Always credit the author and link to the original post, and respect copyright and Instagram's terms.",
    footer_note: "An independent project; not affiliated with Instagram or Meta.",
    footer_api: "API",
    footer_docs: "Documentation",
    footer_source: "Project repository",
    build: "Build",
    debug_panel: "JavaScript error panel",
    debug_clear: "Clear",
    debug_empty: "No errors captured.",
    noscript: "Enable JavaScript to analyze and download. Every informational section on this page works without JavaScript.",
  },
};

// ---------------------------------------------------------------------------
// Public documentation catalogue. Shape:
//   endpoints: [ [ "METHOD /path", description, parameters ], ... ]
//   errors:    [ [ code, httpStatus, meaning ], ... ]
//   faq:       [ [ question, answer ], ... ]
//   legal:     [ paragraph, ... ]
//   steps:     [ [ title, description ], ... ]
// ---------------------------------------------------------------------------
const DOCS = {
  fa: {
    endpoints: [
      ["GET /", "صفحهٔ وب برای مرورگر (Accept: text/html) و خلاصهٔ JSON برای API", "Accept، lang، debug=1"],
      ["GET /api/v1/resolve", "دریافت متادیتا و فهرست کیفیت‌های یک پست/ریل/IGTV عمومی", "url (اجباری)، lang"],
      ["GET /api/v1/download", "دانلود یا استریم یک نسخه با پشتیبانی کامل از Range", "url (اجباری)، quality، index، inline=1، lang"],
      ["GET /api/v1/thumbnail", "پروکسی امن تصویر بندانگشتی از CDN مجاز", "url (اجباری)، lang"],
      ["GET /health", "وضعیت سرویس، providerها و محدودیت‌ها", "deep=1 (بررسی زندهٔ providerها)"],
      ["GET /openapi.json", "مشخصات OpenAPI همین سرویس", "-"],
    ],
    errors: [
      ["E_INVALID_URL", 400, "لینک نامعتبر است"],
      ["E_INVALID_REQUEST", 400, "پارامترهای درخواست نامعتبر است"],
      ["E_BAD_QUALITY", 400, "کیفیت انتخاب‌شده وجود ندارد"],
      ["E_BAD_INDEX", 400, "شمارهٔ آیتم خارج از محدوده است"],
      ["E_NOT_ALLOWED_HOST", 400, "میزبان فایل در allowlist نیست"],
      ["E_UNAUTHORIZED", 401, "کلید API لازم یا نامعتبر است"],
      ["E_NOT_FOUND", 404, "مسیر یافت نشد"],
      ["E_NO_VARIANTS", 404, "هیچ نسخهٔ قابل دانلودی یافت نشد"],
      ["E_PRIVATE_OR_NOT_FOUND", 404, "محتوا عمومی نیست یا حذف شده است"],
      ["E_METHOD", 405, "متد HTTP مجاز نیست"],
      ["E_TOO_LARGE", 413, "حجم فایل از سقف مجاز بیشتر است"],
      ["E_NOT_ALLOWED_TYPE", 415, "نوع محتوای فایل قابل پروکسی نیست"],
      ["E_RATE_LIMIT", 429, "محدودیت نرخ درخواست"],
      ["E_INTERNAL", 500, "خطای داخلی سرور"],
      ["E_UPSTREAM_FAILED", 502, "خطای سرویس منبع"],
      ["E_UPSTREAM_UNAVAILABLE", 502, "هیچ provider در دسترس نیست"],
      ["E_UPSTREAM_TIMEOUT", 504, "سرویس منبع پاسخ نداد"],
    ],
    faq: [
      ["آیا محتوای خصوصی قابل دانلود است؟", "نه. فقط پست‌ها، ریل‌ها و IGTV عمومی. ورود به حساب، کوکی و استخراج انبوه پیاده‌سازی نشده است."],
      ["چرا بعضی لینک‌ها فقط یک کیفیت دارند؟", "چون منبع فقط یک نسخه برمی‌گرداند. ما کیفیت جعلی نمی‌سازیم و صادقانه اطلاع می‌دهیم."],
      ["آیا لینک‌های دانلود دائمی هستند؟", "خیر. لینک‌های اینستاگرام امضادار و کوتاه‌عمرند؛ دانلود از طریق پروکسی همین سرویس انجام می‌شود."],
      ["آیا داده‌های من ذخیره می‌شود؟", "IP خام ذخیره نمی‌شود؛ برای محدودیت نرخ فقط یک hash یکتا (HMAC) در KV نگه داشته می‌شود. کلید API هم در مرورگر ذخیره نمی‌شود."],
      ["آیا می‌توانم از این سرویس در برنامهٔ خودم استفاده کنم؟", "بله. API بدون وابستگی به SDK و با پاسخ JSON یکدست است. مستندات کامل در همین صفحه و روی /openapi.json است."],
      ["چرا دکمهٔ ZIP فقط در آلبوم دیده می‌شود؟", "ZIP برای جمع‌کردن چند آیتم است. برای یک فایل، دانلود مستقیم ساده‌تر و سریع‌تر است."],
    ],
    legal: [
      "این سرویس فقط برای مصارف شخصی و محتوای کاملاً عمومی طراحی شده است.",
      "استفادهٔ تجاری، انبوه یا دور زدن محدودیت‌های اینستاگرام مجاز نیست.",
      "مسئولیت رعایت حق نشر بر عهدهٔ کاربر است؛ نام صاحب محتوا و لینک اصلی نمایش داده می‌شود.",
      "هیچ گذرواژه، کوکی یا توکن نشستی جمع‌آوری یا ذخیره نمی‌شود.",
      "سرویس «همان‌طور که هست» ارائه می‌شود و هیچ تضمینی برای در دسترس بودن یا صحت نتایج نیست.",
    ],
    steps: [
      ["لینک را بچسبانید", "لینک عمومی پست، ریل یا IGTV را از اینستاگرام کپی کنید و در کادر بالا بگذارید."],
      ["تحلیل کنید", "دکمهٔ «تحلیل» را بزنید تا متادیتا، پیش‌نمایش و کیفیت‌های واقعی از منبع خوانده شود."],
      ["دانلود کنید", "کیفیت دلخواه را انتخاب کنید یا در آلبوم هر آیتم را جداگانه دانلود کنید."],
    ],
  },
  en: {
    endpoints: [
      ["GET /", "The web page for browsers (Accept: text/html) and a JSON summary for API clients", "Accept, lang, debug=1"],
      ["GET /api/v1/resolve", "Fetch metadata and the quality list of a public post/reel/IGTV", "url (required), lang"],
      ["GET /api/v1/download", "Download or stream one variant with full Range support", "url (required), quality, index, inline=1, lang"],
      ["GET /api/v1/thumbnail", "Safely proxy a thumbnail from an allowlisted CDN", "url (required), lang"],
      ["GET /health", "Service status, providers and limits", "deep=1 (live provider check)"],
      ["GET /openapi.json", "OpenAPI specification of this service", "-"],
    ],
    errors: [
      ["E_INVALID_URL", 400, "The link is not a valid Instagram URL"],
      ["E_INVALID_REQUEST", 400, "The request parameters are invalid"],
      ["E_BAD_QUALITY", 400, "The selected quality does not exist"],
      ["E_BAD_INDEX", 400, "The item index is out of range"],
      ["E_NOT_ALLOWED_HOST", 400, "The file host is not in the allowlist"],
      ["E_UNAUTHORIZED", 401, "The API key is missing or invalid"],
      ["E_NOT_FOUND", 404, "Route not found"],
      ["E_NO_VARIANTS", 404, "No downloadable variant was found"],
      ["E_PRIVATE_OR_NOT_FOUND", 404, "The content is not public or was removed"],
      ["E_METHOD", 405, "The HTTP method is not allowed"],
      ["E_TOO_LARGE", 413, "The file exceeds the size cap"],
      ["E_NOT_ALLOWED_TYPE", 415, "The content type cannot be proxied"],
      ["E_RATE_LIMIT", 429, "Rate limit exceeded"],
      ["E_INTERNAL", 500, "Internal server error"],
      ["E_UPSTREAM_FAILED", 502, "The upstream service failed"],
      ["E_UPSTREAM_UNAVAILABLE", 502, "No provider is available"],
      ["E_UPSTREAM_TIMEOUT", 504, "The upstream service timed out"],
    ],
    faq: [
      ["Can private content be downloaded?", "No. Only public posts, reels and IGTV. There is no account login, no cookies and no bulk extraction."],
      ["Why does some link have only one quality?", "Because the upstream returns a single version. We never invent fake qualities and we say so honestly."],
      ["Are the download links permanent?", "No. Instagram links are signed and short-lived; downloads are proxied through this service."],
      ["Is my data stored?", "A raw IP is never stored; only a unique HMAC hash is kept in KV for rate limiting. The API key is not stored in the browser either."],
      ["Can I use this service in my own app?", "Yes. The API is dependency-free and returns a uniform JSON envelope. Full docs are on this page and at /openapi.json."],
      ["Why does the ZIP button only appear for albums?", "A ZIP is for collecting multiple items. For a single file, a direct download is simpler and faster."],
    ],
    legal: [
      "This service is designed for personal use with fully public content only.",
      "Commercial or bulk use, or circumventing Instagram limits, is not allowed.",
      "You are responsible for respecting copyright; the author name and the source link are shown.",
      "No password, cookie or session token is ever collected or stored.",
      "The service is provided as-is, without any guarantee of availability or result accuracy.",
    ],
    steps: [
      ["Paste the link", "Copy a public post, reel or IGTV link from Instagram and put it in the box above."],
      ["Analyze it", "Press Analyze to read the metadata, preview and the real qualities from the source."],
      ["Download", "Pick a quality, or download each album item separately."],
    ],
  },
};

/** Only `en` and `fa` are supported; anything else falls back to English. */
export function normalizeLang(value) {
  return value === "fa" ? "fa" : DEFAULT_LANG;
}

/** `?lang=fa` (or `?lang=en`) overrides the English default for API text. */
export function langFromRequest(request) {
  try {
    const url = new URL(request.url);
    return normalizeLang(url.searchParams.get("lang"));
  } catch {
    return DEFAULT_LANG;
  }
}

/** The web page defaults to Persian; only an explicit `?lang=en` switches it. */
export function uiLangFromRequest(request) {
  try {
    const url = new URL(request.url);
    const value = url.searchParams.get("lang");
    if (value === "en") return "en";
    if (value === "fa") return "fa";
  } catch {
    // ignore
  }
  return DEFAULT_UI_LANG;
}

/** The stable error message for a code. Unknown codes return the code itself. */
export function t(lang, code) {
  const table = MESSAGES[normalizeLang(lang)] || MESSAGES[DEFAULT_LANG];
  return table[code] || MESSAGES[DEFAULT_LANG][code] || String(code);
}

/** True when both languages define the code (used by the tests). */
export function hasMessage(lang, code) {
  return Boolean(MESSAGES[normalizeLang(lang)] && MESSAGES[normalizeLang(lang)][code]);
}

/** The whole UI catalogue for a language (server render + client boot payload). */
export function uiStrings(lang) {
  const table = UI_MESSAGES[lang] || UI_MESSAGES[DEFAULT_UI_LANG];
  return { ...table };
}

/** The documentation catalogue for a language. */
export function docsFor(lang) {
  const docs = DOCS[lang] || DOCS[DEFAULT_UI_LANG];
  return {
    endpoints: docs.endpoints.map((row) => [...row]),
    errors: docs.errors.map((row) => [...row]),
    faq: docs.faq.map((row) => [...row]),
    legal: [...docs.legal],
    steps: docs.steps.map((row) => [...row]),
  };
}

/** Keys present in one UI language but missing in another (test helper). */
export function missingUiKeys(lang) {
  const table = UI_MESSAGES[lang] || {};
  return Object.keys(UI_MESSAGES.en).filter((key) => !(key in table));
}

export function isRtl(lang) {
  return lang === "fa";
}
