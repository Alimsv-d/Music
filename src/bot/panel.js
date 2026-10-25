'use strict';
// UI engine: every interaction edits THE SAME message that was tapped.
// Navigation stack is kept per message_id so "back" always restores the
// previous screen on that same message. No cross-message confusion.
const { getStore } = require('../core/store');
const store = getStore();

const screens = new Map();       // name -> async (ctx, params, lang) => {text, keyboard, media, mediaType}
const navState = new Map();      // `${chatId}:${msgId}` -> {stack:[{name,params}], current}
const NAV_KEY = (c, m) => `${c}:${m}`;

function register(name, fn) { screens.set(name, fn); }

function msgIdOf(ctx) {
  if (ctx.callbackQuery && ctx.callbackQuery.message) return ctx.callbackQuery.message.message_id;
  return ctx.panelMsgId || null;
}

function stateFor(chatId, msgId) {
  let s = navState.get(NAV_KEY(chatId, msgId));
  if (!s) { s = { stack: [], current: null }; navState.set(NAV_KEY(chatId, msgId), s); }
  return s;
}

async function render(ctx, view) {
  const chatId = ctx.chat.id;
  const mid = msgIdOf(ctx);
  const markup = { reply_markup: view.keyboard };
  // If we have a message to edit, prefer editing it in place.
  if (mid) {
    try {
      if (view.media) {
        const media = { type: 'photo', media: view.media, caption: view.text, parse_mode: 'HTML' };
        await ctx.api.editMessageMedia(chatId, mid, media, markup);
        return mid;
      }
      await ctx.api.editMessageText(chatId, mid, view.text, { parse_mode: 'HTML', reply_markup: view.keyboard, disable_web_page_preview: true });
      return mid;
    } catch (e) {
      const s = String(e.description || e.message || e);
      if (s.includes('not modified')) return mid;
      // media->text or text->media mismatch, or message gone: fall through to new message
    }
  }
  // send a fresh message
  let m;
  if (view.media) {
    m = await ctx.replyWithPhoto(view.media, { caption: view.text, parse_mode: 'HTML', reply_markup: view.keyboard });
  } else {
    m = await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard, disable_web_page_preview: true });
  }
  return m.message_id;
}

async function show(ctx, name, params = {}, { push = true } = {}) {
  const scr = screens.get(name);
  if (!scr) return;
  const view = await scr(ctx, params, ctx.lang);
  if (!view) return;
  const chatId = ctx.chat.id;
  const mid = msgIdOf(ctx);
  const st = mid ? stateFor(chatId, mid) : { stack: [], current: null };
  if (push && st.current && st.current.name !== name) st.stack.push(st.current);
  st.current = { name, params };
  const newMid = await render(ctx, view);
  // migrate nav state if message id changed
  if (newMid && mid && newMid !== mid) navState.set(NAV_KEY(chatId, newMid), st);
  else if (newMid && !mid) navState.set(NAV_KEY(chatId, newMid), st);
  ctx.panelMsgId = newMid;
  return newMid;
}

async function back(ctx) {
  const chatId = ctx.chat.id;
  const mid = msgIdOf(ctx);
  const st = mid && stateFor(chatId, mid);
  if (st && st.stack.length) {
    const prev = st.stack.pop();
    return show(ctx, prev.name, prev.params, { push: false });
  }
  return show(ctx, 'menu', {}, { push: false });
}

// For callbacks that must carry the target message across sends (deep-link etc.)
function clearNav(chatId, msgId) { navState.delete(NAV_KEY(chatId, msgId)); }

module.exports = { register, show, back, stateFor, clearNav, msgIdOf };
