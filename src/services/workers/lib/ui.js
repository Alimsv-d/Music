// Single-file bilingual web UI (HTML + CSS + a small progressive-enhancement
// script) rendered by the worker.
//
// Rendering rules:
//   * every informational section is rendered on the server and is visible
//     without JavaScript. Only interactive controls depend on JavaScript;
//   * reveal-on-scroll is armed ONLY when JS ran successfully (`html.js`),
//     IntersectionObserver exists (`html.io`) and the user does not prefer
//     reduced motion. The CSS covers all three conditions;
//   * a fallback timer is registered in <head>, outside every other error
//     boundary, and reveals everything after one second no matter what;
//   * each client init step is wrapped in its own try/catch;
//   * the CSP has no unsafe-inline: both the <style> and the <script> carry the
//     request nonce. There is no external font and no inline event handler;
//   * `window.__insta` exists only in `?debug=1` mode.

import { escapeHtml } from "./security.js";
import { uiStrings, docsFor } from "./i18n.js";

export { escapeHtml };

/**
 * Only absolute https URLs (or in-page anchors) are allowed in user data links.
 * @param {string} value
 * @param {string} fallback
 */
export function safeHref(value, fallback = "#") {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return fallback;
  if (raw.startsWith("#")) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

/**
 * Format a duration for display. Values may be seconds or milliseconds; when
 * the unit is not supplied, values >= 1000 are treated as milliseconds (the
 * legacy upstream behaviour) and smaller values as seconds.
 * @param {number|string} value
 * @param {"s"|"ms"|undefined} unit
 * @returns {string}
 */
export function formatDuration(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  let seconds;
  if (unit === "ms") seconds = n / 1000;
  else if (unit === "s") seconds = n;
  else seconds = n >= 1000 ? n / 1000 : n;
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function codeSamples(origin) {
  const base = /^https?:\/\/[^\s"'<>]+$/i.test(origin || "") ? origin : "https://your-worker.example";
  const resolve = `${base}/api/v1/resolve?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FABC123%2F`;
  const download = `${base}/api/v1/download?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FABC123%2F`;
  return {
    curl: `# Resolve metadata\ncurl "${resolve}"\n\n# Download the best variant\ncurl -OJ "${download}"`,
    js: `const url = new URL("${base}/api/v1/resolve");\nurl.searchParams.set("url", "https://www.instagram.com/reel/ABC123/");\n\nconst res = await fetch(url, { headers: { accept: "application/json" } });\nconst { data } = await res.json();\nconsole.log(data.items);`,
    python: `import requests\n\nr = requests.get(\n    "${base}/api/v1/resolve",\n    params={"url": "https://www.instagram.com/reel/ABC123/"},\n    timeout=30,\n)\nr.raise_for_status()\nprint(r.json()["data"]["items"])`,
  };
}

/**
 * @param {{lang:string, nonce:string, build:string, debug?:boolean, origin?:string}} opts
 */
export function renderHome(opts) {
  const lang = opts.lang === "en" ? "en" : "fa";
  const S = uiStrings(lang);
  const D = docsFor(lang);
  const nonce = String(opts.nonce || "");
  const build = escapeHtml(opts.build || "dev");
  const debug = Boolean(opts.debug);
  const origin = String(opts.origin || "");
  const switchLang = lang === "en" ? "fa" : "en";
  const switchHref = `?lang=${switchLang}${debug ? `&amp;debug=1` : ""}`;
  const samples = codeSamples(origin);

  const boot = scriptJson({
    lang,
    debug,
    strings: S,
  });

  const endpointsHtml = D.endpoints
    .map(
      (row) =>
        `<article class="endpoint"><code>${escapeHtml(row[0])}</code><p>${escapeHtml(row[1])}</p><p class="hint">${escapeHtml(
          S.endpoint_params,
        )}: ${escapeHtml(row[2])}</p></article>`,
    )
    .join("");

  const errorsHtml = D.errors
    .map(
      (row) =>
        `<tr><td><code>${escapeHtml(row[0])}</code></td><td>${escapeHtml(row[1])}</td><td>${escapeHtml(
          row[2],
        )}</td></tr>`,
    )
    .join("");

  const faqHtml = D.faq
    .map(
      (row) =>
        `<details><summary>${escapeHtml(row[0])}</summary><p>${escapeHtml(row[1])}</p></details>`,
    )
    .join("");

  const legalHtml = D.legal.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  const stepsHtml = D.steps
    .map(
      (row, i) =>
        `<li class="step"><span class="step-num" aria-hidden="true">${i + 1}</span><div><h3>${escapeHtml(
          row[0],
        )}</h3><p>${escapeHtml(row[1])}</p></div></li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="${lang}" dir="${S.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f7fb" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1016" media="(prefers-color-scheme: dark)">
<title>${escapeHtml(S.brand)} — ${escapeHtml(S.hero_title)}</title>
<meta name="description" content="${escapeHtml(S.tagline)}">
<meta name="referrer" content="no-referrer">
<style nonce="${escapeHtml(nonce)}">${CSS}</style>
<script nonce="${escapeHtml(nonce)}">${HEAD_JS}</script>
</head>
<body>
<a class="skip" href="#tool">${escapeHtml(S.skip_to_tool)}</a>
<header class="topbar">
  <div class="wrap row">
    <a class="brand" href="/" aria-label="${escapeHtml(S.brand)}">
      <span class="logo" aria-hidden="true">${LOGO_SVG}</span>
      <span class="brand-text"><strong>${escapeHtml(S.brand)}</strong><small>${escapeHtml(S.tagline)}</small></span>
    </a>
    <nav id="nav" class="nav" aria-label="${escapeHtml(S.brand)}">
      <a href="#tool">${escapeHtml(S.nav_tool)}</a>
      <a href="#result">${escapeHtml(S.nav_result)}</a>
      <a href="#how">${escapeHtml(S.nav_how)}</a>
      <a href="#docs">${escapeHtml(S.nav_docs)}</a>
      <a href="#faq">${escapeHtml(S.nav_faq)}</a>
      <a href="#legal">${escapeHtml(S.nav_legal)}</a>
    </nav>
    <div class="actions">
      <a class="lang-link" href="${switchHref}" hreflang="${switchLang}" lang="${switchLang}" aria-label="${escapeHtml(
        S.switch_lang_label,
      )}">${escapeHtml(S.switch_lang)}</a>
      <button id="menuBtn" class="icon-btn nav-toggle" type="button" aria-label="${escapeHtml(
        S.menu_open,
      )}" aria-expanded="false" aria-controls="nav">${ICONS.menu}</button>
    </div>
  </div>
</header>

<main class="wrap">
  <section id="tool" class="hero reveal">
    <h1>${escapeHtml(S.hero_title)}</h1>
    <p class="lede">${escapeHtml(S.hero_lede)}</p>
    <form id="resolveForm" class="card tool-card" autocomplete="off">
      <label for="urlInput">${escapeHtml(S.input_label)}</label>
      <div class="input-row">
        <input id="urlInput" name="url" type="text" inputmode="url" dir="ltr" spellcheck="false" placeholder="${escapeHtml(
          S.input_placeholder,
        )}" aria-describedby="urlHelp">
        <button id="pasteBtn" class="btn ghost" type="button">${ICONS.clipboard}<span>${escapeHtml(
          S.btn_paste,
        )}</span></button>
        <button id="clearBtn" class="btn ghost" type="button">${ICONS.x}<span>${escapeHtml(
          S.btn_clear,
        )}</span></button>
      </div>
      <div class="input-row">
        <input id="apiKeyInput" type="password" dir="ltr" autocomplete="off" placeholder="${escapeHtml(
          S.api_key_ph,
        )}" aria-label="${escapeHtml(S.api_key)}">
        <button type="submit" id="resolveBtn" class="btn primary">${ICONS.search}<span>${escapeHtml(
          S.btn_analyze,
        )}</span></button>
      </div>
      <p id="urlHelp" class="hint">${escapeHtml(S.api_key_help)}</p>
    </form>
    <noscript><p class="notice">${escapeHtml(S.noscript)}</p></noscript>
    <div id="status" class="status" role="status" aria-live="polite"></div>
    <div id="skeleton" class="skeleton card" hidden aria-hidden="true">
      <div class="sk-line"></div><div class="sk-media"></div><div class="sk-line short"></div>
    </div>
  </section>

  <section id="result" class="reveal" aria-labelledby="resultTitle">
    <div class="sec-head"><h2 id="resultTitle">${escapeHtml(S.result_title)}</h2></div>
    <div id="resultBox" class="result">
      <p class="hint placeholder" id="resultPlaceholder">${escapeHtml(S.result_placeholder)}</p>
    </div>
  </section>

  <section id="how" class="reveal">
    <h2>${escapeHtml(S.how_title)}</h2>
    <p>${escapeHtml(S.how_intro)}</p>
    <ol class="steps">${stepsHtml}</ol>
  </section>

  <section id="docs" class="reveal">
    <h2>${escapeHtml(S.docs_title)}</h2>
    <p>${escapeHtml(S.docs_intro)}</p>
    <p><a class="btn ghost small" href="/openapi.json" target="_blank" rel="noopener">${escapeHtml(
      S.openapi_link,
    )}</a></p>

    <h3>${escapeHtml(S.endpoints_title)}</h3>
    <div class="endpoints">${endpointsHtml}</div>

    <h3>${escapeHtml(S.errors_title)}</h3>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>${escapeHtml(S.error_code)}</th><th>${escapeHtml(
        S.http_status,
      )}</th><th>${escapeHtml(S.meaning)}</th></tr></thead>
      <tbody>${errorsHtml}</tbody>
    </table></div>

    <h3>${escapeHtml(S.samples_title)}</h3>
    <div class="samples">
      <div class="card"><b>${escapeHtml(S.sample_curl)}</b><pre class="code-block"><code>${escapeHtml(
        samples.curl,
      )}</code></pre></div>
      <div class="card"><b>${escapeHtml(S.sample_js)}</b><pre class="code-block"><code>${escapeHtml(
        samples.js,
      )}</code></pre></div>
      <div class="card"><b>${escapeHtml(S.sample_python)}</b><pre class="code-block"><code>${escapeHtml(
        samples.python,
      )}</code></pre></div>
    </div>
  </section>

  <section id="faq" class="reveal">
    <h2>${escapeHtml(S.faq_title)}</h2>
    <div class="faq">${faqHtml}</div>
  </section>

  <section id="legal" class="reveal">
    <h2>${escapeHtml(S.legal_title)}</h2>
    <div class="legal">
      <p class="notice">${escapeHtml(S.legal_notice)}</p>
      <ul>${legalHtml}</ul>
    </div>
  </section>
</main>

<footer class="footer wrap">
  <p>${escapeHtml(S.footer_note)}</p>
  <p class="hint"><a href="#docs">${escapeHtml(S.footer_api)}</a> · <a href="/openapi.json">${escapeHtml(
    S.footer_docs,
  )}</a> · ${escapeHtml(S.build)}: <code>${build}</code></p>
</footer>

<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
${
  debug
    ? `<aside id="debugPanel" class="debug" aria-label="${escapeHtml(
        S.debug_panel,
      )}"><header><span>${escapeHtml(S.debug_panel)}</span><button id="debugClear" type="button">${escapeHtml(
        S.debug_clear,
      )}</button></header><ol id="debugList"><li class="hint">${escapeHtml(S.debug_empty)}</li></ol></aside>`
    : ""
}

<script id="boot" type="application/json" nonce="${escapeHtml(nonce)}">${boot}</script>
<script nonce="${escapeHtml(nonce)}">${CLIENT_JS}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Inline SVG icons. No external asset or font is loaded.
// ---------------------------------------------------------------------------
const ICONS = {
  menu: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
  clipboard: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/></svg>`,
  x: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  search: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`,
};

const LOGO_SVG = `<svg viewBox="0 0 48 48" width="34" height="34" aria-hidden="true"><defs><linearGradient id="iw-logo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f9ce34"/><stop offset=".5" stop-color="#ee2a7b"/><stop offset="1" stop-color="#6228d7"/></linearGradient></defs><rect x="4" y="4" width="40" height="40" rx="12" fill="url(#iw-logo)"/><rect x="14" y="14" width="20" height="20" rx="6" fill="none" stroke="#fff" stroke-width="2.6"/><circle cx="24" cy="24" r="5" fill="none" stroke="#fff" stroke-width="2.6"/><circle cx="31" cy="17" r="1.8" fill="#fff"/></svg>`;

const CSS = String.raw`
:root{
  --bg:#f6f7fb; --bg2:#ffffff; --fg:#12141a; --muted:#5b6472; --line:#e4e7ef;
  --card:#ffffff; --shadow:0 10px 30px rgba(16,24,40,.08); --brand:#e1306c; --brand2:#6228d7;
  --ok:#0f7b4f; --err:#c5221f; --warn:#8a5300; --radius:16px; --max:1080px;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0e1016; --bg2:#141823; --fg:#eef1f7; --muted:#9aa4b6; --line:#242b39;
    --card:#171c27; --shadow:0 12px 34px rgba(0,0,0,.5); --ok:#5ad19a; --err:#ff8b84; --warn:#ffc46b;
  }
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:linear-gradient(180deg,var(--bg),var(--bg2));color:var(--fg);
  font-family:Vazirmatn,"Noto Sans Arabic",system-ui,-apple-system,"Segoe UI",Roboto,Tahoma,sans-serif;
  line-height:1.75;-webkit-font-smoothing:antialiased;min-height:100vh}
