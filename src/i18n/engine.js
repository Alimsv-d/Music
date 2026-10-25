'use strict';
const fs = require('node:fs');
const path = require('node:path');

const LOCALES_DIR = __dirname;
const FALLBACK = ['en', 'fa'];
const locales = new Map();

function loadLocale(code) {
  if (locales.has(code)) return locales.get(code);
  try {
    const mod = require(path.join(LOCALES_DIR, code + '.js'));
    locales.set(code, mod);
    return mod;
  } catch (_) {
    locales.set(code, null);
    return null;
  }
}
function availableLocales() {
  return fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.js') && f !== 'index.js' && f !== 'engine.js').map((f) => f.slice(0, -3));
}

const RTL = new Set(['fa', 'ar', 'ckb', 'ps', 'ur', 'he']);
const isRtl = (lang) => RTL.has(lang);
const iso = (s) => '⁨' + s + '⁩'; // bidi isolate for dynamic values

function pick(lang) {
  if (lang && loadLocale(lang)) return lang;
  if (loadLocale('en')) return 'en';
  if (loadLocale('fa')) return 'fa';
  return 'en';
}

function lookup(lang, key) {
  const chain = [];
  if (lang) chain.push(lang);
  // For any non-English locale, use English as the first fallback, then Persian.
  if (lang !== 'en') chain.push('en');
  if (lang !== 'fa') chain.push('fa');
  for (const l of chain) {
    const loc = loadLocale(l);
    if (loc && Object.prototype.hasOwnProperty.call(loc.strings || loc, key)) {
      return (loc.strings || loc)[key];
    }
  }
  return null;
}

function plural(lang, key, n, vars) {
  // key may be an object {zero,one,two,few,many,other} or a string
  const raw = lookup(lang, key);
  const v = { ...(vars || {}), n };
  let form;
  if (raw && typeof raw === 'object') {
    const cat = new Intl.PluralRules(lang).select(n);
    form = raw[cat] !== undefined ? raw[cat] : raw.other;
  } else form = raw;
  if (form == null) return key;
  return interpolate(form, v);
}

function interpolate(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? String(vars[k]) : m));
}

function t(lang, key, vars) {
  const raw = lookup(lang, key);
  if (raw == null) return key;
  const s = typeof raw === 'object' ? (raw.other !== undefined ? raw.other : JSON.stringify(raw)) : raw;
  return interpolate(s, vars);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Truncate by approximate visual width (CJK/Persian/Arabic count more).
function vwidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    w += (cp > 0x2e80 || (cp >= 0x0600 && cp <= 0x06ff)) ? 2 : 1;
  }
  return w;
}
function vtruncate(s, max) {
  let w = 0, out = '';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const cw = (cp > 0x2e80 || (cp >= 0x0600 && cp <= 0x06ff)) ? 2 : 1;
    if (w + cw > max) { out += '…'; break; }
    w += cw; out += ch;
  }
  return out;
}

function num(lang, n) {
  try { return new Intl.NumberFormat(lang === 'ckb' ? 'fa' : lang).format(n); } catch (_) { return String(n); }
}
function dateFmt(lang, d) {
  const loc = lang === 'fa' || lang === 'ckb' || lang === 'ps' ? 'fa-IR-u-ca-persian' : lang;
  try { return new Intl.DateTimeFormat(loc, { dateStyle: 'medium' }).format(d); } catch (_) { return d.toISOString().slice(0, 10); }
}
function dateGreg(lang, d) {
  try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(d); } catch (_) { return d.toISOString().slice(0, 10); }
}

module.exports = { t, plural, esc, iso, isRtl, pick, loadLocale, availableLocales, num, dateFmt, dateGreg, vtruncate, vwidth, interpolate };
