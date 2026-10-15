// Trade journal + report numbers for the dashboard's "Report" tab.
//   trades.jsonl  one line per CLOSED trade (written by bot.js)   -> performance report
//   events.log    every signal / trade / skip (written by bot.js) -> "why did nothing happen" statistics
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { group } = require('./symbols');

const DATA = () => process.env.DATA_DIR || __dirname;
const tradesFile = () => process.env.TRADE_LOG || path.join(DATA(), 'trades.jsonl');
const eventsFile = () => process.env.EVENT_LOG || path.join(DATA(), 'events.log');

function record(t) {
  try { fs.appendFileSync(tradesFile(), JSON.stringify({ ...t, group: group(t.symbol) }) + '\n'); } catch (e) { console.error('journal:', e.message); }
}

function readLines(file, maxBytes = 20 * 1024 * 1024) {
  try {
    const size = fs.statSync(file).size;
    let text;
    if (size <= maxBytes) text = fs.readFileSync(file, 'utf8');
    else { // very large log: only read the tail
      const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, size - maxBytes); fs.closeSync(fd);
      text = buf.toString('utf8'); text = text.slice(text.indexOf('\n') + 1);
    }
    return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
const bucket = (trades, keyFn) => {
  const m = {};
  trades.forEach((t) => { const k = keyFn(t) || '—'; (m[k] = m[k] || []).push(t); });
  return Object.entries(m).map(([key, x]) => ({
    key, n: x.length, pnl: sum(x.map((t) => t.pnl)), winRate: x.filter((t) => t.pnl > 0).length / x.length * 100,
  })).sort((a, b) => b.pnl - a.pnl);
};
const normReason = (note) => String(note || '').replace(/^skipped:\s*/, '').replace(/[-+]?\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim();

function loadTrades({ mode, days }) {
  const since = days ? Date.now() - days * 86400000 : 0;
  return readLines(tradesFile()).filter((t) => (!mode || t.mode === mode) && t.time >= since).sort((a, b) => a.time - b.time);
}

function report({ mode = cfg.mode, days = 30 } = {}) {
  const capital = mode === 'live' ? cfg.live.capitalUsdt : cfg.paper.balance;
  const since = days ? Date.now() - days * 86400000 : 0;
  const trades = loadTrades({ mode, days });
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = sum(wins.map((t) => t.pnl)), grossLoss = Math.abs(sum(losses.map((t) => t.pnl)));

  // realized equity curve, drawdown and losing streak
  let cum = 0, peak = capital, maxDD = 0, maxDDAbs = 0, streak = 0, worst = 0;
  const curve = trades.map((t) => {
    cum += t.pnl;
    peak = Math.max(peak, capital + cum);
    maxDD = Math.max(maxDD, (peak - capital - cum) / peak * 100);
    maxDDAbs = Math.max(maxDDAbs, peak - capital - cum);
    streak = t.pnl <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak);
    return [t.time, cum];
  });
  const stride = Math.max(1, Math.ceil(curve.length / 400));
  const held = trades.filter((t) => t.entryTime).map((t) => (t.time - t.entryTime) / 60000);

  const days_ = {};
  trades.forEach((t) => { const d = new Date(t.time).toISOString().slice(0, 10); days_[d] = (days_[d] || 0) + t.pnl; });

  // signal statistics from events.log: what fired, and — just as important — what was held back and why
  const ev = readLines(eventsFile()).filter((e) => e.mode === mode && e.time >= since);
  const skips = {};
  ev.filter((e) => e.side === 'skip').forEach((e) => { const k = normReason(e.note); skips[k] = (skips[k] || 0) + 1; });

  return {
    mode, days, capital,
    summary: {
      n: trades.length, wins: wins.length, losses: losses.length,
      winRate: trades.length ? wins.length / trades.length * 100 : 0,
      net: cum, netPct: cum / capital * 100, grossWin, grossLoss,
      profitFactor: grossLoss ? grossWin / grossLoss : null, // null = no losing trade yet
      avgWin: wins.length ? grossWin / wins.length : 0, avgLoss: losses.length ? -grossLoss / losses.length : 0,
      expectancy: trades.length ? cum / trades.length : 0,
      best: trades.length ? Math.max(...trades.map((t) => t.pnl)) : 0, worst: trades.length ? Math.min(...trades.map((t) => t.pnl)) : 0,
      maxDrawdownPct: maxDD, maxDrawdownAbs: maxDDAbs, worstStreak: worst,
      avgHoldMin: held.length ? sum(held) / held.length : null,
    },
    curve: curve.filter((_, i) => i % stride === 0 || i === curve.length - 1),
    byDay: Object.entries(days_).sort().map(([date, pnl]) => ({ date, pnl })).slice(-60),
    bySymbol: bucket(trades, (t) => t.symbol), byGroup: bucket(trades, (t) => t.group), byReason: bucket(trades, (t) => String(t.reason).split('|')[0].trim()),
    signals: {
      buy: ev.filter((e) => e.side === 'buy').length, sell: ev.filter((e) => e.side === 'sell').length,
      skipped: ev.filter((e) => e.side === 'skip').length,
      skipReasons: Object.entries(skips).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n).slice(0, 12),
    },
    recent: trades.slice(-25).reverse(),
  };
}

function csv({ mode = cfg.mode, days = 0 } = {}) {
  const iso = (t) => (t ? new Date(t).toISOString() : '');
  return 'exit_time,entry_time,symbol,group,mode,entry,exit,qty,pnl,pct,reason\n' + loadTrades({ mode, days }).map((t) =>
    [iso(t.time), iso(t.entryTime), t.symbol, t.group || '', t.mode, t.entry, t.exit, t.qty, Number(t.pnl).toFixed(4), Number(t.pct).toFixed(2), `"${String(t.reason).replace(/"/g, '""')}"`].join(',')).join('\n');
}

module.exports = { record, report, csv, loadTrades };
