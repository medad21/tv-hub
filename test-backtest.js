// Offline checks for the backtest engine, its worker thread, and the trade journal / report numbers. Run: npm test
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-bt-'));
process.env.CONFIG_OVERRIDES_FILE = path.join(tmp, 'config.local.json'); // never touch the real project's saved settings
process.env.BT_CACHE = path.join(tmp, 'cache');
process.env.TRADE_LOG = path.join(tmp, 'trades.jsonl');
process.env.EVENT_LOG = path.join(tmp, 'events.log');
process.env.MODE = 'paper';
process.env.TRIALS_FILE = path.join(tmp, 'trials.json'); // the research ledger must not leak into the real project folder

const cfg = require('./config');
cfg.risk.fillMode = 'close'; // these tests pin the ORIGINAL engine's numbers (fill at the signal candle's close); the realistic next-open mode has its own tests in test-reliability.js
const { rsi, ema, atr, macd, avgVolume } = require('./strategy');
const bt = require('./backtest');
const journal = require('./journal');
const runner = require('./backtest-runner');

let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ok  ' + m); };
const sum = (a) => a.reduce((x, y) => x + y, 0);

function synth(len, phase = 0) {
  return Array.from({ length: len }, (_, i) => {
    const price = 100 + Math.sin((i + phase) / 15) * 8 + Math.sin(i / 3) * 2 + i * 0.01;
    const open = price - 0.3, close = price + 0.3;
    return { time: 1700000000 + i * 900, open, close, max: Math.max(open, close) + 0.5, min: Math.min(open, close) - 0.5, volume: 100 + (i % 25) * 10 };
  });
}

