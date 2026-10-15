// Daily Telegram summary. Sent once per UTC day, at/after DAILY_SUMMARY_HOUR_UTC (default 20 = 23:30 Iran time;
// "off" disables it). The day it was last sent is kept in state.json, so a restart never repeats it.
const bot = require('./bot');
const journal = require('./journal');
const cfg = require('./config');
const notifier = require('./notify');

const money = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;
const tick = (sym) => String(sym).split(':')[1] || sym;

function hourSetting(raw = process.env.DAILY_SUMMARY_HOUR_UTC) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === 'off' || v === 'none' || v === 'no') return null;
  if (v === '') return 20;
  const h = Number(v);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 20;
}

// portfolio = bot.portfolio(); report = journal.report({ mode, days: 1 })
function build({ portfolio: p, report: r, mode, date }) {
  const sg = r.signals;
  const lines = [`📊 خلاصه‌ی روز ${date} (UTC) — حالت ${mode}`];
  if (mode === 'signal') {
    lines.push(`سیگنال‌های ۲۴ ساعت: خرید ${sg.buy} | فروش ${sg.sell} | ردشده ${sg.skipped}`);
    if (sg.skipReasons.length) lines.push(`رایج‌ترین دلیل ردشدن: ${sg.skipReasons[0].reason} (${sg.skipReasons[0].n}×)`);
    return lines.join('\n');
  }
  const s = r.summary;
  lines.push(`سرمایه ${p.equity.toFixed(2)} | امروز ${money(p.dayPnlPct)}٪ | افت از اوج ${p.drawdownPct.toFixed(2)}٪`);
  lines.push(s.n ? `معاملات ۲۴ ساعت: ${s.n} (برد ${s.wins} / باخت ${s.losses}) | خالص ${money(s.net)}` : 'معامله‌ای بسته نشد.');
  lines.push(p.positions.length ? `پوزیشن باز (${p.positions.length}): ${p.positions.map((x) => `${tick(x.symbol)} ${money(x.pnlPct)}٪`).join('، ')}` : 'پوزیشن باز: ندارد');
  lines.push(`سیگنال‌ها: خرید ${sg.buy} | فروش ${sg.sell} | ردشده ${sg.skipped}`);
  if (p.halted) lines.push(`⏸ ورود جدید متوقف است: ${p.haltReason}`);
  return lines.join('\n');
}

function check(now = new Date(), hour = hourSetting()) {
  if (hour === null) return false;
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < hour || bot.getSummaryDay() === today) return false;
  bot.setSummaryDay(today); // before sending: better to miss one summary than to repeat it
  notifier.send(build({ portfolio: bot.portfolio(), report: journal.report({ mode: cfg.mode, days: 1 }), mode: cfg.mode, date: today }));
  return true;
}

function start() {
  if (!notifier.enabled() || hourSetting() === null) return;
  setInterval(() => { try { check(); } catch (e) { console.error('summary:', e.message); } }, 60000).unref();
  setTimeout(() => { try { check(); } catch (e) { console.error('summary:', e.message); } }, 5000).unref();
}

module.exports = { start, check, build, hourSetting };
