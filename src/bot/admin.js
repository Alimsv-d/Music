'use strict';
const config = require('../config');
const { store, i18n, isOwner } = require('../core/context');
const { t, esc, num } = i18n;
const { kb, G, B, R, URLB } = require('./keyboard');
const panel = require('./panel');
const sc = require('../services/soundcloud');
const sh = require('../services/shazam');
const ig = require('../services/instagram');
const channel = require('./channel');
const log = require('../core/log');

function ownerGuard(ctx) {
  return isOwner(ctx.from.id);
}

panel.register('admin', async (ctx, p, lang) => {
  const s = store.getStats();
  const day = new Date().toISOString().slice(0, 10);
  const users = store.count('users'), groups = store.count('chats');
  const glob = store.get('settings', 'global') || {};
  const onoff = (v) => v !== false ? '✅' : '❌';
  const text = [
    '🛠 <b>مدیریت Music</b>',
    '━━━━━━━━━━━━',
    `${glob.maintenance ? '🔴' : '🟢'} ربات: ${glob.maintenance ? 'نگهداری' : 'روشن'} · ⏱ آپتایم ${fmtUptime(process.uptime())}`,
    `👥 ${num(lang, users)} کاربر · 💬 ${num(lang, groups)} گروه`,
    `📈 امروز: 🔎 ${num(lang, s['day:' + day + ':search'] || 0)} · ⬇️ ${num(lang, s['day:' + day + ':download'] || 0)} · 🎤 ${num(lang, s['day:' + day + ':rec'] || 0)}`,
    `📢 کانال‌ها: ${channel.channels().length} · صف انتشار: ${channel.queueList().length}`,
  ].join('\n');
  const rows = [
    [B('📊 آمار', 'a:stats'), B('📢 کانال‌ها', 'a:chans')],
    [B('🔒 قفل عضویت', 'a:fjlist'), B('📣 پیام همگانی', 'a:bc')],
    [B('🎫 تیکت‌ها', 'a:tickets'), B('🚫 مسدودی‌ها', 'a:bans')],
    [B('🩺 سلامت', 'a:health'), B('⚙️ تنظیمات', 'a:set')],
    [B('🌐 زبان‌ها', 'a:langs'), B('🔌 سرویس‌ها', 'a:features')],
    [R('✖️ بستن', 'nav:close'), B('🔄 رفرش', 'a:panel')],
  ];
  return { text, keyboard: kb(rows) };
});
function fmtUptime(sec) { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? h + 'س ' + m + 'د' : m + ' دقیقه'; }

panel.register('admin_features', async (ctx, p, lang) => {
  const s = store.get('settings', 'features') || {};
  const on = (k) => s[k] !== false;
  const lbl = (k, name) => `${on(k) ? '✅' : '❌'} ${name}`;
  const rows = [
    [B(lbl('search', 'جستجو'), 'feat:search'), B(lbl('insta', 'اینستاگرام'), 'feat:insta')],
    [B(lbl('recog', 'شناسایی آهنگ'), 'feat:recog'), B(lbl('inline', 'حالت inline'), 'feat:inline')],
    [B(lbl('groups', 'گروه‌ها'), 'feat:groups'), B(lbl('channel', 'انتشار خودکار کانال'), 'feat:channel')],
    [R(t(lang, 'back'), 'a:panel')],
  ];
  return { text: '🔌 <b>قابلیت‌ها</b>\nهر یک را روشن/خاموش کن.', keyboard: kb(rows) };
});

panel.register('admin_stats', async (ctx, p, lang) => {
  const s = store.getStats();
  const day = new Date().toISOString().slice(0, 10);
  const users = store.count('users');
  const groups = Object.keys(store.json ? store.json.chats : {}).length || store.count('chats');
  const text = t(lang, 'stats_text', {
    users: num(lang, users), groups: num(lang, groups),
    search: num(lang, s.search || 0), dsearch: num(lang, s['day:' + day + ':search'] || 0),
    download: num(lang, s.download || 0), ddownload: num(lang, s['day:' + day + ':download'] || 0),
    rec: num(lang, s.rec || 0), drec: num(lang, s['day:' + day + ':rec'] || 0),
  });
  return { text, keyboard: kb([[R(t(lang, 'back'), 'a:panel')]]) };
});