a{color:var(--brand);text-decoration:none}
a:hover{text-decoration:underline}
[hidden]{display:none!important}
.wrap{max-width:var(--max);margin:0 auto;padding:0 18px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.skip{position:absolute;inset-inline-start:-9999px;top:8px;background:var(--card);padding:8px 12px;border-radius:8px;z-index:50}
.skip:focus{inset-inline-start:8px}
.topbar{position:sticky;top:0;z-index:40;background:color-mix(in srgb,var(--bg) 86%,transparent);
  backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line)}
.topbar .row{display:flex;align-items:center;gap:12px;min-height:64px;position:relative}
.brand{display:flex;align-items:center;gap:10px;color:inherit;min-width:0}
.brand:hover{text-decoration:none}
.brand-text strong{display:block;font-size:1.05rem;line-height:1.2;white-space:nowrap}
.brand-text small{display:none;color:var(--muted);font-size:.72rem;max-width:40ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(min-width:820px){.brand-text small{display:block}}
.nav{display:flex;flex-wrap:wrap;gap:4px;margin-inline-start:auto}
.nav a{padding:7px 10px;border-radius:10px;color:var(--muted);font-weight:600;font-size:.9rem;white-space:nowrap}
.nav a:hover,.nav a:focus-visible{background:color-mix(in srgb,var(--brand) 12%,transparent);color:var(--fg);text-decoration:none}
.actions{display:flex;align-items:center;gap:8px;margin-inline-start:auto}
.nav-toggle{display:none}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;
  border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:12px;cursor:pointer;transition:transform .18s,border-color .18s}
