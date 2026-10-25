'use strict';
// Inline keyboard builder with color hints (Bot API `style` when available).
function btn(text, callback_data, style) {
  const b = { text, callback_data };
  if (style) b.style = style; // 'success' | 'primary' | 'danger' (recent Bot API)
  return b;
}
const G = (t, c) => btn(t, c, 'success');
const B = (t, c) => btn(t, c, 'primary');
const R = (t, c) => btn(t, c, 'danger');
const URLB = (t, url) => ({ text: t, url });

function kb(rows) { return { inline_keyboard: rows.filter((r) => r && r.length) }; }

module.exports = { btn, G, B, R, URLB, kb };
