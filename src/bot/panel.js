'use strict';
// Panel navigation: each panel is ONE specific message (chat_id+message_id)
// with its own back-stack. Callbacks edit only the message they came from.
// /start always sends a NEW message; stale callbacks get a "panel expired" toast.
const { getStore } = require('../core/store');
const store = getStore();

const screens = new Map();
const nav = new Map(); // `${chatId}:${msgId}` -> {stack:[{name,params}], current, ver}
const NAV_KEY = (c, m) => `${c}:${m}`;

function register(name, fn) { screens.set(name, fn); }
function msgIdOf(ctx) {
  if (ctx.callbackQuery && ctx.callbackQuery.message) return ctx.callbackQuery.message.message_id;
  return ctx.panelMsgId || null;
}
function stateFor(chatId, msgId) {
  let s = nav.get(NAV_KEY(chatId, msgId));
  if (!s) { s = { stack: [], current: null, ver: 0 }; nav.set(NAV_KEY(chatId, msgId), s); }
  return s;
}
function clearNav(chatId, msgId) { nav.delete(NAV_KEY(chatId, msgId)); }

async function render(ctx, view, mid) {
  const chatId = ctx.chat.id;
  const markup = { reply_markup: view.keyboard };
  if (mid) {
    try {
      if (view.media) {
        await ctx.api.editMessageMedia(chatId, mid, { type: 'photo', media: view.media, caption: view.text, parse_mode: 'HTML' }, markup);
        return mid;
      }
      await ctx.api.editMessageText(chatId, mid, view.text, { parse_mode: 'HTML', reply_markup: view.keyboard, disable_web_page_preview: true });
      return mid;
    } catch (e) {
      const s = String(e.description || e.message || e);
      if (s.includes('not modified')) return mid;
      // fall through to send a new message
    }
  }
  let m;
  if (view.media) m = await ctx.replyWithPhoto(view.media, { caption: view.text, parse_mode: 'HTML', reply_markup: view.keyboard });
  else m = await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard, disable_web_page_preview: true });
  return m.message_id;
}

async function show(ctx, name, params = {}, { push = true } = {}) {
  const scr = screens.get(name);
  if (!scr) return;
  const view = await scr(ctx, params, ctx.lang);
  if (!view) return;
  const chatId = ctx.chat.id;
  const mid = msgIdOf(ctx);
  const st = mid ? stateFor(chatId, mid) : { stack: [], current: null, ver: 0 };
  if (push && st.current && st.current.name !== name) st.stack.push(st.current);
  st.current = { name, params };
  st.ver++;
  const newMid = await render(ctx, view, mid);
  if (newMid && newMid !== mid) { nav.delete(NAV_KEY(chatId, mid)); nav.set(NAV_KEY(chatId, newMid), st); }
  else if (newMid && !mid) nav.set(NAV_KEY(chatId, newMid), st);
  ctx.panelMsgId = newMid;
  return newMid;
}

async function back(ctx) {
  const chatId = ctx.chat.id;
  const mid = msgIdOf(ctx);
  const st = mid && nav.get(NAV_KEY(chatId, mid));
  if (st && st.stack.length) {
    const prev = st.stack.pop();
    return show(ctx, prev.name, prev.params, { push: false });
  }
  return show(ctx, 'menu', {}, { push: false });
}

// /start: always a fresh message; drop old panel nav for this chat so no stale edit.
async function freshMenu(ctx) {
  const chatId = ctx.chat.id;
  for (const k of [...nav.keys()]) if (k.startsWith(chatId + ':')) nav.delete(k);
  ctx.panelMsgId = null;
  return show(ctx, 'menu', {}, { push: false });
}

module.exports = { register, show, back, stateFor, clearNav, msgIdOf, freshMenu };
