'use strict';
const path = require('node:path');
const fs = require('node:fs');

function loadEnv(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch (_) {}
}
loadEnv(path.join(__dirname, '..', '.env'));

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const config = {
  botToken: req('BOT_TOKEN'),
  ownerId: Number(req('OWNER_ID')),
  ownerUsername: process.env.OWNER_USERNAME || 'AliMsvD',
  ownerName: process.env.OWNER_NAME || 'Ali Mousavi',
  channel: process.env.CHANNEL || '@MusicMsvD',
  // cPanel's Passenger mount is the domain root. PUBLIC_URL may contain the
  // old /music alias; use an explicit PUBLIC_BASE_URL only when truly mounted
  // below a path. This keeps webhook, inline media and /health paths consistent.
  publicUrl: (process.env.PUBLIC_BASE_URL || (() => { try { return new URL(process.env.PUBLIC_URL || '').origin; } catch (_) { return ''; } })()).replace(/\/$/, ''),
  allowChannelTest: process.env.ALLOW_CHANNEL_TEST === '1',
  scApi: (process.env.SOUNDCLOUD_API_URL || '').replace(/\/$/, ''),
  shazamApi: (process.env.SHAZAM_API_URL || '').replace(/\/$/, ''),
  instaApi: (process.env.INSTA_API_URL || '').replace(/\/$/, ''),
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  cronSecret: process.env.CRON_SECRET || '',
  heavyAudioUrl: process.env.HEAVY_AUDIO_URL || '',
  inlineSignSecret: process.env.INLINE_SIGN_SECRET || process.env.CRON_SECRET || '',
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  tmpDir: process.env.TMP_DIR || path.join(__dirname, '..', 'tmp'),
  port: Number(process.env.PORT || 0), // 0 => let cPanel/Passenger assign via PORT env
  webhookPath: '/wh/' + require('node:crypto').createHash('sha256').update(process.env.WEBHOOK_SECRET || 'x').digest('hex').slice(0, 24),
  botUsername: process.env.BOT_USERNAME || 'SearcherMusiic_Bot',
  isWorker: !!process.env.CF_WORKER,
};

for (const d of [config.dataDir, config.tmpDir]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
}

module.exports = config;
