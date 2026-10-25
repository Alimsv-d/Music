'use strict';
const { styleFor } = require('../ui/theme');

// Telegram may reject style on older Bot API deployments. Callers always build
// semantic styles; the request layer retries once without style for that error.
function btn(text, callback_data, kind = 'primary') {
  return { text, callback_data, style: styleFor(kind) };
}
const G = (t, c) => btn(t, c, 'success');
const B = (t, c) => btn(t, c, 'primary');
const R = (t, c) => btn(t, c, 'danger');
const URLB = (t, url, kind = 'primary') => ({ text: t, url, style: styleFor(kind) });

function kb(rows) { return { inline_keyboard: rows.filter((r) => r && r.length) }; }

module.exports = { btn, G, B, R, URLB, kb };
