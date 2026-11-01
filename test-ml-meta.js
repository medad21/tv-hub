// Offline checks for meta-labeling in the ML lab (ml-pooled.js runMeta + /api/ml/run-meta): a strategy gives the signals, the model only takes or
// skips them. Most important: pure noise is NOT sold as a useful filter, a hidden pattern that decides which signals work IS found (on symbols
// the model never trained on), and the report compares with the only fair baseline — taking every signal. Run: node test-ml-meta.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mlmeta-'));
process.env.CANDLE_DIR = path.join(tmp, 'candles'); process.env.TRIALS_FILE = path.join(tmp, 'trials.json'); process.env.DATA_DIR = tmp;
const mp = require('./ml-pooled');
const backtest = require('./backtest');
const strategy = require('./strategy');
let passed = 0;
const ok = (c, m) => { assert(c, m); passed++; console.log('  ok  ' + m); };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
// drift flips sign with the hour of the day: a long signal works in the "up" hours and fails in the "down" hours, whatever the strategy is
function makeBars(n, seed, drift = 0, common = null, step = 3600) {
  const r = rng(seed), bars = []; let c = 100;
  for (let i = 0; i < n; i++) {
    const time = 1700000000 + i * step, hr = Math.floor(time / 3600) % 24;
    const o = c, ret = (hr < 12 ? drift : -drift) + 0.004 * gauss(r) + (common ? 0.002 * common[i] : 0);
    c = o * Math.exp(ret);
    const hi = Math.max(o, c) * (1 + Math.abs(gauss(r)) * 0.0015), lo = Math.min(o, c) * (1 - Math.abs(gauss(r)) * 0.0015);
    bars.push({ time, open: o, max: hi, min: lo, close: c, volume: 1000 + Math.floor(r() * 500) });
  }
  return bars;
}
const N = 9000, rc = rng(5), common = Array.from({ length: N }, () => gauss(rc));
const mk = (drift, base = 100, n = N) => [0, 1, 2, 3].map((k) => ({ name: 'S' + k, bars: makeBars(n, base + k, drift, common) }));
const fast = { folds: 4, features: ['time'] };

