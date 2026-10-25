'use strict';
// Telegram's documented InlineKeyboardButton schema does not include a stable
// style/color field. Keep semantic helpers, but emit only supported fields;
// callers provide the visible color emoji in localized labels when desired.
function btn(text, callback_data) {
  return { text, callback_data };
}
const G = (t, c) => btn(t, c);
const B = (t, c) => btn(t, c);
const R = (t, c) => btn(t, c);
const URLB = (t, url) => ({ text: t, url });

function kb(rows) { return { inline_keyboard: rows.filter((r) => r && r.length) }; }

module.exports = { btn, G, B, R, URLB, kb };