.icon-btn:hover{transform:translateY(-1px);border-color:var(--brand)}
.lang-link{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 12px;
  border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--fg);font-size:.86rem;font-weight:700;white-space:nowrap}
.lang-link:hover{border-color:var(--brand);text-decoration:none;transform:translateY(-1px)}
@media(max-width:899px){
  .nav-ready .nav-toggle{display:inline-flex}
  .nav-ready .nav{display:none}
  .nav-ready .nav.open{display:flex;flex-direction:column;position:absolute;inset-inline:0;top:100%;
    background:var(--card);border-bottom:1px solid var(--line);padding:10px 18px;box-shadow:var(--shadow)}
  .nav-ready .nav.open a{padding:10px 12px}
}
section{padding:34px 0;scroll-margin-top:78px}
h1{font-size:clamp(1.8rem,5vw,2.8rem);margin:.2em 0;line-height:1.3}
h2{font-size:clamp(1.3rem,3.4vw,1.9rem);margin:.2em 0}
h3{margin:1.3em 0 .4em}
.lede{color:var(--muted);font-size:1.08rem;margin-top:.6em;max-width:70ch}
/* Gradient text is a progressive enhancement: the fallback is an opaque colour,
   never transparent. */
.hero h1{color:var(--brand)}
@supports ((-webkit-background-clip:text) or (background-clip:text)){
  .hero h1{background:linear-gradient(120deg,var(--brand),var(--brand2));
    -webkit-background-clip:text;background-clip:text;color:transparent}
}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px}
.tool-card{display:grid;gap:12px;margin-top:8px}
.tool-card label{font-weight:700;font-size:.95rem}
.input-row{display:flex;gap:10px;flex-wrap:wrap}
.input-row>*{flex:1 1 160px;min-width:0}
input{width:100%;padding:13px 14px;border:1px solid var(--line);border-radius:12px;
  background:var(--bg2);color:var(--fg);font:inherit;transition:border-color .18s,box-shadow .18s}
input:focus-visible,select:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid color-mix(in srgb,var(--brand) 55%,transparent);outline-offset:2px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 16px;border-radius:12px;
  border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;font-weight:700;cursor:pointer;
  transition:transform .18s,background .18s,border-color .18s;white-space:nowrap}
