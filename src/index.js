'use strict';
// Cloudflare Worker entry for the cPanel bot (exact port)
// Adapts grammY-style code to Cloudflare Workers fetch handler.
const config = require('./config');
const { Bot, webhookCallback } = require('grammy');

// Lazy-load the full bot only once
let bot = null;
let handler = null;

function getBot() {
  if (bot) return bot;
  bot = new Bot(config.botToken);
  // Load all handlers from the original bot setup
  require('./bot/handlers');
  require('./bot/admin');
  require('./bot/channel');
  return bot;
}

module.exports = {
  async fetch(request, env, ctx) {
    // Override config with env bindings
    if (env.BOT_TOKEN) process.env.BOT_TOKEN = env.BOT_TOKEN;
    if (env.OWNER_ID) process.env.OWNER_ID = env.OWNER_ID;
    if (env.SOUNDCLOUD_API_URL) process.env.SOUNDCLOUD_API_URL = env.SOUNDCLOUD_API_URL;
    if (env.SHAZAM_API_URL) process.env.SHAZAM_API_URL = env.SHAZAM_API_URL;
    if (env.INSTA_API_URL) process.env.INSTA_API_URL = env.INSTA_API_URL;
    if (env.WEBHOOK_SECRET) process.env.WEBHOOK_SECRET = env.WEBHOOK_SECRET;
    if (env.CRON_SECRET) process.env.CRON_SECRET = env.CRON_SECRET;
    if (env.HEAVY_AUDIO_URL) process.env.HEAVY_AUDIO_URL = env.HEAVY_AUDIO_URL;
    if (env.PUBLIC_URL) process.env.PUBLIC_URL = env.PUBLIC_URL;
    if (env.CF_WORKER) process.env.CF_WORKER = env.CF_WORKER;

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, worker: true }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/cron/' + (env.CRON_SECRET || '')) {
      try { const ch = require('./bot/channel'); if (ch.cronTick) ctx.waitUntil(ch.cronTick()); } catch (e) {}
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }

    // Telegram webhook
    try {
      if (!handler) {
        const b = getBot();
        handler = webhookCallback(b, 'cloudflare-mod');
      }
      return await handler(request);
    } catch (e) {
      return new Response('error', { status: 500 });
    }
  },
  async scheduled(event, env, ctx) {
    if (env.CRON_SECRET) process.env.CRON_SECRET = env.CRON_SECRET;
    if (env.BOT_TOKEN) process.env.BOT_TOKEN = env.BOT_TOKEN;
    if (env.SOUNDCLOUD_API_URL) process.env.SOUNDCLOUD_API_URL = env.SOUNDCLOUD_API_URL;
    if (env.SHAZAM_API_URL) process.env.SHAZAM_API_URL = env.SHAZAM_API_URL;
    if (env.INSTA_API_URL) process.env.INSTA_API_URL = env.INSTA_API_URL;
    if (env.OWNER_ID) process.env.OWNER_ID = env.OWNER_ID;
    try { const ch = require('./bot/channel'); if (ch.cronTick) ctx.waitUntil(ch.cronTick()); } catch (e) {}
  }
};
