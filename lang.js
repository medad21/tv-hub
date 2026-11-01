// Language of everything the server writes for humans: Telegram messages, console output, text reports.
// APP_LANG=fa (default) keeps the original Persian. APP_LANG=en translates it with the same dictionary the dashboard
// uses (public/i18n-en.js). Anything the dictionary does not know is sent unchanged, so nothing is ever lost.
// (Not called LANG on purpose: that name is already used by the operating system.)
try { require('dotenv').config(); } catch {}
const fs = require('fs');
const path = require('path');
const core = require('./public/i18n-core.js');

const LANG = String(process.env.APP_LANG || 'fa').trim().toLowerCase() === 'en' ? 'en' : 'fa';

function loadDictionary() {
  const sandbox = {};
  new Function('window', fs.readFileSync(path.join(__dirname, 'public', 'i18n-en.js'), 'utf8'))(sandbox);
  return sandbox.I18N_EN;
}

let T = null;
function translator() { return T || (T = core.create(loadDictionary())); }

// tr(text): English when APP_LANG=en, otherwise the text unchanged. Never throws.
function tr(text) {
  if (LANG !== 'en' || typeof text !== 'string') return text;
  try { return translator().tr(text); } catch { return text; }
}

// Console output (startup lines, backtest tables, warnings) follows the same language.
let patched = false;
function patchConsole() {
  if (LANG !== 'en' || patched) return;
  patched = true;
  for (const m of ['log', 'info', 'warn', 'error']) {
    const orig = console[m].bind(console);
    console[m] = (...args) => orig(...args.map((a) => (typeof a === 'string' ? tr(a) : a)));
  }
}
patchConsole();

module.exports = { LANG, tr, patchConsole, missing: () => (LANG === 'en' ? translator().missing() : []) };
