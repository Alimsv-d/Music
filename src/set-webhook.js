'use strict';
// Set Telegram webhook using the host app's configured URL and secret.
const config = require('./config');
const { Bot } = require('grammy');

async function main() {
  if (!config.publicUrl || !config.webhookSecret) throw new Error('PUBLIC_URL and WEBHOOK_SECRET are required');
  const bot = new Bot(config.botToken);
  const url = `${config.publicUrl}${config.webhookPath}`;
  await bot.api.setWebhook(url, {
    secret_token: config.webhookSecret,
    allowed_updates: ['message', 'callback_query', 'inline_query', 'my_chat_member', 'chat_member'],
    drop_pending_updates: false,
    max_connections: 40,
  });
  const info = await bot.api.getWebhookInfo();
  process.stdout.write(JSON.stringify({ ok: true, url: info.url, pending_update_count: info.pending_update_count, has_custom_certificate: info.has_custom_certificate }) + '\n');
}
main().catch(() => { process.stderr.write('set-webhook failed\n'); process.exitCode = 1; });
