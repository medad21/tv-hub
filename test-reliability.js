// Offline checks for: realistic fills (next candle open), per-market costs, combined setups, the timeframe comparison
// (common window, verdicts, honest "nothing reliable" answer), and the complete signal cards. Run: npm test
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-rel-'));
process.env.CONFIG_OVERRIDES_FILE = path.join(tmp, 'config.local.json');
process.env.BT_CACHE = path.join(tmp, 'cache');
process.env.TRADE_LOG = path.join(tmp, 'trades.jsonl');
process.env.EVENT_LOG = path.join(tmp, 'events.log');
process.env.STATE_FILE = path.join(tmp, 'state.json');
process.env.DATA_DIR = tmp;
process.env.MODE = 'signal';

const cfg = require('./config');
const bt = require('./backtest');
const { strategySignal, STRATEGIES, STRATEGY_READS } = require('./strategy');
const { costsFor } = require('./risk');
let passed = 0;
const ok = (c, m) => { assert(c, m); passed++; console.log('  ok  ' + m); };

// deterministic pseudo-random bars (so the numbers never flake)
function seeded(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
function makeBars(n, stepSec, endTime, seed = 7, drift = 0.0002) {
  const r = seeded(seed); let p = 100; const out = [];
  for (let i = 0; i < n; i++) {
    const open = p, wave = Math.sin(i / 40) * 0.004, ret = drift + wave + (r() - 0.5) * 0.02;
    const close = open * (1 + ret), max = Math.max(open, close) * (1 + r() * 0.006), min = Math.min(open, close) * (1 - r() * 0.006);
    out.push({ time: endTime - (n - 1 - i) * stepSec, open, close, max, min, volume: 1000 + r() * 1000 });
    p = close;
  }
  return out;
}

// ---- 1) per-market costs ----
{
  const R = cfg.risk;
  ok(costsFor('BINANCE:BTCUSDT', R).feePct === R.costs.crypto.feePct, 'costs: crypto symbol uses the crypto numbers');
  ok(costsFor('OANDA:XAUUSD', R).feePct === 0 && costsFor('OANDA:XAUUSD', R).slippagePct === R.costs.forex.slippagePct, 'costs: gold/forex has no fee but its own slippage/spread');
  ok(costsFor('NASDAQ:AAPL', R).slippagePct === R.costs.stock.slippagePct, 'costs: stocks use the stock numbers');
  ok(costsFor('WHATEVER:XYZ', R).feePct === R.feePct, 'costs: an unknown symbol falls back to the flat fee');
}

// ---- 2) fills: next candle open vs same candle close ----
{
  const end = 1_800_000_000, bars = makeBars(1500, 3600, end);
  const SYM = 'BINANCE:BTCUSDT', base = (mode) => ({ risk: { ...cfg.risk, fillMode: mode, trendFilter: false }, rsi: cfg.rsi, confluence: { ...cfg.confluence, enabled: false }, strategy: { id: 'trend_ma' } });
  const slip = costsFor(SYM, cfg.risk).slippagePct / 100;
  for (const mode of ['next_open', 'close']) {
    const prep = { [SYM]: bt.prepare(bars, cfg.rsi, cfg.risk) };
    const res = bt.run(prep, 0, 1, {}, base(mode));
    ok(res.trades.length > 3, `fills(${mode}): the scenario produces trades (${res.trades.length})`);
    const byTime = new Map(bars.map((b) => [b.time, b]));
    const all = res.trades.every((t) => { const b = byTime.get(t.entryTime); const px = mode === 'next_open' ? b.open : b.close; return Math.abs(t.entry - px * (1 + slip)) < 1e-9; });
    ok(all, `fills(${mode}): every entry is exactly the ${mode === 'next_open' ? 'OPEN' : 'CLOSE'} of its candle plus slippage`);
  }
  const A = bt.summarize(bt.run({ [SYM]: bt.prepare(bars, cfg.rsi, cfg.risk) }, 0, 1, {}, base('next_open')));
  ok(Number.isFinite(A.ret) && A.n > 0, 'fills: next-open run produces a finite result');
}

// ---- 3) combined setups ----
{
  const rc = { buy: 30, sell: 70 };
  ok(strategySignal('setup_trend_dip', { emaShort: 11, emaLong: 10, rsi: 25 }, null, rc) === 'buy', 'setup trend+dip: dip inside an uptrend -> buy');
  ok(strategySignal('setup_trend_dip', { emaShort: 9, emaLong: 10, rsi: 25 }, null, rc) !== 'buy', 'setup trend+dip: the same dip inside a downtrend -> NOT a buy');
  ok(strategySignal('setup_trend_dip', { emaShort: 11, emaLong: 10, rsi: 50 }, null, rc) === 'hold', 'setup trend+dip: uptrend without a dip -> hold');
  ok(strategySignal('setup_consensus', { rsi: 25, emaShort: 11, emaLong: 10, close: 5, hh: 4, ll: 1, hist: 1 }, null, rc) === 'buy', 'setup consensus: 4 of 4 bullish -> buy');
  ok(strategySignal('setup_consensus', { rsi: 50, emaShort: 11, emaLong: 10, close: 3, hh: 4, ll: 1, hist: 1 }, null, rc) === 'hold', 'setup consensus: only 2 of 4 bullish -> hold');
  ok(strategySignal('setup_consensus', { rsi: 75, emaShort: 9, emaLong: 10, close: 3, hh: 4, ll: 1, hist: 1 }, null, rc) === 'sell', 'setup consensus: 2 bearish votes -> sell');
  ok(Object.keys(STRATEGIES).filter((k) => k.startsWith('setup_')).every((k) => STRATEGY_READS[k] && STRATEGY_READS[k].fields.length >= 2), 'setups: every setup knows which readings it needs');
  const bars = makeBars(2500, 3600, 1_800_000_000, 11), SYM = 'BINANCE:ETHUSDT';
  const prep = { [SYM]: bt.prepare(bars, cfg.rsi, cfg.risk) };
  for (const id of Object.keys(STRATEGIES)) {
    const r = bt.summarize(bt.run(prep, 0, 1, {}, { risk: { ...cfg.risk, trendFilter: false }, rsi: cfg.rsi, confluence: { ...cfg.confluence, enabled: false }, strategy: { id } }));
    ok(Number.isFinite(r.ret), `backtest runs for strategy "${id}" (${r.n} trades)`);
  }
}

// ---- 4) verdicts ----
{
  const S = (o) => ({ n: 40, ret: 12, pf: 1.6, avgR: 0.3, ...o }), W = (p) => ({ profitableFolds: p, folds: 5 }), M = (l) => ({ probLoss: l });
  ok(bt.judge(S({ n: 8 }), W(5), M(0)).verdict === 'insufficient', 'verdict: 8 trades -> insufficient, however good it looks');
  ok(bt.judge(S({ ret: -3, pf: 0.8 }), W(1), M(80)).verdict === 'negative', 'verdict: losing -> negative');
  ok(bt.judge(S(), W(2), M(10)).verdict === 'suspect', 'verdict: profitable in only 2 of 5 segments -> suspect');
  ok(bt.judge(S(), W(4), M(35)).verdict === 'suspect', 'verdict: Monte Carlo says 35% chance of loss -> suspect');
  ok(bt.judge(S({ pf: 1.05 }), W(4), M(10)).verdict === 'suspect', 'verdict: profit factor 1.05 is too thin -> suspect');
  ok(bt.judge(S(), W(4), M(10)).verdict === 'reliable', 'verdict: enough trades, PF, segments and Monte Carlo -> reliable');
}

// ---- 5) the timeframe comparison, offline (candles come from the cache folder, nothing is downloaded) ----
(async () => {
  const SYM = 'BINANCE:BTCUSDT', end = 1_800_000_000, dir = process.env.BT_CACHE;
  fs.mkdirSync(dir, { recursive: true });
  const put = (tf, bars, n) => fs.writeFileSync(path.join(dir, `${SYM.replace(/[^A-Za-z0-9]/g, '_')}_${tf}_${n}.json`), JSON.stringify(bars));
  put('60', makeBars(1200, 3600, end, 3), 1200);      // 50 days of hourly candles
  put('240', makeBars(1200, 14400, end, 5), 1200);    // 200 days of 4-hour candles
  const m = await bt.runMatrix({ symbol: SYM, timeframes: ['60', '240'], strategies: ['trend_ma', 'setup_trend_dip'], days: 400, maxCandles: 1200 });
  ok(m.cells.length === 4 && m.cells.every((c) => ['reliable', 'suspect', 'negative', 'insufficient'].includes(c.verdict)), 'matrix: every cell gets a verdict');
  ok(m.window.days >= 36 && m.window.days <= 39, `matrix: ONE common window = the shorter history (~37.5 days; got ${m.window.days})`);
  const c60 = m.cells.find((c) => c.tf === '60'), c240 = m.cells.find((c) => c.tf === '240');
  ok(c60.window.candles > 700 && c240.window.candles < 300, 'matrix: both timeframes judged over the same dates (hourly has ~4x the candles of 4-hour)');
  ok(m.cells.filter((c) => c.summary).every((c) => c.wf && c.wf.folds === 5), 'matrix: every cell is walk-forward validated (the old matrix threw this away)');
  ok(typeof m.text === 'string' && m.text.includes('بازه‌ی بررسی') && m.text.includes('تعداد ترکیب آزمایش‌شده: 4'), 'matrix: the report states the window and how many combinations were tried');
  ok(m.assumptions.fillMode === 'next_open', 'matrix: report states fills are at the next open');
  const fake = { symbol: 'X', cells: [{ tf: '60', strategyId: 'a', strategyName: 'A', verdict: 'negative', reasons: ['x'], summary: { ret: -5, n: 40, winRate: 30, pf: 0.7, avgR: -0.2, maxDD: 9, buyHold: 3 }, wf: { profitableFolds: 1, folds: 5 }, mc: { probLoss: 80 } }], cellsTested: 1, window: { from: 0, to: 86400 * 30, days: 30, requestedDays: 30 }, assumptions: { fillMode: 'next_open', costs: { feePct: 0.1, slippagePct: 0.05 } } };
  {
    // strict: 60m has ~50 days of history, 240m ~200 days (1200 candles each). Asking for 150 days must NOT shrink to 50 days.
    const loose = await bt.runMatrix({ symbol: SYM, timeframes: ['60', '240'], strategies: ['trend_ma'], days: 150, maxCandles: 1200 });
    const strict = await bt.runMatrix({ symbol: SYM, timeframes: ['60', '240'], strategies: ['trend_ma'], days: 150, maxCandles: 1200, strict: true });
    ok(loose.window.days < 100, 'matrix (default): window shrinks to the shortest history');
    ok(strict.excludedTfs.length === 1 && strict.excludedTfs[0].tf === '60' && strict.window.days >= 140, `matrix (strict): the short-history timeframe is left out and the window stays ~150 days (got ${strict.window.days})`);
    const c60s = strict.cells.find((c) => c.tf === '60');
    ok(c60s.verdict === 'insufficient' && c60s.reasons[0].includes('تاریخچه') && strict.text.includes('کنار گذاشته‌شده'), 'matrix (strict): the report says which timeframe was left out and why');
  }
  const t = bt.matrixReportText(fake);
  ok(t.includes('هیچ ترکیبی') && t.includes('نه این‌که «بهترینِ بد»'), 'report: when nothing is reliable it says so instead of crowning the least bad');
  // ---- 6) complete signal cards in signal mode ----
  const bot = require('./bot'), SIG = 'BINANCE:ETHUSDT';
  const info = { timeframe: '60', barTime: 1790000000, rsi: 27.5, extra: { macdHist: -0.1, macdPrevHist: -0.3, volume: 2000, avgVol: 1000 } };
  const buy = () => bot.signal({ symbol: SIG, side: 'buy', price: 100, atr: 2, trendOk: true, strategyName: 'اصلاح موقت (RSI)', info });
  const e1 = await buy();
  ok(e1 && e1.card && e1.side === 'buy', 'signal card: a buy produces a card');
  ok(['ورود پیشنهادی', 'حد ضرر', 'حد سود', 'حجم پیشنهادی', 'ریسک', 'چرا', 'تایم‌فریم', 'اصلاح موقت'].every((w) => e1.note.includes(w)), 'signal card: has entry, stop, target, size, risk, reason, timeframe and strategy');
  ok(e1.note.includes('96') && e1.note.includes('108'), 'signal card: stop 96 (2 x ATR below 100) and target 108 (1:2) are right');
  ok(JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8')).sigPos[SIG], 'signal card: the suggested position is saved (survives a restart)');
  const e2 = await buy();
  ok(e2 && e2.side === 'skip', 'signal card: a second buy while one is open is skipped, not duplicated');
  const e3 = await bot.tick({ symbol: SIG, price: 108.5 });
  ok(e3 && e3.card && e3.note.includes('به حد سود رسید') && e3.note.includes('نتیجه') && e3.note.includes('مدت نگه‌داری'), 'signal card: reaching the target reports the result and time held');
  const e4 = await bot.signal({ symbol: SIG, side: 'sell', price: 105, atr: 2, trendOk: true, strategyName: 'X', info });
  ok(e4 && e4.card && e4.note.includes('بستن') && e4.note.includes('ثبت نیست'), 'signal card: a sell with no tracked position explains what it means (close if you hold one)');
  await buy();
  const e5 = await bot.signal({ symbol: SIG, side: 'sell', price: 103, atr: 2, trendOk: true, strategyName: 'X', info });
  ok(e5 && e5.note.includes('ورود بود در: 100') && e5.note.includes('نتیجه') && e5.note.includes('R'), 'signal card: a sell of a tracked position shows the entry and the result in % and R');
  await buy();
  const e6 = await bot.tick({ symbol: SIG, price: 95 });
  ok(e6 && e6.note.includes('حد ضرر خورد') && e6.note.includes('نتیجه'), 'signal card: the stop is reported with the loss');
  const e7 = await bot.tick({ symbol: SIG, price: 90 });
  ok(e7 === null, 'signal card: nothing more is reported once the position is closed');

  // regression: the comparison report crashed with "Cannot read properties of null (reading 'toFixed')" — a cell with no losing
  // trades has Profit Factor = Infinity, JSON turns that into null, and the page called null.toFixed(). Render the REAL page code
  // with data that went through a JSON round trip.
  {
    const vm = require('vm');
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const helpers = (html.match(/^const (pct|fx|pfx) = .*$/gm) || []).join('\n') + '\n';
    const render = html.slice(html.indexOf('const MX_BADGE'), html.indexOf('async function runMatrixCompare'));
    const els = {};
    const sandbox = { $: (id) => (els[id] = els[id] || { style: {}, addEventListener() {} }), esc: (x) => String(x), tfLabel: (x) => x, URL, Blob, document: { createElement: () => ({}) } };
    vm.createContext(sandbox);
    vm.runInContext(helpers + render + ';this.renderMxResults = renderMxResults;', sandbox);
    const summary = { n: 40, ret: 12.5, pf: Infinity, avgR: 0.8, maxDD: 3.2, winRate: 100, buyHold: 5 };
    const wf = { folds: 5, profitableFolds: 5 };
    const data = JSON.parse(JSON.stringify({ symbol: 'X', window: { from: 1, to: 86400 * 100, days: 100 }, assumptions: { fillMode: 'next_open', costs: { feePct: 0.1, slippagePct: 0.05 } },
      cells: [{ tf: '60', strategyId: 'rsi_dip', strategyName: 'RSI', verdict: 'reliable', reasons: [], summary, wf }], cellsTested: 1, best: { tf: '60', strategyId: 'rsi_dip' }, text: 'x' }));
    ok(data.cells[0].summary.pf === null, 'precondition: Infinity profit factor arrives as null after JSON');
    let threw = null;
    try { sandbox.renderMxResults(data); } catch (e) { threw = e; }
    ok(!threw, 'comparison report renders when profit factor is null (was: Cannot read properties of null (reading toFixed))' + (threw ? ' — ' + threw.message : ''));
    ok(els.mxResults.innerHTML.includes('PF ∞') && els.mxResults.innerHTML.includes('PF ∞،'), 'a cell with no losing trades shows PF ∞ in the table and in the best-combination line');
  }

  console.log(`\n${passed} reliability/setup checks passed`);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
