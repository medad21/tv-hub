// Language check, no network: APP_LANG=en turns Telegram messages, console output and reports into English, the
// dictionary is complete and consistent, and the default (Persian) is left exactly as it was. Run: npm test
const assert = require('assert');
process.env.APP_LANG = 'en';
process.env.TELEGRAM_TOKEN = 'TESTTOKEN'; process.env.TELEGRAM_CHAT_ID = '42';
const FA = /[\u0620-\u063F\u0641-\u064A\u0671-\u06D3\u06D5\u06FA-\u06FF]/;
let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ok  ' + m); };

const sent = [];
global.fetch = async (url, opt) => { sent.push(JSON.parse(opt.body).text); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };

(async () => {
  const lang = require('./lang');
  ok(lang.LANG === 'en', 'APP_LANG=en is picked up');
  ok(lang.tr('✅ داده‌ی بازار برگشت.') === '✅ Market data is back.', 'a plain message is translated');
  ok(lang.tr('⏸ ورود جدید متوقف است: سقف ضرر روزانه') .startsWith('⏸ New entries are halted:'), 'a message with a value keeps the value');
  ok(lang.tr('تایم‌فریم ربات از ۱۵ دقیقه به ۱ ساعت عوض شود؟\n\n۲ پوزیشن باز دارید؛ با استاپ/هدف قبلی‌اش می‌ماند.').includes('\n\n'), 'multi-line texts are translated line by line');
  ok(lang.tr('hello') === 'hello' && lang.tr(42) === 42, 'text without Persian and non-strings pass through');
  ok(lang.tr('یک جمله‌ی ناشناخته') === 'یک جمله‌ی ناشناخته', 'unknown Persian is left as it is (nothing is lost)');

  // everything that goes to Telegram passes through notify.js
  const notifier = require('./notify');
  await notifier.send('✅ داده‌ی بازار برگشت.'); await notifier.flush(500);
  ok(sent.length === 1 && sent[0] === '✅ Market data is back.', 'Telegram receives the English text');
  const card = require('./signal-card');
  const msg = card.sellCard ? String(card.sellCard({ symbol: 'BINANCE:BTCUSDT', price: 100, strategyName: 'اصلاح موقت (RSI)', tf: '15', time: Date.now() }) || '') : '';
  ok(!msg || !FA.test(lang.tr(msg).replace(/اصلاح موقت \(RSI\)/g, '')), 'a real signal card has no Persian left after translation');

  // the shared dictionary translates completely (every entry, with sample values filled in)
  const sandbox = {}; new Function('window', require('fs').readFileSync(require('path').join(__dirname, 'public', 'i18n-en.js'), 'utf8'))(sandbox);
  const D = sandbox.I18N_EN; let bad = 0;
  for (const k of Object.keys(D.exact)) if (FA.test(lang.tr(k))) { bad++; console.log('  leftover:', k.slice(0, 70)); }
  for (const k0 of Object.keys(D.patterns)) {
    const k = k0.replace(/^\^/, '').replace(/\$$/, '').replace(/\{#\}/g, '12').replace(/\{\}/g, '42');
    if (FA.test(lang.tr(k))) { bad++; console.log('  leftover:', k0.slice(0, 70)); }
  }
  ok(bad === 0, `all ${Object.keys(D.exact).length + Object.keys(D.patterns).length} dictionary entries translate completely`);

  // the default language must not change a single character
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', "process.env.APP_LANG='fa';const l=require('./lang');process.stdout.write(l.tr('✅ داده‌ی بازار برگشت.'))"], { cwd: __dirname }).toString();
  ok(out === '✅ داده‌ی بازار برگشت.', 'APP_LANG=fa (default) leaves Persian untouched');
  console.log(`\n${n} language checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
