// Call GET /setup on the deployed worker to register webhook + commands.
// Usage: node scripts/setup.mjs <worker-url> <admin_setup_key>

const [,, base, key] = process.argv;
if (!base || !key) {
  console.error("usage: node scripts/setup.mjs <worker-url> <admin_setup_key>");
  process.exit(1);
}
const url = `${base.replace(/\/$/, "")}/setup?key=${encodeURIComponent(key)}`;
const res = await fetch(url);
const body = await res.json().catch(() => ({}));
console.log(JSON.stringify(body, null, 2));
if (!body.ok) process.exit(1);