.btn:hover{transform:translateY(-1px);text-decoration:none}
.btn.primary{background:linear-gradient(120deg,var(--brand),var(--brand2));border:0;color:#fff}
.btn.primary:hover{color:#fff}
.btn.ghost{background:transparent}
.btn.small{padding:7px 11px;font-size:.85rem}
.hint{color:var(--muted);font-size:.85rem;margin:0}
.status{margin:10px 0;min-height:1.6em;font-weight:600}
.status.err{color:var(--err)}
.status.ok{color:var(--ok)}
.notice{border:1px solid color-mix(in srgb,var(--warn) 40%,var(--line));background:color-mix(in srgb,var(--warn) 10%,var(--card));
  padding:10px 14px;border-radius:12px;color:var(--fg)}
.sec-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.result{display:grid;gap:16px}
.result:not(:empty){animation:rise .35s ease both}
@media (prefers-reduced-motion: reduce){.result:not(:empty){animation:none}}
@keyframes rise{from{transform:translateY(8px)}to{transform:none}}
.preview{display:grid;grid-template-columns:1fr;gap:16px}
@media(min-width:760px){.preview{grid-template-columns:320px 1fr}}
.media-box{position:relative;border-radius:14px;overflow:hidden;background:#000;aspect-ratio:9/16;max-height:520px;display:flex;align-items:center;justify-content:center}
.media-box img,.media-box video{width:100%;height:100%;object-fit:contain;display:block}
.media-box.empty{padding:20px;color:#fff;text-align:center;aspect-ratio:16/9}
.meta{display:grid;gap:8px;align-content:start;min-width:0}
.meta .author{display:flex;align-items:center;gap:10px}
.meta .author b{font-size:1.02rem}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;
  background:color-mix(in srgb,var(--brand) 12%,transparent);color:var(--fg);font-size:.82rem;font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.caption{white-space:pre-wrap;word-break:break-word;color:var(--muted);max-height:10em;overflow:auto}
.variants{display:grid;gap:10px}
.variant{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px;border:1px solid var(--line);border-radius:12px}
.variant input[type=radio]{width:auto;padding:0;accent-color:var(--brand);flex:none;margin:0}
.variant label{flex:1 1 180px;cursor:pointer}
.variant .v-info b{display:block}
.variant .v-info span{color:var(--muted);font-size:.85rem}
.download-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}
.album-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.album-item{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--bg2)}
.album-item .thumb{aspect-ratio:1;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden}
.album-item .thumb img{width:100%;height:100%;object-fit:cover}
.album-item .thumb.empty{color:#fff;font-size:.85rem;padding:10px;text-align:center}
.album-item .body{padding:10px;display:grid;gap:8px}
.steps{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.step{display:flex;gap:12px;align-items:flex-start;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--card)}
.step h3{margin:0 0 4px;font-size:1.03rem}
.step p{margin:0;color:var(--muted);font-size:.92rem}
.step-num{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;
  flex:none;background:linear-gradient(120deg,var(--brand),var(--brand2));color:#fff;font-weight:800}
.endpoints{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px;margin-top:12px}
.endpoint{padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.endpoint code{font-weight:700;color:var(--brand);word-break:break-word}
.endpoint p{margin:.4em 0;font-size:.9rem}
.code-block{background:#0c0f16;color:#d6e2ff;padding:14px;border-radius:12px;overflow:auto;direction:ltr;text-align:left;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.82rem;max-height:380px;margin:.6em 0 0}
.samples{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px}
.table{width:100%;border-collapse:collapse;font-size:.9rem;background:var(--card)}
.table th,.table td{padding:9px 12px;text-align:start;border-bottom:1px solid var(--line);white-space:nowrap}
.table td:last-child{white-space:normal}
.table th{background:color-mix(in srgb,var(--brand) 8%,transparent)}
.table code{color:var(--brand);font-weight:700}
/* Narrow screens: stack each row instead of squeezing the "meaning" column. */
@media (max-width:640px){
  .table thead{display:none}
  .table,.table tbody,.table tr,.table td{display:block;width:100%}
  .table tr{padding:10px 12px;border-bottom:1px solid var(--line)}
  .table tr:last-child{border-bottom:0}
  .table td{padding:2px 0;border:0;white-space:normal}
}
.faq details{border:1px solid var(--line);border-radius:12px;background:var(--card);margin-bottom:10px;padding:6px 14px}
.faq summary{cursor:pointer;font-weight:700;padding:10px 0}
.faq summary::marker{color:var(--brand)}
.faq p{color:var(--muted);margin-top:.2em}
.legal{max-width:75ch}
.legal ul{color:var(--muted)}
.footer{padding:34px 0 60px;color:var(--muted);font-size:.9rem;display:flex;flex-direction:column;gap:6px}
.footer code{color:var(--fg)}
.skeleton{display:grid;gap:12px}
.sk-line,.sk-media{background:linear-gradient(90deg,var(--line),color-mix(in srgb,var(--line) 40%,transparent),var(--line));
  background-size:200% 100%;animation:sk 1.2s infinite;border-radius:10px}
.sk-line{height:16px}.sk-line.short{width:40%}.sk-media{height:280px;border-radius:14px}
@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}
@media (prefers-reduced-motion: reduce){.sk-line,.sk-media{animation:none}}
.toast{position:fixed;inset-block-end:20px;inset-inline:0;margin:auto;width:fit-content;max-width:90vw;
  background:var(--fg);color:var(--bg);padding:10px 16px;border-radius:999px;z-index:60;animation:rise .25s ease both}
.debug{position:fixed;inset-block-end:0;inset-inline:0;max-height:40vh;overflow:auto;background:#7a0b0b;color:#fff;
  z-index:70;font-family:ui-monospace,monospace;font-size:.8rem;padding:0}
.debug header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 12px;background:#9b0d0d;font-weight:700;position:sticky;top:0}
.debug ol{margin:0;padding:10px 16px}
.debug li{margin-bottom:6px;white-space:pre-wrap}
.debug button{background:#fff;color:#7a0b0b;border:0;border-radius:8px;padding:4px 10px;font:inherit;font-weight:700;cursor:pointer}
.is-broken{display:none!important}
/* Content is visible by default. The hidden state requires BOTH the JS class and
   IntersectionObserver support, and is disabled for reduced motion. The head
   fallback timer adds the .in class to everything after one second regardless. */
@media (prefers-reduced-motion: no-preference){
  .js.io .reveal:not(.in){opacity:0;transform:translateY(14px);transition:opacity .45s ease,transform .45s ease}
  .js.io .reveal.in{opacity:1;transform:none}
}
`;

const HEAD_JS = String.raw`(function(){
  "use strict";
  var d = document.documentElement;
  function revealAll(){
    try{
      var els = document.querySelectorAll(".reveal");
      for(var i=0;i<els.length;i++) els[i].classList.add("in");
    }catch(e){}
  }
  try{ d.classList.add("js"); }catch(e){}
  /* This timer is registered before anything else can fail. It is completely
     independent from the client script, so the content can never stay hidden. */
  try{ window.setTimeout(revealAll, 1000); }catch(e){}
  try{ window.addEventListener("error", revealAll); }catch(e){}
  try{
    if("IntersectionObserver" in window){
      var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
      if(!mq || !mq.matches) d.classList.add("io");
    }
  }catch(e){}
})();`;

const DOWNLOAD_ICON_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>`;

const CLIENT_JS = String.raw`(function(){
  "use strict";
  var ICON_DL = ${JSON.stringify(DOWNLOAD_ICON_SVG)};
  var boot = {};
  try{ boot = JSON.parse(document.getElementById("boot").textContent || "{}"); }catch(e){ boot = {}; }
  var S = boot.strings || {};
  var debug = !!boot.debug;
  var LANG = boot.lang === "en" ? "en" : "fa";
  var errors = [];
  var ZIP_CONCURRENCY = 2;
  var ZIP_MAX_ITEMS = 30;

  function report(msg){
    var line = String(msg);
    errors.push(line);
    if(!debug) return;
    var list = document.getElementById("debugList");
    if(!list) return;
    var empty = list.querySelector(".hint");
    if(empty && empty.parentNode === list) list.removeChild(empty);
    var li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
  }

  function onError(label, fn){
    try{ fn(); }
    catch(e){ report((label || "init") + ": " + ((e && e.message) || e)); }
  }

  if(debug){
    window.addEventListener("error", function(ev){
      report("Error: " + (ev.message || "") + " @" + (ev.filename || "") + ":" + (ev.lineno || ""));
    });
    window.addEventListener("unhandledrejection", function(ev){
      report("UnhandledRejection: " + (ev.reason && ev.reason.message ? ev.reason.message : ev.reason));
    });
  }

  function $(id){ return document.getElementById(id); }
  function esc(value){
    return String(value == null ? "" : value).replace(/[&<>"']/g, function(c){
      return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c];
    });
  }
  function safeHref(value, fallback){
    var raw = String(value == null ? "" : value).trim();
    if(!raw) return fallback || "#";
    if(raw.charAt(0) === "#") return raw;
    try{
      var u = new URL(raw);
      if(u.protocol !== "https:") return fallback || "#";
      return u.toString();
    }catch(e){ return fallback || "#"; }
  }
  function toast(msg){
    var t = $("toast");
    if(!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function(){ t.hidden = true; }, 2600);
  }
  function setStatus(msg, kind){
    var s = $("status");
    if(!s) return;
    s.textContent = msg || "";
    s.className = "status" + (kind ? " " + kind : "");
  }
  function extractInstagramUrl(text){
    var s = String(text == null ? "" : text).trim();
    if(!s) return "";
    var m = s.match(/https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/i);
    if(m) return m[0];
    if(/^(?:www\.)?instagram\.com\//i.test(s)) return "https://" + s;
    return s;
  }
  function fmtBytes(n){
    if(n == null || isNaN(Number(n))) return "";
    var b = Number(n), units = ["B","KB","MB","GB"], i = 0;
    while(b >= 1024 && i < units.length - 1){ b /= 1024; i++; }
    return (b >= 10 || i === 0 ? b.toFixed(0) : b.toFixed(1)) + " " + units[i];
  }
  function fmtDuration(value, unit){
    var n = Number(value);
    if(!isFinite(n) || n <= 0) return "";
    var seconds;
    if(unit === "ms") seconds = n / 1000;
    else if(unit === "s") seconds = n;
    else seconds = n >= 1000 ? n / 1000 : n;
    var total = Math.max(0, Math.round(seconds));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var sec = total % 60;
    if(h > 0) return h + ":" + (m < 10 ? "0" : "") + m + ":" + (sec < 10 ? "0" : "") + sec;
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }
  function thumbUrl(url){ return "/api/v1/thumbnail?url=" + encodeURIComponent(url); }
  function dlUrl(url, quality, index, inline){
    return "/api/v1/download?url=" + encodeURIComponent(url) +
      "&quality=" + encodeURIComponent(quality || "best") +
      "&index=" + (index || 0) + (inline ? "&inline=1" : "");
  }

  // ---- mobile menu (only armed after successful init) ----
  onError("menu", function(){
    var menuBtn = $("menuBtn"), nav = $("nav");
    if(!menuBtn || !nav) return;
    function setOpen(open){
      nav.classList.toggle("open", open);
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
      menuBtn.setAttribute("aria-label", open ? (S.menu_close || "") : (S.menu_open || ""));
    }
    menuBtn.addEventListener("click", function(){ setOpen(!nav.classList.contains("open")); });
    nav.addEventListener("click", function(ev){ if(ev.target && ev.target.tagName === "A") setOpen(false); });
    document.addEventListener("keydown", function(ev){ if(ev.key === "Escape") setOpen(false); });
    window.addEventListener("resize", function(){ if(window.innerWidth >= 900) setOpen(false); });
    document.body.classList.add("nav-ready");
  });

  // ---- reveal on scroll (progressive; the head timer is the safety net) ----
  onError("reveal", function(){
    var els = document.querySelectorAll(".reveal");
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if(reduce || !("IntersectionObserver" in window)){
      for(var i=0;i<els.length;i++) els[i].classList.add("in");
      return;
    }
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if(en.isIntersecting){ en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.04 });
    for(var j=0;j<els.length;j++) io.observe(els[j]);
  });

  // ---- paste / clear ----
  onError("paste", function(){
    var input = $("urlInput");
    var pasteBtn = $("pasteBtn");
    if(input){
      input.addEventListener("paste", function(ev){
        var data = ev.clipboardData || window.clipboardData;
        if(!data) return;
        var text = data.getData("text");
        var url = extractInstagramUrl(text);
        if(url && url !== text){
          ev.preventDefault();
          input.value = url;
          toast(S.paste_success || "");
        }
      });
    }
    if(!pasteBtn || !input) return;
    pasteBtn.addEventListener("click", function(){
      if(!navigator.clipboard || !navigator.clipboard.readText){
        toast(S.paste_fail || ""); return;
      }
      navigator.clipboard.readText().then(function(text){
        input.value = extractInstagramUrl(text);
        toast(S.paste_success || "");
      }, function(){ toast(S.paste_fail || ""); });
    });
  });
  onError("clear", function(){
    var clearBtn = $("clearBtn");
    if(!clearBtn) return;
    clearBtn.addEventListener("click", function(){
      var input = $("urlInput");
      if(input) input.value = "";
      setStatus("");
      var box = $("resultBox");
      if(box) box.innerHTML = '<p class="hint placeholder">' + esc(S.result_placeholder || "") + "</p>";
    });
  });

  // ---- result rendering ----
  function variantLabel(v){
    var q = v.quality || S.quality_best || "default";
    var om = /^option-(\d+)$/.exec(String(q));
    if(om) q = (S.option_label || "Option") + " " + om[1];
    var parts = [q];
    if(v.width && v.height) parts.push(v.width + "×" + v.height);
    var size = fmtBytes(v.size);
    if(size) parts.push(size);
    if(v.mime) parts.push(String(v.mime).replace("video/", "").replace("image/", ""));
    return parts.join(" · ");
  }

  function typeLabel(type){
    if(type === "video") return S.type_video || "video";
    if(type === "image") return S.type_image || "image";
    if(type === "album") return S.type_album || "album";
    return type || "";
  }

  function attachImageFallbacks(root){
    var imgs = root.querySelectorAll("img[data-thumb]");
    for(var i=0;i<imgs.length;i++){
      imgs[i].addEventListener("error", function(){ this.classList.add("is-broken"); });
    }
  }

  function renderResult(data){
    var box = $("resultBox");
    if(!box || !data) return;
    var items = Array.isArray(data.items) ? data.items : [];
    var first = items[0] || {};
    var variants = Array.isArray(first.variants) ? first.variants : [];
    var v0 = variants[0] || {};
    var author = data.author || {};
    var sourceHref = safeHref(data.source_url, "#");
    var poster = data.thumbnail ? esc(thumbUrl(data.thumbnail)) : "";
    var html = "";

    html += '<div class="card preview">';
    html += '<div class="media-box';
    if(!data.thumbnail && data.type !== "video") html += " empty";
    html += '">';
    if(data.type === "video" && v0.url){
      html += '<video controls preload="metadata" playsinline' + (poster ? ' poster="' + poster + '"' : "") +
        ' src="' + esc(dlUrl(data.source_url, v0.quality, 0, true)) + '"></video>';
    } else if(data.thumbnail){
      html += '<img loading="lazy" data-thumb src="' + poster + '" alt="' + esc(S.preview || "") + '">';
    } else {
      html += esc(S.no_result || "");
    }
    html += "</div>";

    html += '<div class="meta"><div class="author"><div>';
    html += "<b>@" + esc(author.username || "instagram") + "</b>";
    if(author.full_name) html += '<div class="hint">' + esc(author.full_name) + "</div>";
    html += "</div></div>";

    html += '<div class="chips"><span class="pill">' + esc(typeLabel(data.type)) + "</span>";
    if(items.length) html += '<span class="pill">' + esc(S.items || "") + ": " + items.length + "</span>";
    var duration = fmtDuration(data.duration, "s");
    if(duration) html += '<span class="pill">' + esc(S.duration || "") + ": " + esc(duration) + "</span>";
    if(v0.width && v0.height){
      html += '<span class="pill">' + esc(S.dimensions || "") + ": " + esc(v0.width + "×" + v0.height) + "</span>";
    }
    var size = fmtBytes(v0.size);
    if(size) html += '<span class="pill">' + esc(S.file_size || "") + ": " + esc(size) + "</span>";
    html += "</div>";

    if(sourceHref !== "#"){
      html += '<div class="hint">' + esc(S.source || "") + ': <a dir="ltr" href="' + esc(sourceHref) +
        '" rel="noopener nofollow" target="_blank">' + esc(data.source_url) + "</a></div>";
    }
    if(data.caption) html += '<div class="caption">' + esc(data.caption) + "</div>";

    if(data.type !== "album" && items.length === 1){
      if(variants.length){
        html += '<div class="variants" role="radiogroup" aria-label="' + esc(S.quality_label || "") + '">';
        variants.forEach(function(v, vi){
          html += '<div class="variant">';
          html += '<input type="radio" id="q' + vi + '" name="quality" value="' + esc(v.quality) +
            '" data-index="' + vi + '"' + (vi === 0 ? " checked" : "") + ">";
          html += '<label for="q' + vi + '" class="v-info"><b>' + esc(variantLabel(v)) + "</b>";
          if(v.has_audio === false) html += "<span>" + esc(S.audio_only || "") + "</span>";
          html += "</label></div>";
        });
        html += "</div>";
        if(variants.length < 2) html += '<p class="hint">' + esc(S.only_one_quality || "") + "</p>";
        html += '<div class="download-row"><a id="primaryDownload" class="btn primary" href="' +
          esc(dlUrl(data.source_url, v0.quality, 0)) + '" download="' + esc(v0.filename || "media") + '">' +
          ICON_DL + "<span>" + esc(S.download || "") + "</span></a></div>";
      } else {
        html += '<p class="hint">' + esc(S.no_result || "") + "</p>";
      }
    }

    if(data.type === "album" || items.length > 1){
      if(data.type === "album") html += "<h3>" + esc(S.album_title || "") + "</h3>";
      html += '<div class="album-grid">';
      items.forEach(function(item, ii){
        var iv = (item.variants && item.variants[0]) || {};
        var thumb = item.thumbnail || (item.type === "image" ? iv.url : "");
        html += '<div class="album-item"><div class="thumb';
        if(!thumb) html += " empty";
        html += '">';
        if(thumb) html += '<img loading="lazy" data-thumb src="' + esc(thumbUrl(thumb)) + '" alt="">';
        else html += esc(typeLabel(item.type));
        html += '</div><div class="body"><small>' + esc(S.album_item || "") + " " + (ii + 1) + "</small>";
        html += '<a class="btn primary small" href="' + esc(dlUrl(data.source_url, iv.quality, ii)) +
          '" download="' + esc(iv.filename || "media") + '">' + ICON_DL + "<span>" +
          esc(S.download || "") + "</span></a>";
        html += "</div></div>";
      });
      html += "</div>";
      html += '<div class="download-row"><button id="zipBtn" class="btn ghost" type="button">' +
        esc(S.btn_download_all || "") + "</button></div>";
    }

    html += "</div></div>";
    box.innerHTML = html;
    attachImageFallbacks(box);

    onError("quality", function(){
      var radios = box.querySelectorAll("input[name=quality]");
      var primary = $("primaryDownload");
      function sync(){
        if(!primary) return;
        var checked = box.querySelector("input[name=quality]:checked");
        if(!checked) return;
        var vi = Number(checked.getAttribute("data-index"));
        var v = (first.variants || [])[vi];
        if(!v) return;
        primary.setAttribute("href", dlUrl(data.source_url, v.quality, 0));
        primary.setAttribute("download", v.filename || "media");
      }
      for(var i=0;i<radios.length;i++) radios[i].addEventListener("change", sync);
      sync();
    });

    onError("zip", function(){
      var zipBtn = $("zipBtn");
      if(zipBtn) zipBtn.addEventListener("click", function(){ downloadAlbumZip(data); });
    });
  }

  // ---- album ZIP (bounded concurrency; direct-to-disk when supported) ----
  var CRC_TABLE = (function(){
    var table = new Uint32Array(256);
    for(var n=0;n<256;n++){
      var c = n;
      for(var k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc32Update(crc, bytes){
    for(var i=0;i<bytes.length;i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return crc >>> 0;
  }
  function u16(v){ return new Uint8Array([v & 0xff, (v >>> 8) & 0xff]); }
  function u32(v){ return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]); }
  function cat(arrays){
    var len = 0, i;
    for(i=0;i<arrays.length;i++) len += arrays[i].length;
    var out = new Uint8Array(len), pos = 0;
    for(i=0;i<arrays.length;i++){ out.set(arrays[i], pos); pos += arrays[i].length; }
    return out;
  }
  function zipHeader(nameBytes, crc, size, offset, isCentral){
    var head, dv;
    if(isCentral){
      head = new Uint8Array(46 + nameBytes.length);
      dv = new DataView(head.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
      dv.setUint16(8, 0x0808, true);
      dv.setUint16(10, 0, true); dv.setUint16(12, 0, true); dv.setUint16(14, 0, true);
      dv.setUint32(16, crc >>> 0, true);
      dv.setUint32(20, size >>> 0, true);
      dv.setUint32(24, size >>> 0, true);
      dv.setUint16(28, nameBytes.length, true);
      dv.setUint16(30, 0, true); dv.setUint16(32, 0, true);
      dv.setUint16(34, 0, true); dv.setUint16(36, 0, true);
      dv.setUint32(38, 0, true);
      dv.setUint32(42, offset >>> 0, true);
    } else {
      head = new Uint8Array(30 + nameBytes.length);
      dv = new DataView(head.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0808, true);
      dv.setUint16(8, 0, true); dv.setUint16(10, 0, true); dv.setUint16(12, 0, true);
      dv.setUint32(14, 0, true); dv.setUint32(18, 0, true); dv.setUint32(22, 0, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
    }
    head.set(nameBytes, isCentral ? 46 : 30);
    return head;
  }
  function zipDescriptor(crc, size){
    return cat([u32(0x08074b50), u32(crc >>> 0), u32(size >>> 0), u32(size >>> 0)]);
  }
  function zipEnd(entries, centralSize, centralOffset){
    var end = new Uint8Array(22);
    var dv = new DataView(end.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(4, 0, true); dv.setUint16(6, 0, true);
    dv.setUint16(8, entries, true); dv.setUint16(10, entries, true);
    dv.setUint32(12, centralSize, true); dv.setUint32(16, centralOffset, true);
    dv.setUint16(20, 0, true);
    return end;
  }
  function safeName(name){
    return String(name || "media").replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 120) || "media";
  }
  function zipName(data){
    var who = (data.author && data.author.username) ? data.author.username : "instagram";
    return safeName(who + "_" + (data.shortcode || "album")) + ".zip";
  }
  function albumEntries(data){
    var items = Array.isArray(data.items) ? data.items : [];
    return items.map(function(item, ii){
      var v = (item.variants && item.variants[0]) || {};
      return {
        url: dlUrl(data.source_url, v.quality, ii),
        name: safeName(v.filename || ("item_" + (ii + 1) + ".bin"))
      };
    });
  }

  async function streamZip(entries, writable){
    var enc = new TextEncoder();
    var offset = 0;
    var central = [];
    var failed = 0;
    var written = 0;
    for(var i=0;i<entries.length;i++){
      toast((S.zip_progress || "") + " " + (i + 1) + "/" + entries.length);
      var res;
      try{
        res = await fetch(entries[i].url, { headers: { accept: "*/*" } });
        if(!res.ok) throw new Error("http_" + res.status);
        if(!res.body || !res.body.getReader) throw new Error("no_stream");
      }catch(e){
        failed++;
        report("zip item " + i + " failed: " + ((e && e.message) || e));
        continue;
      }
      var nameBytes = enc.encode(entries[i].name);
      var localOffset = offset;
      var local = zipHeader(nameBytes, 0, 0, 0, false);
      await writable.write(local);
      offset += local.length;
      var reader = res.body.getReader();
      var crc = 0xffffffff;
      var size = 0;
      while(true){
        var part = await reader.read();
        if(part.done) break;
        var chunk = part.value;
        crc = crc32Update(crc, chunk);
        size += chunk.length;
        await writable.write(chunk);
        offset += chunk.length;
      }
      var finalCrc = (crc ^ 0xffffffff) >>> 0;
      var desc = zipDescriptor(finalCrc, size);
      await writable.write(desc);
      offset += desc.length;
      central.push(zipHeader(nameBytes, finalCrc, size, localOffset, true));
      written++;
    }
    if(!written) throw new Error("zip_no_items");
    var cd = cat(central);
    var centralOffset = offset;
    await writable.write(cd);
    offset += cd.length;
    await writable.write(zipEnd(written, cd.length, centralOffset));
    return { failed: failed, written: written };
  }

  async function bufferedZip(entries){
    var results = new Array(entries.length);
    var next = 0;
    var failed = 0;
    async function worker(){
      while(next < entries.length){
        var i = next++;
        try{
          var res = await fetch(entries[i].url, { headers: { accept: "*/*" } });
          if(!res.ok || !res.body) throw new Error("http_" + res.status);
          var reader = res.body.getReader();
          var chunks = [];
          while(true){
            var part = await reader.read();
            if(part.done) break;
            chunks.push(part.value);
          }
          results[i] = chunks;
        }catch(e){
          failed++;
          report("zip item " + i + " failed: " + ((e && e.message) || e));
        }
      }
    }
    var pool = [];
    for(var p=0;p<Math.min(ZIP_CONCURRENCY, entries.length);p++) pool.push(worker());
    await Promise.all(pool);

    var enc = new TextEncoder();
    var parts = [];
    var central = [];
    var offset = 0;
    var written = 0;
    for(var j=0;j<entries.length;j++){
      var chunks = results[j];
      if(!chunks) continue;
      var nameBytes = enc.encode(entries[j].name);
      var crc = 0xffffffff;
      var size = 0;
      for(var c=0;c<chunks.length;c++){ crc = crc32Update(crc, chunks[c]); size += chunks[c].length; }
      var finalCrc = (crc ^ 0xffffffff) >>> 0;
      var localOffset = offset;
      var local = zipHeader(nameBytes, 0, 0, 0, false);
      parts.push(local);
      offset += local.length;
      for(var d=0;d<chunks.length;d++){ parts.push(chunks[d]); offset += chunks[d].length; }
      var desc = zipDescriptor(finalCrc, size);
      parts.push(desc);
      offset += desc.length;
      central.push(zipHeader(nameBytes, finalCrc, size, localOffset, true));
      written++;
    }
    if(!written) throw new Error("zip_no_items");
    var cd = cat(central);
    var centralOffset = offset;
    parts.push(cd);
    offset += cd.length;
    parts.push(zipEnd(written, cd.length, centralOffset));
    return { blob: new Blob(parts, { type: "application/zip" }), failed: failed };
  }

  async function downloadAlbumZip(data){
    var entries = albumEntries(data);
    if(!entries.length){ toast(S.no_result || ""); return; }
    if(entries.length > ZIP_MAX_ITEMS){ toast(S.zip_too_many || ""); return; }
    toast(S.zip_preparing || "");
    var name = zipName(data);

    if(typeof window.showSaveFilePicker === "function"){
      var writable = null;
      try{
        var handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }]
        });
        writable = await handle.createWritable();
        var result = await streamZip(entries, writable);
        await writable.close();
        toast(result.failed ? (S.zip_partial || "") : (S.zip_done || ""));
        return;
      }catch(e){
        if(e && e.name === "AbortError") return;
        report("zip stream failed: " + ((e && e.message) || e));
        if(writable){ try{ await writable.abort(); }catch(ignore){} }
      }
    }

    toast(S.zip_stream_unsupported || "");
    try{
      var built = await bufferedZip(entries);
      var href = URL.createObjectURL(built.blob);
      var a = document.createElement("a");
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function(){ URL.revokeObjectURL(href); }, 4000);
      toast(built.failed ? (S.zip_partial || "") : (S.zip_done || ""));
    }catch(e){
      report("zip failed: " + ((e && e.message) || e));
      toast(S.zip_failed || "");
    }
  }

  // ---- resolve ----
  var resolveSeq = 0;
  var resolveAbort = null;

  function resolve(){
    var input = $("urlInput");
    if(!input) return;
    var url = extractInstagramUrl(input.value);
    if(!url){
      setStatus((S.err_prefix || "") + ": " + (S.input_label || ""), "err");
      return;
    }
    var seq = ++resolveSeq;
    if(resolveAbort){ try{ resolveAbort.abort(); }catch(e){} }
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    resolveAbort = controller;
    setStatus(S.status_resolving || "");
    var sk = $("skeleton");
    if(sk) sk.hidden = false;
    var key = $("apiKeyInput") ? $("apiKeyInput").value.trim() : "";
    var headers = { accept: "application/json" };
    if(key) headers["x-api-key"] = key;

    fetch("/api/v1/resolve?url=" + encodeURIComponent(url) + "&lang=" + LANG, {
      headers: headers,
      signal: controller ? controller.signal : undefined
    })
      .then(function(res){
        return res.text().then(function(text){
          var body = null;
          try{ body = text ? JSON.parse(text) : null; }catch(e){ body = null; }
          return { status: res.status, body: body };
        });
      })
      .then(function(out){
        if(seq !== resolveSeq) return;
        var sk2 = $("skeleton"); if(sk2) sk2.hidden = true;
        if(!out.body || out.body.ok !== true){
          var code = out.body && out.body.error ? out.body.error.code : "E_INTERNAL";
          var message = out.body && out.body.error ? out.body.error.message : (S.offline_hint || "");
          setStatus((S.err_prefix || "") + " " + code + ": " + message, "err");
          return;
        }
        setStatus(S.status_ok || "", "ok");
        renderResult(out.body.data);
        try{ var box = $("result"); if(box) box.scrollIntoView({ behavior: "smooth", block: "start" }); }catch(e){}
      })
      .catch(function(err){
        if(seq !== resolveSeq) return;
        var sk3 = $("skeleton"); if(sk3) sk3.hidden = true;
        if(err && err.name === "AbortError") return;
        setStatus((S.err_prefix || "") + ": " + (S.offline_hint || (err && err.message) || ""), "err");
        report("resolve failed: " + ((err && err.message) || err));
      });
  }

  onError("form", function(){
    var form = $("resolveForm");
    if(form) form.addEventListener("submit", function(ev){ ev.preventDefault(); resolve(); });
  });
  onError("debug", function(){
    var clearBtn = $("debugClear");
    if(!clearBtn) return;
    clearBtn.addEventListener("click", function(){
      errors.length = 0;
      var list = $("debugList");
      if(list) list.innerHTML = '<li class="hint">' + esc(S.debug_empty || "") + "</li>";
    });
  });

  // Exposed for tests/debugging only in ?debug=1 mode.
  if(debug){
    window.__insta = {
      resolve: resolve,
      renderResult: renderResult,
      fmtBytes: fmtBytes,
      fmtDuration: fmtDuration,
      errors: errors
    };
  }
})();`;