(async () => {
  // 1. the signals are the backtest's signals: signalSeries == strategySignal on the same readings
  {
    const bars = makeBars(1200, 7, 0.001), sig = backtest.signalSeries(bars, 'rsi_dip', { period: 14, buy: 30, sell: 70 }, { atrPeriod: 14, trendEma: 100 });
    const closes = bars.map((b) => b.close); let same = true, buys = 0;
    for (let i = 0; i < bars.length; i++) { const r = strategy.rsi(closes.slice(Math.max(0, i - 299), i + 1), 14), want = strategy.signal(r, { buy: 30, sell: 70 }); if (want !== sig[i]) same = false; if (want === 'buy') buys++; }
    ok(same && buys > 5, `signalSeries equals the strategy's own signal on every candle (${buys} buy candles)`);
    ok(backtest.signalSeries(bars, 'no_such_strategy') === null, 'an unknown strategy gives no signals (never silently another strategy)');
  }
  // 2. a hidden pattern decides which signals work: the filter finds it, on symbols it never trained on, and beats "take every signal"
  for (const sid of ['trend_ma', 'rsi_dip']) {
    const r = mp.runMeta(mk(0.0012), { ...fast, strategy: sid, mode: 'loso' });
    ok(r.ok && r.pooled && r.meta && r.meta.strategy === sid && r.meta.dir === 'long' && r.meta.signals > 100, `${sid}: meta report with ${r.meta.signals} signals`);
    ok(r.meta.selected.meanR > r.meta.takeAll.meanR + 0.15 && r.meta.selected.trades < r.meta.takeAll.trades, `${sid}: the filter takes fewer signals and earns more per signal (${r.meta.selected.meanR.toFixed(2)}R vs ${r.meta.takeAll.meanR.toFixed(2)}R for all)`);
    ok(r.stats.aucPerm.p < 0.05 && r.stats.tradePerm.p < 0.05, `${sid}: both permutation tests call it real (p ${r.stats.aucPerm.p.toFixed(3)} / ${r.stats.tradePerm.p.toFixed(3)})`);
    ok(r.audit.heldOutInTrain === false && r.audit.maxTrainEndBeforeTest === true, `${sid}: the tested symbol is never in training; training labels end before the test block`);
    ok(/فیلتر مدل/.test(r.verdict.text), `${sid}: the verdict says how it compares with taking everything`);
  }
  // 3. noise: never "promising", permutation tests do not call it significant (several seeds)
  for (const [sid, base] of [['trend_ma', 300], ['trend_ma', 400], ['rsi_dip', 500], ['breakout', 600]]) {
    const r = mp.runMeta(mk(0, base), { ...fast, strategy: sid, mode: 'loso' });
    ok(r.verdict.level !== 'promising' && r.stats.aucPerm.p > 0.02, `noise (${sid}, seed ${base}): not promising, AUC permutation p ${r.stats.aucPerm.p.toFixed(3)}, verdict ${r.verdict.level}`);
  }
  // 4. sell signals / the short side use the SELL edges and the short outcome
  {
    const r = mp.runMeta(mk(0.0012), { ...fast, strategy: 'trend_ma', dir: 'short', mode: 'loso' });
    ok(r.meta.dir === 'short' && r.meta.signals > 100 && r.meta.selected.meanR > r.meta.takeAll.meanR + 0.1, `short side: sell signals filtered the same way (${r.meta.selected.meanR.toFixed(2)}R vs ${r.meta.takeAll.meanR.toFixed(2)}R)`);
  }
  // 5. one archive only: allowed (time hold-out only, mode becomes walk) when it has enough signals; refused clearly when it has too few
  {
    const r = mp.runMeta([{ name: 'ONE', bars: makeBars(30000, 41, 0.0012) }], { ...fast, strategy: 'trend_ma' });
    ok(r.ok && r.mode === 'walk' && r.perSymbol.length === 1 && r.meta.signals > 300, `one archive with ${r.meta.signals} signals: runs with the time hold-out only (mode walk)`);
    let msg = null; try { mp.runMeta([mk(0.0012)[0]], { ...fast, strategy: 'trend_ma' }); } catch (e) { msg = e.message; }
    ok(msg && /سیگنال/.test(msg), 'one archive with only ~100 signals: refused with a clear message, not a meaningless number');
  }
  // 6. refusals with clear messages
  {
    const bad = (f, re, m) => { let msg = null; try { f(); } catch (e) { msg = e.message; } ok(msg && re.test(msg), m); };
    bad(() => mp.runMeta(mk(0), { ...fast, strategy: 'nope' }), /استراتژی پیدا نشد/, 'unknown strategy -> refused');
    bad(() => mp.runMeta([], { strategy: 'trend_ma' }), /۱ تا ۱۲/, 'no archive -> refused');
    bad(() => mp.runMeta([{ name: 'a', bars: makeBars(3000, 1) }, { name: 'b', bars: makeBars(3000, 2, 0, null, 1800) }], { strategy: 'trend_ma' }), /تایم‌فریم/, 'different timeframes -> refused');
    bad(() => mp.runMeta([0, 1].map((k) => ({ name: 'F' + k, bars: makeBars(1500, 800 + k, 0) })), { ...fast, strategy: 'trend_ma', folds: 5 }), /سیگنال/, 'far too few signals -> says so instead of a meaningless result');
  }
  // 7. cost sweep
  {
    const r = mp.runMetaSweep(mk(0.0012), { ...fast, strategy: 'trend_ma', costAtr: 0.1 });
    ok(r.costSweep.length >= 3 && r.costSweep.every((c, i) => i === 0 || c.costAtr > r.costSweep[i - 1].costAtr) && r.meta, 'sweep: ascending costs, meta block present');
  }
  // 7b. real cost: each symbol pays its OWN market's cost (the bot's table), reported in ATR; the multiplier and the sweep work
  {
    ok(mp.symbolOf('BINANCE_BTCUSDT_60') === 'BINANCE:BTCUSDT' && mp.symbolOf('MT5_OANDA_XAUUSD_60') === 'OANDA:XAUUSD', 'archive names map to the symbols the bot\'s cost table knows');
    const table = { feePct: 0.1, slippagePct: 0.05, costs: { crypto: { feePct: 0.1, slippagePct: 0.05 }, forex: { feePct: 0, slippagePct: 0.03 } } };
    ok(Math.abs(mp.costPctFor('BINANCE_BTCUSDT_60', table) - 0.003) < 1e-12 && Math.abs(mp.costPctFor('MT5_OANDA_EURUSD_60', table) - 0.0006) < 1e-12 && Math.abs(mp.costPctFor('WHATEVER_60', table) - 0.003) < 1e-12, 'round-trip cost = 2 x (fee + slippage) of the symbol\'s market; unknown markets use the flat fallback');
    const two = [{ name: 'BINANCE_AAAUSDT_60', bars: makeBars(9000, 71, 0.0012, common) }, { name: 'MT5_OANDA_EURUSD_60', bars: makeBars(9000, 72, 0.0012, common) }];
    const o = { ...fast, strategy: 'trend_ma', mode: 'walk', costMode: 'real', costTable: table };
    const r1 = mp.runMeta(two, o), r0 = mp.runMeta(two, { ...o, costMult: 0 }), r2 = mp.runMeta(two, { ...o, costMult: 2 });
    const c = Object.fromEntries(r1.perSymbol.map((x) => [x.name, x.costAtr]));
    ok(r1.cost.mode === 'real' && c.BINANCE_AAAUSDT_60 / c.MT5_OANDA_EURUSD_60 > 4 && c.BINANCE_AAAUSDT_60 / c.MT5_OANDA_EURUSD_60 < 6, `each symbol is charged its own cost (crypto ${c.BINANCE_AAAUSDT_60.toFixed(2)} ATR vs forex ${c.MT5_OANDA_EURUSD_60.toFixed(2)} ATR, about 5x as in the table)`);
    ok(r0.meta.takeAll.meanR > r1.meta.takeAll.meanR && r1.meta.takeAll.meanR > r2.meta.takeAll.meanR, 'cost multiplier: x0 > x1 > x2 for the same signals');
    ok(r1.perSymbol.every((x) => x.candles === 9000) && r1.candles === 18000, 'the report says how many candles each symbol and the whole source contributed');
    const sw = mp.runMetaSweep(two, o);
    ok(sw.costSweep.map((x) => x.costMult).join() === '0,0.5,1,2' && sw.costSweep.filter((x) => x.main).length === 1 && sw.costSweep.every((x, i) => i === 0 || x.meanR <= sw.costSweep[i - 1].meanR + 1e-9), 'real-cost sweep: x0, x0.5, x1, x2 of the table, one marked as the chosen, results never improve with cost');
    const fx = mp.runMeta(two, { ...o, costMode: 'fixed' });
    ok(fx.cost.mode === 'fixed' && Math.abs(fx.perSymbol[0].costAtr - 0.1) < 1e-9, 'fixed mode keeps the old behaviour (one cost in ATR for every symbol)');
  }
  // 8. the HTTP route (real express app, real archives, worker thread)
  {
    const express = require('express'), candleStore = require('./candle-store'), router = require('./ml-routes');
    const app = express(); app.use('/api/ml', router());
    const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/ml`;
    const post = async (body) => { const r = await fetch(base + '/run-meta', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
    ['TST_A', 'TST_B', 'TST_C'].forEach((nm, k) => candleStore.merge(nm, '60', makeBars(N, 700 + k, 0.0012, common)));
    candleStore.merge('TST_D', '30', makeBars(N, 9, 0, null, 1800));
    const sl = await (await fetch(base + '/strategies')).json();
    ok(sl.strategies.some((s) => s.id === 'rsi_dip') && sl.strategies.some((s) => s.id === 'setup_consensus') && sl.active, 'route: /strategies lists the built-in strategies and the active one');
    ok((await post({ files: [], strategy: 'trend_ma' })).status === 400, 'route: no archive -> 400');
    ok((await post({ files: ['TST_A_60', 'TST_B_60'], strategy: 'nope' })).status === 400, 'route: unknown strategy -> 400');
    ok((await post({ files: ['TST_A_60', 'TST_D_30'], strategy: 'trend_ma' })).status === 400, 'route: mixed timeframes -> 400');
    const r = await post({ files: ['TST_A_60', 'TST_B_60', 'TST_C_60'], strategy: 'trend_ma', folds: 4, features: ['time'], costAtr: 0.05 });
    ok(r.status === 200 && r.json.source === 'meta' && r.json.meta && r.json.strategyName && r.json.trial && r.json.trial.trials >= 1, 'route: 200 with the meta report and the research ledger updated');
    ok(r.json.meta.selected.meanR > r.json.meta.takeAll.meanR, 'route: the filter beats taking every signal through the whole stack (worker thread included)');
    server.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
