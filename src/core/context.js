'use strict';
// Shared bot context: per-user language, store handles, helpers.
const { getStore } = require('./store');
const config = require('../config');
const i18n = require('../i18n/engine');

const store = getStore();

function userLang(userId, chat) {
  if (chat && chat.type !== 'private') {
    const g = store.get('chats', String(chat.id));
    if (g && g.lang) return g.lang;
  }
  const u = store.get('users', String(userId));
  return i18n.pick(u && u.lang);
}
function setUserLang(userId, lang) {
  const u = store.get('users', String(userId)) || {};
  u.lang = lang;
  store.set('users', String(userId), u);
}
function setChatLang(chatId, lang) {
  const c = store.get('chats', String(chatId)) || {};
  c.lang = lang;
  store.set('chats', String(chatId), c);
}
function chatSettings(chatId) {
  return store.get('chats', String(chatId)) || { smart: true, autodel: 0, lang: null };
}
function setChatSettings(chatId, s) { store.set('chats', String(chatId), s); }

function trackUser(from, chat) {
  if (!from) return;
  const id = String(from.id);
  const u = store.get('users', id) || { first: Date.now() };
  u.name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  u.username = from.username || null;
  u.last = Date.now();
  if (!u.lang) u.lang = from.language_code || 'fa';
  store.set('users', id, u);
  if (chat && chat.type !== 'private') {
    const g = store.get('chats', String(chat.id)) || { first: Date.now(), smart: true, autodel: 0 };
    g.title = chat.title || '';
    g.last = Date.now();
    store.set('chats', String(chat.id), g);
  }
}

function isOwner(id) { return Number(id) === config.ownerId; }

// panel state kept in memory (per user): navigation stack
const panels = new Map(); // `${chatId}:${msgId}` -> {stack:[{name,params}], current}
function panelKey(chatId, userId) { return `${chatId}:${userId}`; }
function getPanel(chatId, userId) { return panels.get(panelKey(chatId, userId)); }
function setPanel(chatId, userId, p) { panels.set(panelKey(chatId, userId), p); }

module.exports = { store, i18n, userLang, setUserLang, setChatLang, chatSettings, setChatSettings, trackUser, isOwner, panels, getPanel, setPanel, panelKey };
