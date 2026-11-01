// The latest "timeframe x strategy" comparison per symbol (the verdict table from Backtest > Compare), kept so that other parts of the
// program — the AI assistant — can say "this strategy was judged reliable / negative on this timeframe" without running anything.
// Only the compact verdict of each cell is stored (not the full report), one small JSON file, rewritten atomically.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fsutil');

const file = () => process.env.MATRIX_FILE || path.join(process.env.DATA_DIR || __dirname, 'matrix-latest.json');
function readAll() { try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

function compact(c) {
  const s = c.summary || {};
  return {
    tf: String(c.tf), strategyId: c.strategyId, strategyName: c.strategyName || c.strategyId, verdict: c.verdict, reasons: (c.reasons || []).slice(0, 4).map((x) => String(x).slice(0, 300)),
    trades: num(s.n), ret: num(s.ret), pf: s.pf === Infinity ? null : num(s.pf), avgR: num(s.avgR), maxDD: num(s.maxDD),
    holdout: c.holdout ? { status: c.holdout.status, n: num(c.holdout.n) } : null, error: !!c.error,
  };
}
// report = what runMatrix returned. source: 'tv' | 'mt5'
function save(report, source = 'tv', now = Date.now()) {
  if (!report || !report.symbol || !Array.isArray(report.cells)) return false;
  const all = readAll();
  all[`${source === 'mt5' ? 'mt5|' : ''}${report.symbol}`] = { time: now, source, days: report.window ? report.window.days : null, cells: report.cells.map(compact) };
  try { atomicWrite(file(), JSON.stringify(all)); return true; } catch { return false; }
}
function get(symbol, source = 'tv') { return readAll()[`${source === 'mt5' ? 'mt5|' : ''}${symbol}`] || null; }
module.exports = { save, get, compact };
