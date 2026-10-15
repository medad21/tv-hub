// "Forward evidence": what the bot REALLY did in the last weeks (signal / paper / live trades in trades.jsonl) against what the
// backtest says the same settings would have done over exactly the same weeks and symbols. It answers three honest questions:
//   1. Does the running program behave like the backtest?  (same entries at the same times — or missed / extra trades)
//   2. Is the live result in line with the backtest's result for that window?
//   3. Is there enough forward data to say anything about profit yet? (it says "too early" until there are 30 trades)
// Runs by itself every EVIDENCE_EVERY_DAYS (default 7; "off" disables), sends a Telegram report, and can be run from the dashboard.
// It never changes any setting and places no orders.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const journal = require('./journal');
const bt = require('./backtest');
const { bootstrapCI, blocksOf } = require('./significance');
const { atomicWrite } = require('./fsutil');
const notifier = require('./notify');

const DATA = () => process.env.DATA_DIR || __dirname;
const latestFile = () => path.join(DATA(), 'evidence-latest.json');
const stateFile = () => path.join(DATA(), 'evidence-state.json');
const logFile = () => path.join(DATA(), 'evidence-log.jsonl');
const MIN_TRADES = 30; // below this the profit verdict is "too early"
const mean = (x) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0);
const sum = (x) => x.reduce((a, b) => a + b, 0);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');

// journal rows are exits; a partial take-profit and the final exit of one entry become ONE trade
function groupForward(rows) {
  const m = new Map();
  for (const t of rows) {
    const key = `${t.symbol}|${t.entryTime || t.time}`;
    const g = m.get(key) || { symbol: t.symbol, entrySec: Math.round((t.entryTime || t.time) / 1000), pnl: 0, cost: 0 };
    g.pnl += t.pnl; g.cost += (t.qty || 0) * (t.entry || 0);
    m.set(key, g);
  }
  return [...m.values()].map((g) => ({ ...g, pct: g.cost > 0 ? g.pnl / g.cost * 100 : 0 })).sort((a, b) => a.entrySec - b.entrySec);
}
function groupBacktest(trades) {
  const m = new Map();
  for (const t of trades) {
    const key = `${t.symbol}|${t.entryTime}`;
    const g = m.get(key) || { symbol: t.symbol, entrySec: t.entryTime, pnl: 0, cost: 0 };
    g.pnl += t.pnl; g.cost += (t.qty || 0) * (t.entry || 0);
    m.set(key, g);
  }
  return [...m.values()].map((g) => ({ ...g, pct: g.cost > 0 ? g.pnl / g.cost * 100 : 0 })).sort((a, b) => a.entrySec - b.entrySec);
}

// pairs each forward trade with a backtest trade on the same symbol that opened within 1.5 candles of it
function match(fwd, back, tfSec) {
  const used = new Set(); let matched = 0;
  for (const f of fwd) {
    let best = -1, bd = Infinity;
    back.forEach((b, i) => { if (used.has(i) || b.symbol !== f.symbol) return; const d = Math.abs(b.entrySec - f.entrySec); if (d <= 1.5 * tfSec && d < bd) { best = i; bd = d; } });
    if (best >= 0) { used.add(best); matched++; }
  }
  return { matched, onlyForward: fwd.length - matched, onlyBacktest: back.length - matched };
}

