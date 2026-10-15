// Offline checks for the two honesty fixes: (1) multi-symbol splits follow the CALENDAR, (2) a Sweep never lets the kept-out
// data influence a choice, and only recommends what survives the luck correction and one run on that kept-out data.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-sw-'));
process.env.CONFIG_OVERRIDES_FILE = path.join(tmp, 'config.local.json');
process.env.TRIALS_FILE = path.join(tmp, 'trials.json');
process.env.DATA_DIR = tmp;
process.env.MODE = 'paper';
const cfg = require('./config');
const bt = require('./backtest');

let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ok  ' + m); };

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
function walk(seed, len, t0 = 1700000000, step = 3600, p0 = 100) {
  const r = rng(seed); let p = p0, t = t0; const bars = [];
  for (let i = 0; i < len; i++) {
    const o = p, c = o * (1 + 0.004 * gauss(r));
    bars.push({ time: t, open: o, max: Math.max(o, c) * (1 + Math.abs(0.002 * gauss(r))), min: Math.min(o, c) * (1 - Math.abs(0.002 * gauss(r))), close: c, volume: 1000 * (1 + Math.abs(gauss(r))) });
    p = c; t += step;
  }
  return bars;
}
const prepOf = (bars, base = cfg) => bt.prepare(bars, base.rsi, base.risk);

// ---- 1) calendar-aligned slices ----
{
  const A = walk(1, 2000), B = walk(2, 500, 1700000000 + 1500 * 3600); // B only has the last quarter of A's calendar
  const one = { A: prepOf(A) };
  ok(JSON.stringify(bt.ranges(one, 0.2, 0.7)) === JSON.stringify([[400, 1400]]), 'one symbol: the slice is a plain fraction of its own bars, exactly as before');
  const two = { A: prepOf(A), B: prepOf(B) };
  const t0 = A[0].time, t1 = A[A.length - 1].time, cut = t0 + 0.5 * (t1 - t0);
  const lo = bt.ranges(two, 0, 0.5), hi = bt.ranges(two, 0.5, 1);
  ok(hi[0][0] > 0 && A[hi[0][0]].time >= cut && A[hi[0][0] - 1].time < cut, 'two symbols: the second half starts at the same calendar time for the longer history');
  ok(lo[1][0] === 0 && lo[1][1] === 0 && hi[1][0] === 0 && hi[1][1] === 500, 'two symbols: a symbol whose data only exists late has no bars in the early slice and ALL its bars in the late one (index-cutting would have dropped half of them)');
  ok(lo[0][1] === hi[0][0] && lo[1][1] === hi[1][0], 'consecutive slices share their cut: no overlap, no gap');
  ok(hi[0][1] === 2000 && hi[1][1] === 500, 'the last slice reaches the end of every symbol');
  const r = bt.run(two, 0, 0.5, {}, cfg);
  ok(r.trades.every((x) => x.symbol !== 'B') && Number.isFinite(r.buyHold), 'run(): a symbol with no bars in the slice trades nothing and does not break buy-and-hold');
  const all = bt.run(two, 0, 1, {}, cfg);
  ok(all.trades.length >= r.trades.length, 'run() over the whole window still works with different-length symbols');
}

// ---- 2) the Sweep ----
const mkPrep = (seedBase, len, mut) => {
  const prep = {};
  ['A:X1', 'A:X2', 'A:X3'].forEach((s, j) => { let b = walk(seedBase + j, len); if (mut) b = mut(b, j); prep[s] = prepOf(b); });
  return prep;
};
const baseFor = (id) => ({ risk: cfg.risk, rsi: cfg.rsi, confluence: cfg.confluence, strategy: { id } });
{
  const base = baseFor('breakout');
  const sw = bt.buildSweep(mkPrep(300, 2000), null, base);
  ok(sw.holdFraction === 0.25 && bt.SWEEP_HOLD === 0.25, 'sweep: reports that the last 25% is kept out');
  ok(sw.recommended === null && typeof sw.noRecommendationReason === 'string', 'sweep: pure random data -> no recommendation, with a reason');
  ok(['nomatch', 'weak', 'inconsistent', 'luck', 'holdout_failed', 'holdout_inconclusive'].includes(sw.noRecommendationReason), 'sweep: the reason is one the dashboard knows how to explain');
  ok(sw.comparedSettings > 0 && sw.comparedSettings <= sw.total, 'sweep: says how many settings were compared (the luck correction uses this)');
  ok(sw.top.every((r) => r.walkForward && r.walkForward.folds === 5), 'sweep: shortlisted rows carry their walk-forward');
}
{
  // the kept-out data must not change ANY choice: replace the last 25% of every symbol with completely different prices
  const H = 1 - bt.SWEEP_HOLD, len = 2400, cutIdx = Math.floor(len * H);
  const base = baseFor('trend_ma');
  const a = bt.buildSweep(mkPrep(500, len), null, base);
  const b = bt.buildSweep(mkPrep(500, len, (bars, j) => bars.slice(0, cutIdx).concat(walk(9000 + j, len - cutIdx, bars[cutIdx - 1].time + 3600, 3600, bars[cutIdx - 1].close * 3))), null, base);
  const pick = (s) => JSON.stringify({ top: s.top, current: s.current, compared: s.comparedSettings });
  ok(pick(a) === pick(b), 'sweep: totally different data in the kept-out part leaves the ranking, train/test and walk-forward numbers identical');
}
{
  // a strong planted edge (returns that persist) can pass every gate, so the strictness is not "never recommend"
  let rec = 0, seen = 0;
  for (let k = 0; k < 6; k++) {
    const prep = {}; ['A:X1', 'A:X2', 'A:X3'].forEach((s, j) => { const r = rng(4000 + 10 * k + j); let p = 100, prev = 0; const bars = walk(4000 + 10 * k + j, 6000).map((x) => { const o = p, ret = 0.4 * prev + 0.004 * gauss(r); prev = ret; const c = o * (1 + ret); p = c; return { ...x, open: o, close: c, max: Math.max(o, c) * 1.001, min: Math.min(o, c) * 0.999 }; }); prep[s] = prepOf(bars); });
    const sw = bt.buildSweep(prep, null, baseFor('breakout')); seen++;
    if (sw.recommended) { rec++; ok(sw.recommended.holdout && sw.recommended.holdout.status === 'confirmed' && sw.recommended.stat.pAdj <= bt.RELIABILITY.maxPAdj, 'sweep: a recommendation always carries a confirmed hold-out and a corrected chance-of-luck under the limit'); break; }
  }
  ok(rec > 0, `sweep: with a strong planted edge it can still recommend (found in ${seen} tries)`);
}
{
  // Monte Carlo used Math.random: every click gave different numbers. Now the same trades always give the same result.
  const trades = Array.from({ length: 40 }, (_, i) => ({ pnl: (i % 3 === 0 ? -1 : 1.4) * (1 + (i % 5) / 10) }));
  const m1 = bt.monteCarlo(trades, 1000, 300), m2 = bt.monteCarlo(trades, 1000, 300);
  ok(JSON.stringify(m1) === JSON.stringify(m2), 'monte carlo: identical numbers on a rerun with the same trades');
  const m3 = bt.monteCarlo(trades.map((t, i) => (i === 0 ? { pnl: t.pnl + 0.5 } : t)), 1000, 300);
  ok(JSON.stringify(m1) !== JSON.stringify(m3), 'monte carlo: different trades still give different numbers (the seed follows the data)');
}
console.log(`\n${n} sweep/calendar checks passed`);
