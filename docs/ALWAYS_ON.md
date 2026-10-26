# Always-on (cPanel host)

## What keeps the bot alive now
- **Webhook watchdog** — every 5 min the app calls `getWebhookInfo`. If the URL
  drifted or `last_error_message` is set, it re-issues `setWebhook`
  (secret + full `allowed_updates`) and alerts the owner (max 1/hr).
- **In-app scheduler** — cPanel `crontab -e` fails under cagefs (cannot create
  `/tmp/.crontab.lock`), so the app runs its own `setInterval(5min)` for channel
  cron work, in addition to the external `/cron/<secret>` endpoint.
- **Self-test at startup** — getMe, webhook info, and the three service health
  probes are checked ~20s after boot; failures alert the owner.
- **Crash guards** — `uncaughtException` / `unhandledRejection` log instead of
  killing the process; Passenger restarts the app on `tmp/restart.txt` touches.

## External keep-alive (recommended)
`/health` is public and cheap (200, JSON). Any free pinger (UptimeRobot,
cron-job.org, Better Stack) hitting `https://devcoder.ir/health` every ~4min
both keeps Passenger warm and detects outage. `/cron/<secret>` can be pinged the
same way if cron-like ticks must run even when Passenger idles the process.
`crontab -l` cannot be used on this host; the in-app interval is the fallback.