function verdictOf({ nF, nB, agree, fwdPct, fwdTimes }) {
  if (nF < 5 && nB < 5) return { id: 'too_early', text: `هنوز معامله‌ی کافی برای هر دو طرف نیست (ربات ${nF}، بک‌تست ${nB}). چند هفته دیگر صبر کنید.` };
  if (nB >= 5 && agree < 0.6) return { id: 'divergent', text: `ربات زنده همان کاری را نمی‌کند که بک‌تست می‌گوید: فقط ${Math.round(agree * 100)}٪ ورودی‌ها یکی است. علت‌های رایج: خاموش‌بودن برنامه، سقف ریسک/توقف ورود، یا اختلاف داده. تا روشن‌شدن علت به نتیجه‌ی بک‌تست اعتماد نکنید.` };
  if (nF < MIN_TRADES) return { id: 'too_early', text: `رفتار ربات با بک‌تست هم‌خوان است (${Math.round(agree * 100)}٪ ورودی‌ها یکی)، ولی ${nF} معامله هنوز برای قضاوت درباره‌ی سود کم است (حداقل ${MIN_TRADES}).` };
  // trades opened in the same few days share a market mood: resample whole time blocks, not single trades (see significance.js)
  const timed = fwdTimes && fwdTimes.length === fwdPct.length && fwdTimes.every(Number.isFinite);
  const ci = bootstrapCI(fwdPct, 2000, timed ? blocksOf(fwdTimes) : null);
  if (ci && ci.hi < 0) return { id: 'negative', text: `نتیجه‌ی جلورونده زیر صفر است (میانگین ${f1(ci.mean)}٪ در هر معامله، بازه‌ی ۹۵٪: ${f1(ci.lo)} تا ${f1(ci.hi)}). با این تنظیمات پول واقعی نگذارید.` };
  if (ci && ci.lo > 0) return { id: 'positive', text: `نتیجه‌ی جلورونده مثبت و از شانس جدا است (میانگین ${f1(ci.mean)}٪ در هر معامله، بازه‌ی ۹۵٪: ${f1(ci.lo)} تا ${f1(ci.hi)}). نشانه‌ی خوبی است، نه تضمین؛ با سرمایه‌ی کم شروع کنید.` };
  return { id: 'inconclusive', text: `نتیجه‌ی جلورونده هنوز نامعلوم است (میانگین ${ci ? f1(ci.mean) : '—'}٪ در هر معامله؛ بازه‌ی ۹۵٪ صفر را هم دربرمی‌گیرد). ادامه دهید و صبر کنید.` };
}

function fractionFor(prep, sinceSec) {
  const keys = Object.keys(prep);
  if (keys.length === 1) { const b = prep[keys[0]].bars; let i = b.findIndex((x) => x.time >= sinceSec); if (i < 0) i = b.length; return (i + 0.5) / b.length; }
  let t0 = Infinity, t1 = -Infinity;
  for (const k of keys) { const b = prep[k].bars; t0 = Math.min(t0, b[0].time); t1 = Math.max(t1, b[b.length - 1].time); }
  return Math.min(1, Math.max(0, (sinceSec - t0 - 0.001) / (t1 - t0)));
}

// opts: { days, mode, now (ms), symbols, tf, loader(async ({symbols, tf, candles}) => {data, stamps}), base }
async function check(opts = {}) {
  const days = opts.days || Number(process.env.EVIDENCE_WINDOW_DAYS) || 30;
  const mode = opts.mode || cfg.mode, now = opts.now || Date.now();
  const symbols = opts.symbols || cfg.symbols, tf = opts.tf || cfg.timeframe;
  const base = opts.base || { risk: cfg.risk, rsi: cfg.rsi, confluence: cfg.confluence, strategy: cfg.strategy };
  const tfMin = bt.tfMinutes(tf), tfSec = tfMin * 60, sinceSec = Math.floor(now / 1000) - days * 86400;
  const candles = Math.min(20000, Math.ceil(days * 1440 / tfMin) + 400); // the window plus the warm-up the indicators need

  const fwdRows = journal.loadTrades({ mode }).filter((t) => t.time >= now - days * 86400000 && t.time <= now); // filtered here (not by journal) so `now` can be set in tests
  const fwd = groupForward(fwdRows);

  const loaded = await (opts.loader || bt.loadAll)({ symbols, tf, candles });
  const { prep } = bt.buildPrep(loaded, { symbols, tf, candles }, base);
  if (!Object.keys(prep).length) return { error: 'داده‌ی کندل برای بک‌تست پیدا نشد (اینترنت/TradingView).', days, mode };
  const res = bt.run(prep, fractionFor(prep, sinceSec), 1, {}, base);
  const back = groupBacktest(res.trades).filter((t) => t.entrySec >= sinceSec);
  const m = match(fwd, back, tfSec);
  const nF = fwd.length, nB = back.length, agree = m.matched / Math.max(nF, nB, 1);
  const capital = mode === 'live' ? cfg.live.capitalUsdt : cfg.paper.balance;
  const fwdNet = sum(fwd.map((t) => t.pnl)) / capital * 100, btNet = sum(back.map((t) => t.pnl)) / capital * 100;
  const verdict = verdictOf({ nF, nB, agree, fwdPct: fwd.map((t) => t.pct), fwdTimes: fwd.map((t) => t.entrySec) });
  const report = {
    time: now, days, mode, tf, symbols: symbols.length, strategy: base.strategy.id,
    forward: { trades: nF, wins: fwd.filter((t) => t.pnl > 0).length, netPct: fwdNet, meanPct: mean(fwd.map((t) => t.pct)) },
    backtest: { trades: nB, wins: back.filter((t) => t.pnl > 0).length, netPct: btNet, meanPct: mean(back.map((t) => t.pct)) },
    match: { ...m, agree }, verdict,
  };
  report.text = text(report);
  return report;
}