panel.register('admin_health', async (ctx, p, lang) => {
  const [a, b, c] = await Promise.all([sc.health(), sh.health(), ig.health()]);
  const fmt = (x) => x.ok ? `✅ ${x.ms}ms` : `❌ ${esc(x.error || 'down')}`;
  const text = t(lang, 'health_text', { sc: fmt(a), sh: fmt(b), ig: fmt(c) });
  return { text, keyboard: kb([[R(t(lang, 'back'), 'a:panel')]]) };
});

panel.register('admin_channels', async (ctx, p, lang) => {
  const chans = channel.channels();
  const rows = [];
  for (const ch of chans) {
    const st = await channel.channelStatus(ctx.api, ch);
    rows.push([B(`${st.ok ? '✅' : '❌'} ${ch.title || ch.id}`, 'ach:' + ch.id), R('🗑', 'achd:' + ch.id)]);
  }
  rows.push([G('➕ ' + t(lang, 'channel_add_ask').split(' ')[0], 'ach:add')]);
  rows.push([R(t(lang, 'back'), 'a:panel')]);
  return { text: t(lang, 'channels_title') + ` (${chans.length})`, keyboard: kb(rows) };
});

panel.register('admin_bans', async (ctx, p, lang) => {
  const bans = store.all('bans');
  const rows = bans.slice(0, 20).map(([k]) => [B('🚫 ' + k, 'aub:' + k)]);
  rows.push([G('➕ ban/unban', 'a:banask')]);
  rows.push([R(t(lang, 'back'), 'a:panel')]);
  return { text: t(lang, 'admin_bans') + ` (${bans.length})`, keyboard: kb(rows) };
});

panel.register('admin_settings', async (ctx, p, lang) => {
  const s = store.get('settings', 'global') || { antispam: true, maintenance: false, forcejoin: [] };
  const fj = Array.isArray(s.forcejoin) ? s.forcejoin : (s.forcejoin ? [s.forcejoin] : []);
  const onoff = (v) => v ? t(lang, 'on') : t(lang, 'off');
  const rows = [
    [B(`🛡 ${t(lang, 'set_antispam', { v: onoff(s.antispam !== false) })}`, 'aset:antispam')],
    [B(`🛠 ${t(lang, 'set_maintenance', { v: onoff(!!s.maintenance) })}`, 'aset:maintenance')],
    [B(`🔒 عضویت اجباری (${fj.length})`, 'a:fjlist')],
    [R(t(lang, 'back'), 'a:panel')],
  ];
  return { text: t(lang, 'settings_title'), keyboard: kb(rows) };
});

panel.register('admin_fj', async (ctx, p, lang) => {
  const s = store.get('settings', 'global') || {};
  const fj = Array.isArray(s.forcejoin) ? s.forcejoin : (s.forcejoin ? [s.forcejoin] : []);
  const rows = fj.map((c, i) => [B(`📢 ${esc(c)}`, 'noop'), R('🗑', 'fjdel:' + i)]);
  rows.push([G('➕ افزودن کانال', 'a:fjadd')]);
  rows.push([R(t(lang, 'back'), 'a:set')]);
  return { text: '🔒 <b>کانال‌های عضویت اجباری</b>\nکاربر برای استفاده باید عضو همه باشد.', keyboard: kb(rows) };
});

panel.register('admin_langs', async (ctx, p, lang) => {
  const langs = i18n.availableLocales();
  const rows = langs.map((c) => { const l = i18n.loadLocale(c); return [B((l.meta && l.meta.name || c) + (l.meta && l.meta.reviewed === false ? ' ⏳' : ''), 'noop')]; });
  rows.push([R(t(lang, 'back'), 'a:panel')]);
  return { text: t(lang, 'admin_langs'), keyboard: kb(rows) };
});

panel.register('admin_tickets', async (ctx, p, lang) => {
  const tickets = store.all('tickets').slice(-15).reverse();
  const rows = tickets.map(([k, tk]) => [B(`#${k} ${tk.open ? '🟢' : '⚪'} ${(tk.text || '').slice(0, 25)}`, 'atk:' + k)]);
  rows.push([R(t(lang, 'back'), 'a:panel')]);
  return { text: t(lang, 'admin_tickets'), keyboard: kb(rows) };
});

// broadcast handled in index via awaiting state
module.exports = { ownerGuard };
