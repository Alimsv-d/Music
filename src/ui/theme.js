'use strict';

const THEME = Object.freeze({
  success: 'success',
  primary: 'primary',
  danger: 'danger',
});

function styleFor(kind) {
  return THEME[kind] || THEME.primary;
}

module.exports = { THEME, styleFor };
