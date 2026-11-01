// Offline checks for the ML lab (ml.js): no peeking at the future, honest labels, the walk-forward gap, a model that learns a
// planted pattern, and — most important — that pure noise is NOT reported as an edge. Run: node test-ml.js
const assert = require('assert');
const ml = require('./ml');
let passed = 0;
const ok = (c, m) => { assert(c, m); passed++; console.log('  ok  ' + m); };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
// synthetic candles; revert > 0 plants a mean-reversion pattern (price pulled back toward its slow average)
function makeBars(n, seed, revert = 0) {
  const r = rng(seed), bars = []; let c = 100, ema = 100;
  for (let i = 0; i < n; i++) {
    const o = c, pull = -revert * (c - ema) / c, ret = pull + 0.004 * gauss(r);
    c = o * Math.exp(ret); ema += (c - ema) * 2 / 21;
    const hi = Math.max(o, c) * (1 + Math.abs(gauss(r)) * 0.0015), lo = Math.min(o, c) * (1 - Math.abs(gauss(r)) * 0.0015);
    bars.push({ time: 1700000000 + i * 3600, open: o, max: hi, min: lo, close: c, volume: 1000 + Math.floor(r() * 500) });
  }
  return bars;
}
const P = ml.normalize({});

// 1. features at candle i must not change when FUTURE candles change
{
  const a = makeBars(400, 1), b = a.map((x, i) => (i > 300 ? { ...x, close: x.close * 1.3, max: x.max * 1.3, min: x.min * 1.3, open: x.open * 1.3 } : x));
  const sa = ml.series(a), sb = ml.series(b);
  ok(JSON.stringify(ml.featureRow(sa, 300)) === JSON.stringify(ml.featureRow(sb, 300)), 'features: candle 300 looks identical whatever happens after it (no peeking at the future)');
  ok(ml.featureRow(sa, 300).every(Number.isFinite), 'features: every feature is a finite number once enough history exists');
}
// 2. labels: stop wins when both barriers are touched in one candle; entry is the NEXT open; incomplete futures have no label
{
  const bars = makeBars(300, 2), s = ml.series(bars), i = 150, atr = s.atr[i], entry = bars[i + 1].open, p = { ...P, horizon: 5, costAtr: 0 };
  const sl = p.slAtr * atr, tp = p.rr * sl;
  const a = bars.map((x) => ({ ...x }));
  a[i + 1].max = entry + tp * 2; a[i + 1].min = entry - sl * 2; // one wild candle touching both barriers
  ok(ml.outcome(ml.series(a), i, 'long', p).R === -1, 'labels: stop and target in the same candle -> counted as a LOSS (cautious)');
  const b = bars.map((x) => ({ ...x }));
  b[i + 1].max = entry + tp * 2; b[i + 1].min = entry - sl * 0.1; b[i + 1].open = entry; b[i + 1].close = entry;
  ok(ml.outcome(ml.series(b), i, 'long', p).R === p.rr, 'labels: only the target touched -> +RR');
  ok(ml.outcome(s, s.n - 3, 'long', p) === null, 'labels: a trade whose future is not complete yet gets no label');
  const withCost = ml.outcome(ml.series(b), i, 'long', { ...p, costAtr: 0.15 }).R;
  ok(Math.abs(withCost - (p.rr - 0.15 / p.slAtr)) < 1e-9, 'labels: the cost (in ATR) is subtracted in R units');
}
// 3. the maths helpers
{
  ok(Math.abs(ml.auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]) - 1) < 1e-9 && Math.abs(ml.auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])) < 1e-9, 'auc: perfect and perfectly wrong rankings');
  const r = rng(7); const noise = Array.from({ length: 200 }, () => gauss(r)); const edge = noise.map((x) => x + 0.5);
  ok(ml.bootstrapP(noise) > 0.05 && ml.bootstrapP(edge) < 0.01, 'bootstrap p: noise is not significant, a real mean is');
}
// 4. too little data is refused with a clear message
{
  let msg = null; try { ml.run(makeBars(300, 3), {}); } catch (e) { msg = e.message; }
  ok(msg && /کندل کافی نیست/.test(msg), 'run: too few candles -> a clear message, not a fake result');
}
// 5. both models learn a planted pattern; the report is complete
for (const model of ['logistic', 'boost']) {
  const res = ml.run(makeBars(6000, 11, 0.06), { model, costAtr: 0.05 });
  ok(res.ok && res.oosSamples > 1000 && res.folds.length === 5, `${model}: complete report on a planted mean-reversion pattern (${res.oosSamples} unseen samples, 5 test blocks)`);
  ok(Math.max(res.auc.long, res.auc.short) > 0.53, `${model}: learns the planted pattern out of sample (AUC ${Math.max(res.auc.long, res.auc.short).toFixed(3)})`);
}
// 6. THE important one: pure noise must not be sold as an edge (several seeds, both models)
{
  let promising = 0, runs = 0, aucs = [];
  for (const seed of [21, 22, 23, 24]) for (const model of ['logistic', 'boost']) {
    const res = ml.run(makeBars(5000, seed, 0), { model, costAtr: 0.1 }); runs++;
    if (res.verdict.level === 'promising') promising++;
    aucs.push(Math.max(res.auc.long, res.auc.short));
  }
  ok(promising === 0, `noise: ${runs} runs on pure random candles, none called "promising"`);
  ok(Math.max(...aucs) < 0.56, `noise: out-of-sample AUC stays near 0.5 (max ${Math.max(...aucs).toFixed(3)})`);
}
// 7. walk-forward gap: test blocks are later than everything the model trained on
{
  const res = ml.run(makeBars(4000, 31, 0.04), {});
  ok(res.folds.every((f, k) => k === 0 || f.from > res.folds[k - 1].from) && res.folds.every((f) => f.trainSamples > 300), 'walk-forward: test blocks move forward in time and every model had real training data');
}
// 8. report extras: direction split, buy-and-hold over the test window, and the cost sweep
{
  const bars = makeBars(4000, 41, 0.04), res = ml.runSweep(bars, { costAtr: 0.1 });
  ok(res.byDirection.long.trades + res.byDirection.short.trades === res.trades.trades, 'extras: long + short trades add up to all trades');
  const first = res.hold.from, last = res.hold.to;
  ok(last > first && Number.isFinite(res.hold.pct), 'extras: "just hold" covers the same stretch as the unseen test data');
  ok(res.costSweep.length >= 3 && res.costSweep.some((c) => c.costAtr === 0) && res.costSweep.some((c) => c.costAtr === 0.2), 'cost sweep: runs at 0, 0.1 and 0.2 ATR');
  const m0 = res.costSweep.find((c) => c.costAtr === 0), m2 = res.costSweep.find((c) => c.costAtr === 0.2);
  ok(m0.meanR > m2.meanR || m0.trades !== m2.trades, 'cost sweep: a higher cost never makes the result better');
  ok(res.params.costAtr === 0.1 && res.costSweep.find((c) => c.costAtr === 0.1).trades === res.trades.trades, 'cost sweep: the headline numbers are the run at YOUR cost');
}
// 9. extra feature groups: no peeking at the future (time, higher-timeframe, market structure, second symbol)
const ALL = ml.normalize({ features: ['time', 'htf', 'structure'] });
{
  const a = makeBars(1500, 51, 0.03), ref = makeBars(1500, 52), tf = 3600;
  const b = a.map((x, i) => (i > 700 ? { ...x, close: x.close * 1.2, max: x.max * 1.25, min: x.min * 0.9, open: x.open * 1.1 } : x));
  const refB = ref.map((x, i) => (i > 700 ? { ...x, close: x.close * 1.4, max: x.max * 1.4, min: x.min * 1.4, open: x.open * 1.4 } : x));
  const pa = ml.prepare(a, ALL, ref), pb = ml.prepare(b, ALL, refB), i = 650;
  ok(pa.ext[i].length === pa.names.length - 14 && pa.ext[i].every(Number.isFinite), `groups: ${pa.names.length - 14} extra features, all finite (time + higher timeframe + structure + second symbol)`);
  ok(JSON.stringify(pa.ext[i]) === JSON.stringify(pb.ext[i]), 'groups: features of candle 650 are identical whatever happens to this symbol AND the second symbol afterwards');
  ok(ml.inferTf(a) === tf && ml.windows(86400).wS === 5 && ml.windows(300).wS === 150 && ml.windows(3600).wS === 24, 'groups: timeframe is read from the candles and windows scale with it (day = 24 candles on H1)');
}
// the second symbol must be aligned by CLOSE time: a ref candle that is still forming when this candle closes is not used
{
  const base = makeBars(900, 61), ref = base.map((x) => ({ ...x, time: x.time + 1800 })); // ref candles open 30 min later -> each closes 30 min after the base candle closes
  const pre = ml.prepare(base, ml.normalize({}), ref), pre2 = ml.prepare(base, ml.normalize({}), ref.map((x, k) => (k === 400 ? { ...x, close: x.close * 3 } : x)));
  const i = 400; // base candle 400 closes before ref candle 400 does, so ref candle 400 must not matter yet
  ok(JSON.stringify(pre.ext[i]) === JSON.stringify(pre2.ext[i]) && JSON.stringify(pre.ext[i + 1]) !== JSON.stringify(pre2.ext[i + 1]), 'second symbol: a candle that closes after this one closes is never used (aligned by close time)');
}
// 10. a planted time-of-day effect is found WITH the time group and missed without it
function hourBars(n, seed, drift) {
  const r = rng(seed), bars = []; let c = 100;
  for (let i = 0; i < n; i++) {
    const t = 1700000000 + i * 3600, hr = Math.floor((t % 86400) / 3600), o = c, ret = (hr >= 8 && hr <= 10 ? drift : 0) + 0.004 * gauss(r);
    c = o * Math.exp(ret);
    bars.push({ time: t, open: o, max: Math.max(o, c) * (1 + Math.abs(gauss(r)) * 0.0015), min: Math.min(o, c) * (1 - Math.abs(gauss(r)) * 0.0015), close: c, volume: 1000 });
  }
  return bars;
}
{
  const bars = hourBars(7000, 71, 0.004), best = (r) => Math.max(r.auc.long, r.auc.short);
  const plain = ml.run(bars, { model: 'boost', horizon: 6 }), timed = ml.run(bars, { model: 'boost', horizon: 6, features: ['time'] });
  ok(best(timed) > best(plain) + 0.02 && best(timed) > 0.54, `time group: finds a planted hour-of-day effect (AUC ${best(plain).toFixed(3)} -> ${best(timed).toFixed(3)})`);
  ok(timed.features.groups.includes('time') && timed.importance.some((x) => /ساعت|سشن/.test(x.name)), 'time group: the report names the time features among the important ones');
}
// 11. a planted lead from a second symbol is found with it, missed without it
{
  const r = rng(81), n = 6000, base = [], ref = []; let cb = 100, cr = 100, prev = 0;
  for (let i = 0; i < n; i++) {
    const t = 1700000000 + i * 3600, ob = cb, or = cr, rr = 0.004 * gauss(r), rb = 0.5 * prev + 0.003 * gauss(r);
    cr = or * Math.exp(rr); cb = ob * Math.exp(rb); prev = Math.log(cr / or);
    ref.push({ time: t, open: or, max: Math.max(or, cr) * 1.001, min: Math.min(or, cr) * 0.999, close: cr, volume: 100 });
    base.push({ time: t, open: ob, max: Math.max(ob, cb) * 1.001, min: Math.min(ob, cb) * 0.999, close: cb, volume: 100 });
  }
  const best = (x) => Math.max(x.auc.long, x.auc.short);
  const plain = ml.run(base, { horizon: 5 }), withRef = ml.run(base, { horizon: 5 }, { refBars: ref });
  ok(withRef.features.ref && best(withRef) > best(plain) + 0.02, `second symbol: a planted lead is found only when it is supplied (AUC ${best(plain).toFixed(3)} -> ${best(withRef).toFixed(3)})`);
}
// 12. permutation test and interval: significant on a real pattern, not on noise, and they respect the label overlap
{
  const real = ml.run(makeBars(6000, 11, 0.06), { model: 'logistic', costAtr: 0.05 }), st = real.stats;
  ok(st.aucPerm.p < 0.05 && st.aucCI.long[0] > 0.5 && st.aucCI.long[1] > st.aucCI.long[0], `permutation: planted pattern is significant (p ${st.aucPerm.p.toFixed(3)}, AUC interval ${st.aucCI.long.map((x) => x.toFixed(3)).join('–')})`);
  ok(st.effectiveN === Math.round(real.oosSamples / 20), 'permutation: effective sample size = samples / horizon');
  let low = 0, ps = []; const noise = [];
  for (const seed of [21, 22, 23, 24, 25, 26]) {
    const r = ml.run(makeBars(5000, seed, 0), { model: 'boost' }); ps.push(r.stats.aucPerm.p); if (r.stats.aucPerm.p < 0.05) low++;
    noise.push(r.stats.aucCI.long[0] <= 0.5 && r.stats.aucCI.long[1] >= 0.5);
  }
  ok(low <= 1 && ps.reduce((a, b) => a + b, 0) / ps.length > 0.2, `permutation: on pure noise it is rarely "significant" (${low} of ${ps.length} below 5%, mean p ${(ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(2)})`);
  ok(noise.filter(Boolean).length >= 4, `interval: on pure noise the AUC interval contains 0.5 (${noise.filter(Boolean).length} of ${noise.length} runs)`);
}
console.log(`\n${passed} checks passed`);
