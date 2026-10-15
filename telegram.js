// Control the bot from Telegram. Only the chat in TELEGRAM_CHAT_ID is obeyed. Every message we send goes through
// notify.js (ordered queue + retries).
const bot = require('./bot');
const journal = require('./journal');
const cfg = require('./config');
const notifier = require('./notify');

const settings = require('./telegram-settings'); // token / chat id / proxy: saved from the dashboard, or from .env
const api = async (method, body) => { // long-polling for incoming commands only
  const { token } = settings.get();
  const r = await settings.fetchFn()(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
};

const px = (x) => (x == null ? '—' : Number(x).toPrecision(6)); // tp is null once a staged exit lifted the fixed target
const money = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;
const tick = (sym) => String(sym).split(':')[1] || sym;

const status = (p) => [
  `Equity ${p.equity.toFixed(2)} | Day ${p.dayPnlPct.toFixed(2)}% | Drawdown ${p.drawdownPct.toFixed(2)}%`,
  `Realized ${p.realized.toFixed(2)} | Win/Loss ${p.wins}/${p.losses} | Mode ${p.mode}`,
  p.halted ? `⏸ New entries halted: ${p.haltReason}` : '▶ Running',
  ...p.positions.map((x) => `${x.symbol} ${x.pnlPct.toFixed(2)}% | SL ${px(x.sl)} TP ${px(x.tp)}`),
].join('\n');

const positions = (p) => p.positions.length
  ? p.positions.map((x) => `${x.symbol}  ${x.pnlPct >= 0 ? '🟢' : '🔴'} ${money(x.pnlPct)}٪  (${money(x.qty * x.entry * x.pnlPct / 100)})\nورود ${px(x.entry)} | حد ضرر ${px(x.sl)} | حد سود ${px(x.tp)} | حجم ${Number(x.qty).toPrecision(4)}${x.partialDone ? ' | نیمه‌ی اول بسته شده' : ''}`).join('\n\n') + '\n\nبستن یکی: /close ' + tick(p.positions[0].symbol)
  : 'پوزیشن بازی نیست.';

function pnl(p) {
  if (cfg.mode === 'signal') return 'حالت signal معامله‌ای انجام یا ثبت نمی‌کند، پس سود و زیانی هم نیست. (بک‌تست و سیگنال‌ها را در داشبورد ببین.)';
  const rows = [['۲۴ ساعت', 1], ['۷ روز', 7], ['۳۰ روز', 30], ['کل', 0]].map(([label, days]) => {
    const s = journal.report({ mode: cfg.mode, days }).summary;
    return `${label}: ${money(s.net)}  (${s.n} معامله${s.n ? `، برد ${s.winRate.toFixed(0)}٪` : ''})`;
  });
  const open = p.positions.reduce((a, x) => a + x.qty * x.entry * x.pnlPct / 100, 0);
  return `سود/زیان بسته‌شده‌ها (حالت ${cfg.mode}):\n${rows.join('\n')}\n\nپوزیشن‌های باز: ${money(open)} | سرمایه ${p.equity.toFixed(2)}`;
}

async function closeOne(arg) {
  if (!arg) return 'مثال: /close BTCUSDT  (یا نام کامل: /close BINANCE:BTCUSDT)';
  const want = arg.toUpperCase();
  const open = bot.portfolio().positions.map((x) => x.symbol);
  if (!open.length) return 'پوزیشن بازی نیست.';
  const hit = open.filter((s) => s.toUpperCase() === want);
  const m = hit.length ? hit : open.filter((s) => tick(s).toUpperCase() === want);
  if (!m.length) return `پوزیشن بازی با «${arg}» پیدا نشد. بازها: ${open.join(', ')}`;
  if (m.length > 1) return `چند پوزیشن با این نام هست؛ نام کامل را بنویس: ${m.join(' یا ')}`;
  const e = await bot.closeOne(m[0], 'manual close (telegram)');
  return e ? `بسته شد: ${m[0]} @ ${e.price} (${e.note})` : `الان نشد (سفارش دیگری در حال انجام است یا بسته شده). دوباره امتحان کن: ${m[0]}`;
}

async function handle(cmd, args = []) {
  if (cmd === '/status') return status(bot.portfolio());
  if (cmd === '/positions') return positions(bot.portfolio());
  if (cmd === '/pnl') return pnl(bot.portfolio());
  if (cmd === '/close') return closeOne(args[0]);
  if (cmd === '/halt') { bot.setHalt(true); return 'Paused: no new entries. Open positions stay protected by SL/TP.'; }
  if (cmd === '/resume') { bot.setHalt(false); return 'Resumed.'; }
  if (cmd === '/panic') { bot.setHalt(true); const n = (await bot.closeAll('panic (telegram)')).length; return `Paused and closed ${n} position(s).`; }
  return 'Commands: /status /positions /pnl /close <symbol> /halt /resume /panic';
}

let generation = 0; // each (re)start bumps this; an older polling loop notices and ends
function startTelegram() {
  const gen = ++generation;
  const { token, chatId } = settings.get();
  if (!token || !chatId) return false;
  let offset = 0;
  (async function loop() {
    while (gen === generation) {
      try {
        const r = await api('getUpdates', { offset, timeout: 25 });
        if (gen !== generation) return;
        for (const u of r.result || []) {
          offset = u.update_id + 1;
          const m = u.message;
          if (!m || String(m.chat.id) !== settings.get().chatId) continue; // only the saved chat is obeyed
          const [first = '', ...args] = (m.text || '').trim().split(/\s+/);
          const reply = await handle(first.split('@')[0].toLowerCase(), args);
          notifier.send(reply);
        }
      } catch (e) { if (gen !== generation) return; console.error('telegram poll:', e.message); await new Promise((r) => setTimeout(r, 5000)); }
    }
  })();
  console.log('Telegram control on: /status /positions /pnl /close /halt /resume /panic');
  return true;
}
module.exports = startTelegram;
module.exports.restart = startTelegram; // called after the dashboard saves new Telegram settings
module.exports.stop = () => { generation++; };
module.exports.status = status; // exported for tests
module.exports.handle = handle;