function text(r) {
  const L = [`🔎 شواهد جلورونده — ${r.days} روز گذشته، حالت ${r.mode}، ${r.symbols} نماد، تایم‌فریم ${r.tf}`];
  L.push(`ربات (واقعی): ${r.forward.trades} معامله، ${r.forward.wins} برد | خالص ${f1(r.forward.netPct)}٪ سرمایه | میانگین ${f1(r.forward.meanPct)}٪ هر معامله`);
  L.push(`بک‌تست همان بازه: ${r.backtest.trades} معامله، ${r.backtest.wins} برد | خالص ${f1(r.backtest.netPct)}٪ سرمایه | میانگین ${f1(r.backtest.meanPct)}٪ هر معامله`);
  L.push(`هم‌خوانی ورودی‌ها: ${r.match.matched} مشترک | فقط ربات ${r.match.onlyForward} | فقط بک‌تست ${r.match.onlyBacktest} (${Math.round(r.match.agree * 100)}٪)`);
  L.push(`${{ positive: '✅', negative: '❌', divergent: '⚠️', too_early: '⏳', inconclusive: '➖' }[r.verdict.id] || ''} ${r.verdict.text}`);
  return L.join('\n');
}

function save(report) {
  try {
    atomicWrite(latestFile(), JSON.stringify(report));
    const { text: _t, ...slim } = report;
    fs.appendFileSync(logFile(), JSON.stringify(slim) + '\n');
  } catch (e) { console.error('evidence:', e.message); }
}
const latest = () => { try { return JSON.parse(fs.readFileSync(latestFile(), 'utf8')); } catch { return null; } };

let running = null;
function run(opts) { // one at a time; asking twice returns the run already in progress
  if (running) return running;
  running = check(opts).then((r) => { if (!r.error) save(r); return r; }).finally(() => { running = null; });
  return running;
}

const everyDays = (raw = process.env.EVIDENCE_EVERY_DAYS) => {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === 'off' || v === 'no' || v === 'none') return null;
  const n = Number(v);
  return v === '' || !(n >= 1) ? 7 : Math.floor(n);
};
// The first time ever, nothing is run: the clock simply starts (a report on day one would have no trades to talk about).
function due(now = Date.now(), every = everyDays()) {
  if (every === null) return false;
  let last = 0; try { last = JSON.parse(fs.readFileSync(stateFile(), 'utf8')).lastRun || 0; } catch {}
  if (!last) { try { atomicWrite(stateFile(), JSON.stringify({ lastRun: now })); } catch {} return false; }
  return now - last >= every * 86400000;
}
async function tickSchedule() {
  if (!due()) return false;
  try { atomicWrite(stateFile(), JSON.stringify({ lastRun: Date.now() })); } catch {} // before running: a crash must not cause a retry loop every few hours
  const r = await run();
  if (r.error) { notifier.send(`🔎 بررسی شواهد انجام نشد: ${r.error}`); return false; }
  notifier.send(r.text);
  return true;
}
function start() {
  if (everyDays() === null) return;
  setInterval(() => tickSchedule().catch((e) => console.error('evidence:', e.message)), 3 * 3600 * 1000).unref();
  setTimeout(() => tickSchedule().catch((e) => console.error('evidence:', e.message)), 60 * 1000).unref();
}

module.exports = { check, run, latest, start, due, tickSchedule, groupForward, groupBacktest, match, verdictOf, fractionFor, everyDays, text, MIN_TRADES };
