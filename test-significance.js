// Offline checks for the "is this just luck?" layer: bootstrap confidence interval, multiple-testing-adjusted p-value,
// bad-luck Profit Factor, comparison with buy-and-hold, market regime, and how they change the comparison verdict. Run: node test-significance.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-sig-'));
Object.assign(process.env, { CONFIG_OVERRIDES_FILE: path.join(tmp, 'config.local.json'), BT_CACHE: path.join(tmp, 'cache'), TRADE_LOG: path.join(tmp, 't.jsonl'), EVENT_LOG: path.join(tmp, 'e.log'), STATE_FILE: path.join(tmp, 's.json'), DATA_DIR: tmp, MODE: 'signal' });
const sig = require('./significance');
const bt = require('./backtest');
let passed = 0;
const ok = (c, m) => { assert(c, m); passed++; console.log('  ok  ' + m); };

// deterministic normal-ish random numbers (sum of uniforms)
function seeded(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const gauss = (r) => (r() + r() + r() + r() + r() + r() - 3) * Math.SQRT2;
const sample = (n, mean, sd, seed) => { const r = seeded(seed); return Array.from({ length: n }, () => mean + sd * gauss(r)); };
const trades = (rs) => rs.map((r) => ({ r, pnl: r * 10 }));

// ---- 1) the building blocks ----
const edge = sample(80, 0.4, 1, 3), noise = sample(80, 0, 1, 4), losing = sample(80, -0.3, 1, 5);
ok(JSON.stringify(sig.bootstrapCI(edge)) === JSON.stringify(sig.bootstrapCI(edge)) && sig.pValueMean(edge) === sig.pValueMean(edge), 'deterministic: the same trades always give the same numbers');
const ci = sig.bootstrapCI(edge), m = edge.reduce((a, b) => a + b, 0) / edge.length;
ok(ci.lo < ci.mean && ci.mean < ci.hi && Math.abs(ci.mean - m) < 1e-9, 'bootstrapCI: the interval brackets the observed average R');
const wide = sig.bootstrapCI(sample(15, 0.4, 1, 6)), narrow = sig.bootstrapCI(sample(300, 0.4, 1, 6));
ok(wide.hi - wide.lo > 2 * (narrow.hi - narrow.lo), 'bootstrapCI: 15 trades are far less certain than 300 (interval is much wider)');
ok(sig.pValueMean(edge) < 0.01, `pValueMean: a real edge (avg R 0.4, 80 trades) is very unlikely to be luck (p = ${sig.pValueMean(edge).toFixed(4)})`);
ok(sig.pValueMean(noise) > 0.1, `pValueMean: pure noise is NOT called an edge (p = ${sig.pValueMean(noise).toFixed(2)})`);
ok(sig.pValueMean(losing) === 1 && sig.pValueMean([1, 2, 3]) === null, 'pValueMean: a losing average is p = 1; fewer than 5 trades -> no number');
ok(sig.pValueMean(edge.map((x) => x + 5)) > 0, 'pValueMean: never exactly 0 (finite resampling cannot prove certainty)');
ok(sig.adjustP(0.02, 14) === 0.28 && sig.adjustP(0.2, 14) === 1 && sig.adjustP(0.5, 0) === 0.5 && sig.adjustP(null, 5) === null, 'adjustP: multiplied by the number of combinations tried, capped at 1');
const pnls = edge.map((x) => x * 10), pf = (a) => { let w = 0, l = 0; a.forEach((v) => (v > 0 ? (w += v) : (l -= v))); return w / l; };
ok(sig.pfLowerBound(pnls) < pf(pnls) && sig.pfLowerBound(pnls) > 0 && sig.pfLowerBound([1, 2]) === null, 'pfLowerBound: the "bad luck" Profit Factor is below the observed one');
ok(sig.tradeStats(trades(edge.slice(0, 9)), 5) === null, 'tradeStats: under 10 trades -> no statistics (it would pretend to be precise)');
const ts = sig.tradeStats(trades(edge), 14);
ok(ts.tests === 14 && ts.pAdj >= ts.p && ts.pAdj <= 1 && ts.ci && ts.pfLo > 0, 'tradeStats: bundles raw p, adjusted p (>= raw), interval and PF lower bound');
ok(Math.abs(sig.maxDrawdownPct([100, 120, 90, 95, 130, 100]) - 25) < 1e-9 && sig.maxDrawdownPct([1, 2, 3]) === 0, 'maxDrawdownPct: worst peak-to-trough fall of what holding would have lived through');
ok(sig.regimeOf(104.8, 1000).id === 'strong_up' && sig.regimeOf(15, 180).id === 'strong_up' && sig.regimeOf(-12.6, 180).id === 'down' && sig.regimeOf(3, 71).id === 'mild' && sig.regimeOf(0, 0).id === 'mild', 'regimeOf: +105% in 1000 days (gold) is a strong uptrend; -12.6% in 180 days is down; +3% in 71 days is mild');

// ---- 2) how it changes the verdict ----
const summary = { n: 50, ret: 5, pf: 1.8, avgR: 0.3, maxDD: 3, buyHold: 100 }, wf = { folds: 5, profitableFolds: 4 }, mc = { probLoss: 2 };
const base = bt.judge(summary, wf, mc);
ok(base.verdict === 'reliable', 'judge: without the new numbers nothing changes (backwards compatible)');
const lucky = bt.judge(summary, wf, mc, bt.RELIABILITY, { stat: { pAdj: 0.5, tests: 14 }, bench: { ret: 100, maxDD: 20, beatsRaw: false, beatsRiskAdj: false }, regime: { id: 'strong_up' } });
ok(lucky.verdict === 'suspect' && lucky.reasons.some((x) => /14/.test(x) && /شانس/.test(x)), 'judge: passes every older check but is plausibly luck after 14 combinations -> "suspect", with the reason');
const solid = bt.judge(summary, wf, mc, bt.RELIABILITY, { stat: { pAdj: 0.01, tests: 14 }, bench: { ret: 100, maxDD: 20, beatsRaw: false, beatsRiskAdj: false }, regime: { id: 'strong_up' } });
ok(solid.verdict === 'reliable' && solid.notes.length === 2 && /خرید-و-نگهداری/.test(solid.notes[0]) && /صعودی قوی/.test(solid.notes[1]), 'judge: a significant result stays "reliable" but says out loud that it earned less than holding and that the market was in a strong uptrend');
ok(bt.judge({ ...summary, ret: 150 }, wf, mc, bt.RELIABILITY, { stat: { pAdj: 0.01, tests: 3 }, bench: { ret: 100, maxDD: 20, beatsRaw: true, beatsRiskAdj: true }, regime: { id: 'mild' } }).notes.length === 0, 'judge: no notes when it beat holding in an ordinary market');
ok(bt.judge({ ...summary, n: 10 }, wf, mc, bt.RELIABILITY, { stat: null }).verdict === 'insufficient', 'judge: too few trades is still "insufficient" first');

// ---- 3) end to end on a comparison (offline candles) ----
function makeBars(n, stepSec, endTime, seed, drift) {
  const r = seeded(seed); let p = 100; const out = [];
  for (let i = 0; i < n; i++) {
    const open = p, ret = drift + Math.sin(i / 40) * 0.004 + (r() - 0.5) * 0.02, close = open * (1 + ret);
    out.push({ time: endTime - (n - 1 - i) * stepSec, open, close, max: Math.max(open, close) * (1 + r() * 0.006), min: Math.min(open, close) * (1 - r() * 0.006), volume: 1000 + r() * 1000 });
    p = close;
  }
  return out;
}
(async () => {
  const SYM = 'BINANCE:BTCUSDT', end = 1_800_000_000, dir = process.env.BT_CACHE;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SYM.replace(/[^A-Za-z0-9]/g, '_')}_60_1200.json`), JSON.stringify(makeBars(1200, 3600, end, 3, 0.0004)));
  const mm = await bt.runMatrix({ symbol: SYM, timeframes: ['60'], strategies: ['trend_ma', 'breakout', 'momentum_macd', 'rsi_dip'], days: 40, maxCandles: 1200 });
  const withStat = mm.cells.filter((c) => c.summary && c.summary.n >= 10);
  ok(withStat.length > 0 && withStat.every((c) => c.stat && c.stat.tests === mm.cellsTested && c.stat.pAdj >= c.stat.p), `matrix: every cell with >= 10 trades carries statistics, adjusted for ${mm.cellsTested} combinations`);
  ok(mm.cells.filter((c) => c.summary).every((c) => c.bench && typeof c.bench.maxDD === 'number' && typeof c.bench.beatsRaw === 'boolean'), 'matrix: every cell is compared with buy-and-hold (return and its own drawdown)');
  ok(mm.regime && ['strong_up', 'mild', 'down'].includes(mm.regime.id), `matrix: the report states what kind of market the window was (${mm.regime && mm.regime.label})`);
  ok(/آمار: میانگین R/.test(mm.text) && /تعدیل‌شده برای \d+ ترکیب/.test(mm.text) && /وضعیت بازار در این بازه/.test(mm.text), 'report text: shows the interval, raw and adjusted chance of luck, and the market regime');
  const again = await bt.runMatrix({ symbol: SYM, timeframes: ['60'], strategies: ['trend_ma', 'breakout', 'momentum_macd', 'rsi_dip'], days: 40, maxCandles: 1200 });
  ok(JSON.stringify(again.cells.map((c) => c.stat)) === JSON.stringify(mm.cells.map((c) => c.stat)), 'matrix: running the same comparison twice gives identical statistics');

  // ---- 4) what the page shows ----
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const helpers = (html.match(/^const (pct|fx|pfx) = .*$/gm) || []).join('\n') + '\n';
  const render = html.slice(html.indexOf('const MX_BADGE'), html.indexOf('async function runMatrixCompare'));
  const els = {};
  const sb = { $: (id) => (els[id] = els[id] || { style: {}, addEventListener() {} }), esc: (x) => String(x), tfLabel: (x) => x, URL, Blob, document: { createElement: () => ({}) } };
  vm.createContext(sb); vm.runInContext(helpers + render + ';this.renderMxResults = renderMxResults;', sb);
  const cell = (extra) => ({ tf: '240', strategyId: 'trend_ma', strategyName: 'روند', verdict: 'reliable', reasons: [], summary: { n: 46, ret: 6.8, pf: 2.33, avgR: 0.47, maxDD: 2.2, buyHold: 104.8 }, wf: { folds: 5, profitableFolds: 4 }, notes: ['از خرید-و-نگهداری کمتر است', 'بازار صعودی قوی بود'], ...extra });
  const payload = (c, regime) => JSON.parse(JSON.stringify({ symbol: 'X', window: { from: 1, to: 86400 * 100, days: 100 }, assumptions: { fillMode: 'next_open', costs: { feePct: 0, slippagePct: 0.03 } }, regime, cells: [c], cellsTested: 1, best: { tf: '240', strategyId: 'trend_ma' }, text: 't' }));
  sb.renderMxResults(payload(cell({ stat: { p: 0.001, pAdj: 0.014, tests: 14, ci: { mean: 0.47, lo: 0.2, hi: 0.75 } }, bench: { ret: 104.8, maxDD: 20 } }), { id: 'strong_up', label: 'صعودی قوی' }));
  const out = els.mxResults.innerHTML;
  ok(/شانس 1٪/.test(out) && /R 0\.20 تا 0\.75/.test(out), 'page: each cell shows the interval of average R and the adjusted chance of luck');
  ok(/وضعیت بازار در این بازه/.test(out) && /صعودی قوی/.test(out) && /توجه درباره‌ی نتیجه‌های «قابل اتکا»/.test(out) && /از خرید-و-نگهداری کمتر است/.test(out), 'page: warns about the strong uptrend and about earning less than holding, next to every "reliable" cell');
  let threw = null; try { sb.renderMxResults(payload(cell({ stat: null, notes: [] }), null)); } catch (e) { threw = e; }
  ok(!threw && !/شانس \d/.test(els.mxResults.innerHTML) && !/وضعیت بازار در این بازه/.test(els.mxResults.innerHTML), 'page: a cell with too few trades for statistics (and no regime) renders cleanly, no numbers invented');

  console.log(`\n${passed} significance checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