(async () => {
  // 1) the lazily computed indicators are exactly what the live bot would compute on its 300-candle window
  const bars = synth(1200), closes = bars.map((b) => b.close), p = bt.prepare(bars, cfg.rsi, cfg.risk);
  const win = (i) => [Math.max(0, i - bt.WINDOW + 1), i + 1];
  let same = true;
  for (const i of [350, 600, 899, 1199]) {
    const [a, b] = win(i), m = macd(closes.slice(a, b));
    same = same && p.rs[i] === rsi(closes.slice(a, b), cfg.rsi.period) && p.at(i) === atr(bars.slice(a, b), cfg.risk.atrPeriod)
      && p.em(i) === ema(closes.slice(a, b), cfg.risk.trendEma) && p.mh(i) === (m ? m.hist : null) && p.av(i) === avgVolume(bars.slice(a, b), 20);
  }
  ok(same, 'lazy indicators (RSI/ATR/EMA/MACD/volume) equal the live-window values exactly');

  // 2) engine results did not change with the optimisation (numbers taken from the pre-optimisation engine)
  const noConf = { confluence: { enabled: false } };
  ok(bt.summarize(bt.run({ S: p }, 0, 1, noConf)).n === 8, 'engine: 8 trades without confluence (unchanged)');
  ok(bt.summarize(bt.run({ S: p }, 0, 1, { ...noConf, risk: { trendFilter: false } })).n === 13, 'engine: 13 trades without confluence and trend filter (unchanged)');
  const def = bt.run({ S: p }, 0, 1), f = def.funnel;
  ok(def.trades.length === 2, 'engine: default filters (MACD turning / volume, then trend) let 2 of the synthetic dips through');
  ok(f.edges === 13 && f.confirmed === 6 && f.trend === 4 && f.opened === 2 && f.edges >= f.confirmed && f.confirmed >= f.opened,
    'funnel: 13 buy signals -> 6 confirmed -> 4 stopped by the trend filter -> 2 trades (adds up)');
  ok(f.macdN === 13 && f.volN === 13 && f.trendN === 12, 'funnel: each filter is also counted on its own (how often it alone would pass)');

  // 3) two different data sets must never share a cached timeline (matters now the worker stays alive between runs)
  const other = bt.prepare(synth(1200, 40), cfg.rsi, cfg.risk);
  const a = bt.run({ S: p }, 0, 1, noConf), b = bt.run({ S: other }, 0, 1, noConf);
  ok(JSON.stringify(a.trades.map((t) => t.entryTime)) !== JSON.stringify(b.trades.map((t) => t.entryTime)), 'separate data sets get separate timelines');

  // 4) equity curve
  const c = bt.run({ S: p }, 0, 1, { ...noConf, curve: true }).curve;
  ok(c.length > 10 && c.length <= 302 && c.every((x) => Number.isFinite(x[1])), 'equity curve is sampled to ~300 finite points');

  // 4b) walk-forward: same setting, checked on 5 separate consecutive segments instead of one split
  const wf = bt.walkForward({ S: p }, noConf, cfg, 5);
  ok(wf.folds === 5 && wf.windows.length === 5, 'walkForward: splits into the requested number of folds');
  ok(wf.windows[0].from === 0 && wf.windows[4].to === 1 && wf.windows.every((w, i) => i === 0 || w.from === wf.windows[i - 1].to), 'walkForward: folds are consecutive and cover the whole range with no gaps or overlap');
  ok(wf.totalTrades === sum(wf.windows.map((w) => w.trades)) && wf.profitableFolds === wf.windows.filter((w) => w.ret > 0).length, 'walkForward: totals and profitable-fold count match the individual windows');
  ok(wf.worstFoldRet === Math.min(...wf.windows.map((w) => w.ret)) && Math.abs(wf.avgFoldRet - sum(wf.windows.map((w) => w.ret)) / 5) < 1e-9, 'walkForward: worst/average fold return are computed correctly');

  // 4c) Monte Carlo: reshuffle the SAME trades many times to see how much the result depended on order
  const mcTrades = [100, 100, 100, -50, -50, 80, -30, 60, -40, 90, -20, 70].map((pnl, i) => ({ pnl, exitTime: i }));
  const mc = bt.monteCarlo(mcTrades, 10000, 500);
  ok(mc && mc.iterations === 500 && mc.trades === 12, 'monteCarlo: runs the requested number of iterations over the given trades');
  ok(Math.abs(mc.actualRet - sum(mcTrades.map((t) => t.pnl)) / 10000 * 100) < 1e-9, 'monteCarlo: actualRet is the real observed order, unshuffled');
  ok(mc.retP5 <= mc.retP25 && mc.retP25 <= mc.retMedian && mc.retMedian <= mc.retP75 && mc.retP75 <= mc.retP95, 'monteCarlo: return percentiles are correctly ordered');
  ok(mc.ddWorst >= mc.ddP95 && mc.ddP95 >= mc.ddMedian && mc.ddWorst >= 0, 'monteCarlo: drawdown percentiles are ordered, worst-of-all is the largest');
  ok(mc.streakWorst >= mc.streakP95 && mc.probLoss >= 0 && mc.probLoss <= 100, 'monteCarlo: losing-streak percentiles ordered, probLoss is a valid percentage');
  // Resampling WITH replacement (bootstrap), not a plain reshuffle: a plain reshuffle only reorders the same
  // fixed set, and since addition is commutative, every reshuffle sums to the exact same final return — making
  // retP5/retMedian/retP95 identical and probLoss degenerate to a flat 0% or 100% for ANY input. That would
  // silently defeat the whole point of showing a range. Bootstrap resampling must actually vary the outcome.
  ok(mc.retP5 < mc.retP95, 'monteCarlo: resamples WITH replacement, so the return distribution is not a single repeated constant (a plain reshuffle cannot do this — addition is order-independent)');
  ok(mc.probLoss > 0 && mc.probLoss < 100, 'monteCarlo: probLoss is a genuine probability, not degenerate to 0%/100% (which a plain reshuffle always collapses to)');
  ok(bt.monteCarlo([{ pnl: 10 }, { pnl: -5 }], 1000, 500) === null, 'monteCarlo: too few trades (<10) returns null instead of meaningless percentiles');

  // 4d) both are attached to every backtest report, and walk-forward feeds the sweep's "confident recommendation" check
  const repWithValidation = bt.buildReport(p ? { S: p } : {}, '15', cfg);
  ok(repWithValidation.walkForward && repWithValidation.walkForward.folds === 5, 'buildReport: every report carries a 5-fold walk-forward check');
  ok('monteCarlo' in repWithValidation, 'buildReport: every report carries a Monte Carlo field (null when too few trades, an object otherwise)');

  // 5) the worker thread: same numbers, progress events, no giant trade list in the response
  fs.mkdirSync(process.env.BT_CACHE, { recursive: true });
  const sym = 'TEST:SYNTH';
  fs.writeFileSync(path.join(process.env.BT_CACHE, 'TEST_SYNTH_15_1200.json'), JSON.stringify(bars));
  const phases = [];
  const rep = await runner.run('backtest', { symbols: [sym], tf: '15', candles: 1200 }, (x) => phases.push(x.phase));
  ok(!rep.error && rep.summary && rep.curve.length > 1 && rep.trades === undefined, 'worker: backtest result arrives (curve included, trade list left out)');
  ok(phases.includes('data') && phases.includes('compute'), 'worker: progress events are reported');
  const sw = await runner.run('sweep', { symbols: [sym], tf: '15', candles: 1200 }, (x) => phases.push(x.phase));
  ok(sw.total === 270 && phases.includes('sweep'), 'worker: sweep runs all 270 settings (risk x RSI x confluence) with progress');
  ok(sw.current && sw.current.settings.confluence && typeof sw.current.settings.confluence.enabled === 'boolean',
    'worker: sweep settings carry a confluence choice alongside risk/RSI (not just risk/RSI as before)');
  const rep2 = await runner.run('backtest', { symbols: [sym], tf: '15', candles: 1200 });
  ok(JSON.stringify(rep2.summary) === JSON.stringify(rep.summary), 'worker: a repeat run gives identical numbers');

  // 5c) the matrix mode: one symbol, several (timeframe, strategy) cells at once (dashboard's "مقایسه" section)
  fs.writeFileSync(path.join(process.env.BT_CACHE, 'TEST_SYNTH_30_1200.json'), JSON.stringify(synth(1200, 11)));
  const mxPhases = [];
  const mx = await runner.run('matrix', { symbol: sym, timeframes: ['15', '30'], strategies: ['rsi_dip', 'trend_ma'], days: 400, maxCandles: 1200 }, (x) => mxPhases.push(x.phase));
  ok(!mx.error && mx.symbol === sym && mx.cells.length === 4, 'matrix: one symbol x 2 timeframes x 2 strategies = 4 cells');
  ok(mx.cells.every((c) => c.tf && c.strategyId && c.strategyName && (c.error || c.summary) && c.verdict), 'matrix: every cell names its timeframe/strategy, has either a result or a clear error, and always a verdict');
  const cell15rsi = mx.cells.find((c) => c.tf === '15' && c.strategyId === 'rsi_dip');
  ok(cell15rsi && cell15rsi.summary && cell15rsi.wf && cell15rsi.wf.folds === 5 && typeof cell15rsi.summary.ret === 'number', 'matrix: a cell carries the full result PLUS walk-forward validation (it is judged on the common window, so it is deliberately not identical to a whole-history single backtest)');
  const tfsSeen = new Set(mx.cells.map((c) => c.tf));
  ok(tfsSeen.has('15') && tfsSeen.has('30') && mxPhases.includes('matrix'), 'matrix: both requested timeframes are present, with progress events');
  const missing = await runner.run('matrix', { symbol: 'TEST:NOSUCHDATA', timeframes: ['15'], strategies: ['rsi_dip'], days: 400, maxCandles: 1200 });
  ok(missing.cells[0].error && missing.cells[0].summary === undefined, 'matrix: a symbol with no cached/downloadable data reports a clear per-cell error instead of crashing');

  // 5b) a setting applied via config-overrides.js (mutates config.js's cfg.risk in place, on the MAIN thread)
  // must be picked up by the very next backtest — even though the worker thread is a separate thread with
  // its own module registry and stays alive between runs (it never re-requires config.js on its own).
  const withTrend = (await runner.run('backtest', { symbols: [sym], tf: '15', candles: 1200 })).summary.n;
  const overrides = require('./config-overrides');
  overrides.apply({ risk: { trendFilter: false } });
  const withoutTrend = (await runner.run('backtest', { symbols: [sym], tf: '15', candles: 1200 })).summary.n;
  ok(cfg.risk.trendFilter === false, 'config-overrides: apply() mutates cfg.risk in place (bot.js sees it with no restart)');
  ok(withoutTrend > withTrend, 'worker: a setting applied after the worker started is honoured on the very next run (no restart needed)');
  overrides.reset();
  ok(cfg.risk.trendFilter === true && !overrides.isApplied(), 'config-overrides: reset() restores config.js\'s own defaults and clears the saved file');

  // 6) trade journal + report numbers
  const t0 = Date.now() - 3600000;
  [[100, 'take-profit | PnL'], [-50, 'stop-loss'], [30, 'trailing stop'], [-20, 'stop-loss']].forEach(([pnl, reason], i) =>
    journal.record({ time: t0 + i * 60000, entryTime: t0 + i * 60000 - 600000, symbol: i % 2 ? 'NASDAQ:AAPL' : 'BINANCE:BTCUSDT', mode: 'paper', entry: 100, exit: 100 + pnl / 10, qty: 10, pnl, pct: pnl / 10, reason }));
  const r = journal.report({ mode: 'paper', days: 30 }), s = r.summary;
  ok(s.n === 4 && s.wins === 2 && s.losses === 2 && Math.abs(s.net - 60) < 1e-9, 'report: trade count, wins/losses and net PnL');
  ok(Math.abs(s.profitFactor - 130 / 70) < 1e-9 && s.worstStreak === 1 && Math.abs(s.avgHoldMin - 10) < 1e-6, 'report: profit factor, losing streak and average holding time');
  ok(s.maxDrawdownAbs === 50 && r.curve.length === 4 && r.curve[3][1] === 60, 'report: drawdown on the realized curve and the cumulative curve');
  ok(r.byGroup.some((g) => g.key === 'crypto') && r.byGroup.some((g) => g.key === 'stock') && r.bySymbol.length === 2, 'report: split by market and by symbol');
  ok(journal.report({ mode: 'live', days: 30 }).summary.n === 0, 'report: another mode is kept separate');
  ok(journal.csv({ mode: 'paper', days: 0 }).split('\n').length === 5, 'report: CSV export has a header and every trade');

  // 7) staged (partial) exit: bank part of the position at a nearer milestone, let the rest ride
  function synthTrend(len) {
    return Array.from({ length: len }, (_, i) => {
      const price = 100 + Math.sin(i / 8) * 10 + Math.sin(i / 2.3) * 3 + i * 0.01;
      const open = price - 0.3, close = price + 0.3;
      return { time: 1700000000 + i * 900, open, close, max: Math.max(open, close) + 0.5, min: Math.min(open, close) - 0.5, volume: 100 + (i % 25) * 10 };
    });
  }
  const trendBars = synthTrend(2500), trendPrep = bt.prepare(trendBars, cfg.rsi, cfg.risk);
  const peBase = { risk: cfg.risk, rsi: cfg.rsi, confluence: { enabled: false }, strategy: { id: 'trend_ma' } };
  const pe50 = { risk: { trendFilter: false, partialExit: { enabled: true, atR: 1, closePct: 50, moveStopToBreakeven: true } } };
  const peOff = { risk: { trendFilter: false, partialExit: { enabled: false } } };
  const peRes = bt.run({ S: trendPrep }, 0, 1, pe50, peBase);
  const partials = peRes.trades.filter((t) => t.reason === 'partial take-profit');
  ok(partials.length > 5, 'partial exit: a trending synthetic series produces several partial exits to check');
  const remainders = partials.map((pt) => peRes.trades.find((t) => t.entryTime === pt.entryTime && t.reason !== 'partial take-profit'));
  ok(remainders.every(Boolean), 'partial exit: every partial has a matching later close for the position\'s remainder (same entryTime)');
  ok(partials.every((pt, i) => Math.abs(pt.qty - remainders[i].qty) < 1e-9), 'partial exit: a 50% split banks exactly half the qty, leaving exactly half as the remainder');
  ok(partials.every((pt) => pt.exit > pt.entry), 'partial exit: always closes at a profit (it is a take-profit milestone, atR R above entry)');
  ok(remainders.every((r) => r.pct >= -1), 'partial exit: moveStopToBreakeven protects the remainder — no remainder loses more than ~fees/slippage');
  ok(remainders.every((r) => r.reason !== 'take-profit'), 'partial exit: trailing takes over for the remainder (original fixed target is lifted, never closes as a plain take-profit)');
  ok(partials.every((pt) => pt.r < cfg.risk.takeProfitRR), 'partial exit: the partial leg banks at 1R, well under the full 2R target');

  const peDisabled = bt.summarize(bt.run({ S: trendPrep }, 0, 1, peOff, peBase));
  const pe0 = { risk: { trendFilter: false, partialExit: { enabled: true, atR: 1, closePct: 0, moveStopToBreakeven: true } } };
  const peZero = bt.summarize(bt.run({ S: trendPrep }, 0, 1, pe0, peBase));
  ok(JSON.stringify(peZero) === JSON.stringify(peDisabled), 'partial exit: closePct 0 is a true no-op — identical results to partialExit disabled entirely');

  const pe100 = { risk: { trendFilter: false, partialExit: { enabled: true, atR: 1, closePct: 100, moveStopToBreakeven: true } } };
  const peFull = bt.run({ S: trendPrep }, 0, 1, pe100, peBase);
  ok(!peFull.trades.some((t) => t.reason === 'partial take-profit'), 'partial exit: closePct 100 routes through the ordinary full-close path, never labelled as a split');
  ok(peFull.trades.some((t) => t.reason === 'take-profit (partial = 100%)'), 'partial exit: closePct 100 is still visibly distinguished in the reason text');

  console.log(`\n${n} backtest/report checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack); process.exit(1); });
