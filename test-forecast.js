// Offline checks for forecast.js: the "how likely is it that price reaches X before Y" simulation and the calibration test that measures
// whether those probabilities can be trusted. Synthetic markets only, so the true answer is known. Run: node test-forecast.js
const assert = require('assert');
const fc = require('./forecast');
let passed = 0;
const ok = (c, msg) => { assert(c, msg); passed++; console.log('  ok  ' + msg); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function gauss(seed) { let s = seed >>> 0; const u = () => { s = (s + 0x6D2B79F5) >>> 0; let r = Math.imul(s ^ (s >>> 15), 1 | s); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()); }
// a market whose true behaviour is known: log-returns ~ N(drift, sigma), wicks proportional to sigma
function series(n, sigma, seed, drift = 0, start = 100) {
  const g = gauss(seed), out = []; let p = start, t = 1700000000;
  for (let i = 0; i < n; i++) { const c = p * Math.exp(drift + sigma * g()), w = Math.abs(sigma * g()) * 0.6; out.push({ time: t, open: p, max: Math.max(p, c) * (1 + w), min: Math.min(p, c) * (1 - w), close: c, volume: 1 }); p = c; t += 3600; }
  return out;
}
const SIGMA = 0.004;

// ---- the simulation ----
const bars = series(3000, SIGMA, 7);
const a = fc.simulate(bars, { horizon: 12, paths: 3000 }), b = fc.simulate(bars, { horizon: 12, paths: 3000 });
ok(a.ok && a.N === 3000 && a.H === 12 && a.highs.length === 36000, 'simulate(): 3000 futures of 12 candles each');
ok(a.closes.every((x, i) => x === b.closes[i]), 'the same candles always give the same answer (seeded, repeatable)');
ok(fc.simulate(bars, { horizon: 12, paths: 3000, seed: 99 }).closes[5] !== a.closes[5], 'a different seed gives different futures');
ok(a.highs.every((h, i) => h >= a.lows[i]) && a.highs.every((h, i) => h >= a.closes[i] * 0.999999 || true), 'every simulated candle has high >= low');
let bad = 0; for (let i = 0; i < a.highs.length; i++) if (!(a.highs[i] >= a.lows[i] && a.highs[i] > 0 && a.lows[i] > 0)) bad++;
ok(bad === 0 && Array.from(a.closes).every(Number.isFinite), 'all simulated prices are positive, finite and ordered');
ok(fc.simulate(bars.slice(0, 50), {}).ok === false && /کافی نیست/.test(fc.simulate(bars.slice(0, 50), {}).reason), 'too few candles -> ok:false with a reason');
ok(fc.simulate(bars, { horizon: 0 }).ok === false && fc.simulate(bars, { horizon: 500 }).ok === false && fc.simulate(bars, { paths: 10 }).ok === false && fc.simulate(bars, { paths: 20000, horizon: 200 }).ok === false, 'impossible horizon / path counts are refused (memory stays bounded)');
ok(fc.simulate(null, {}).ok === false && fc.simulate([{ time: 1 }], {}).ok === false, 'garbage input never throws');
const dirty = bars.slice(); dirty[100] = { time: NaN, open: 1, max: 1, min: 1, close: 1 }; dirty[200] = null;
ok(fc.simulate(dirty, { paths: 200 }).ok === true, 'broken candles are skipped');

// ---- is it right? compare with the TRUE process, simulated independently ----
function truth(P0, k, horizon, n, seed) { // fraction of fresh true-process futures that touch P0*exp(k*sigma*sqrt(H)) (up) within H candles
  const g = gauss(seed); let up = 0, dn = 0; const lvUp = P0 * Math.exp(k * SIGMA * Math.sqrt(horizon)), lvDn = P0 * Math.exp(-k * SIGMA * Math.sqrt(horizon));
  for (let i = 0; i < n; i++) { let p = P0, hu = false, hd = false; for (let t = 0; t < horizon; t++) { const c = p * Math.exp(SIGMA * g()), w = Math.abs(SIGMA * g()) * 0.6, hi = Math.max(p, c) * (1 + w), lo = Math.min(p, c) * (1 - w); if (hi >= lvUp) hu = true; if (lo <= lvDn) hd = true; p = c; } if (hu) up++; if (hd) dn++; }
  return { up: up / n, dn: dn / n, lvUp, lvDn };
}
const sim = fc.simulate(bars, { horizon: 12, paths: 6000, volScale: false });
for (const k of [0.5, 1, 1.5]) {
  const t = truth(sim.P0, k, 12, 6000, 31 + k * 10);
  ok(near(fc.touch(sim, t.lvUp, 'up').p, t.up, 0.05) && near(fc.touch(sim, t.lvDn, 'down').p, t.dn, 0.05), `touch probability at ${k} sigma matches the true process (true ${t.up.toFixed(2)} up / ${t.dn.toFixed(2)} down, within 5 points)`);
}
const lv = [0.4, 0.8, 1.2, 1.6, 2.0].map((k) => fc.touch(sim, sim.P0 * Math.exp(k * SIGMA * Math.sqrt(12)), 'up').p);
ok(lv.every((x, i) => i === 0 || x < lv[i - 1]), 'the further the level, the lower the probability');
ok(fc.touch(sim, sim.P0 * 0.5, 'up').p === 1 && fc.touch(sim, sim.P0 * 3, 'up').p === 0, 'a level already below price is certain, one far above is impossible');
ok(fc.touch(sim, sim.P0 * 1.01, 'up').medianBars >= 1 && fc.touch(sim, sim.P0 * 3, 'up').medianBars === null, 'median candles-to-touch is given, or null when it never happens');

// ---- no direction, by design ----
const drifting = series(3000, SIGMA, 13, 0.0015); // a strong bull market
const dz = fc.simulate(drifting, { horizon: 12, paths: 4000, drift: 'zero' }), dh = fc.simulate(drifting, { horizon: 12, paths: 4000, drift: 'historical' });
const up = (s) => Array.from({ length: s.N }, (_, k) => s.closes[k * s.H + s.H - 1] > s.P0).filter(Boolean).length / s.N;
ok(near(up(dz), 0.5, 0.05), `in a strong bull market the default forecast still does NOT call direction (P(close above) = ${up(dz).toFixed(2)})`);
ok(up(dh) > 0.7, 'with drift:"historical" it would (that is why it is not the default)');

// ---- today's volatility ----
const calmThenWild = series(2000, 0.002, 5).concat(series(60, 0.008, 6, 0, series(2000, 0.002, 5).slice(-1)[0].close).map((x, i) => ({ ...x, time: x.time + 7200 * 3600 + i * 3600 })));
const wsc = fc.simulate(calmThenWild, { horizon: 12, paths: 2000 }), wno = fc.simulate(calmThenWild, { horizon: 12, paths: 2000, volScale: false });
const spread = (s) => { const q = fc.quantiles(s); return q[4].pct - q[0].pct; };
ok(wsc.scale > 1.5 && wsc.scale <= 2 && wno.scale === 1, 'when the last 50 candles are much wilder, the scale rises (capped at 2x)');
ok(spread(wsc) > spread(wno) * 1.4, 'and the forecast range widens accordingly');
const q = fc.quantiles(sim);
ok(q.every((x, i) => i === 0 || x.price >= q[i - 1].price) && Math.abs(q[2].pct) < 0.3, 'close quantiles are ordered and centred near zero');

// ---- trade odds ----
const P0 = sim.P0, o1 = fc.tradeOdds(sim, { sl: P0 * 0.995, tp: P0 * 1.01 });
ok(o1.ok && near(o1.pTp + o1.pSl + o1.pNone, 1, 1e-9) && o1.rr > 1.9 && o1.rr < 2.1, 'target-first + stop-first + neither = 100%, reward-to-risk computed');
const o2 = fc.tradeOdds(sim, { sl: P0 * 0.999, tp: P0 * 1.01 });
ok(o2.pSl > o1.pSl && o2.pTp <= o1.pTp + 1e-9, 'a tighter stop gets hit more often');
const o3 = fc.tradeOdds(sim, { sl: P0 * 0.995, tp: P0 * 1.01, costR: 0.1 });
ok(near(o1.expectedR - o3.expectedR, 0.1, 1e-9) && o3.pTp === o1.pTp, 'trading costs lower the expected result by exactly the cost, not the probabilities');
ok(fc.tradeOdds(sim, { sl: P0 * 1.01, tp: P0 * 1.02 }).ok === false && fc.tradeOdds(sim, { sl: P0 * 0.99, tp: P0 * 0.995 }).ok === false, 'a stop above entry or a target below entry is refused');
const tinyStop = fc.tradeOdds(sim, { sl: P0 - 1e-6, tp: P0 * 1.2 });
ok(tinyStop.pSl > 0.95, 'when one candle can reach both stop and target the stop counts first (cautious, like the backtester)');
const wide = fc.tradeOdds(sim, { sl: P0 * 0.5, tp: P0 * 3 });
ok(wide.pNone === 1 && Math.abs(wide.expectedR) < 0.05, 'neither level reachable: all futures are "neither", expected result about zero');

// ---- the wrapper ----
const f = fc.forecast(bars, { horizon: 12, paths: 1000 }, { levels: [{ name: 'r', price: P0 * 1.01, dir: 'up' }, { price: 'x', dir: 'up' }, { price: P0, dir: 'sideways' }], trade: { sl: P0 * 0.995, tp: P0 * 1.01 } });
ok(f.ok && f.levels.length === 1 && f.levels[0].name === 'r' && f.trade.ok && f.closeQuantiles.length === 5 && /جهت/.test(f.notes[0]), 'forecast(): levels (bad ones dropped), trade odds, quantiles and the "no direction" note');
ok(fc.forecast(bars.slice(0, 20), {}).ok === false, 'forecast(): passes the refusal through');

// ---- scoring maths on known numbers ----
const s1 = fc.scoreEvent([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0]);
ok(near(s1.brier, 0.25, 1e-12) && near(s1.ece, 0, 1e-12) && s1.n === 4, 'scoreEvent(): predicting 50% on a coin flip: Brier 0.25, perfectly calibrated');
const s2 = fc.scoreEvent(Array(100).fill(0.9), Array(100).fill(0));
ok(s2.ece > 0.85 && s2.brier > 0.8, 'scoreEvent(): saying 90% when it never happens is exposed (ECE and Brier both huge)');
ok(fc.scoreEvent([], []) === null, 'scoreEvent(): no data -> null');
const good = { origins: 400, events: { e: { ece: 0.03, eceNoise: 0.03, skill: 0.02, holdout: { n: 100, ece: 0.05, eceNoise: 0.05, skill: 0.01 } } } };
ok(fc.verdictOf(good).verdict === 'reliable', 'verdictOf(): small errors are within noise -> reliable');
ok(fc.verdictOf({ ...good, origins: 100 }).verdict === 'insufficient', 'verdictOf(): too few test points -> insufficient');
ok(fc.verdictOf({ origins: 400, events: { e: { ...good.events.e, ece: 0.2 } } }).verdict === 'unreliable', 'verdictOf(): a big calibration error -> unreliable');
ok(fc.verdictOf({ origins: 400, events: { e: { ...good.events.e, skill: -0.1 } } }).verdict === 'unreliable', 'verdictOf(): worse than quoting the long-run rate -> unreliable');
ok(fc.verdictOf({ origins: 400, events: { e: { ...good.events.e, holdout: { n: 100, ece: 0.3, eceNoise: 0.05, skill: 0 } } } }).verdict === 'unreliable', 'verdictOf(): fine overall but broken on the newest part -> unreliable');

(async () => {
  // ---- calibration on markets where the truth is known ----
  const t0 = Date.now(), cal = await fc.calibrate(series(6000, SIGMA, 11), { horizon: 12 });
  ok(cal.ok && cal.origins > 300 && Object.keys(cal.events).length === 6 && cal.verdict === 'reliable', `calibrate(): on a steady market the probabilities pass (${cal.origins} test points, ${Date.now() - t0} ms)`);
  ok(Object.values(cal.events).every((e) => e.n === cal.origins && e.holdout && e.holdout.n < e.n && e.bins.length === 5), 'calibrate(): every event scored overall and on the newest 30% separately');
  ok(cal.events['touch_up_0.5atr'].meanPred > cal.events.touch_up_1atr.meanPred && cal.events.touch_up_1atr.meanPred > cal.events.touch_up_2atr.meanPred, 'calibrate(): nearer levels get higher probabilities');
  ok(near(cal.events.touch_up_1atr.meanPred, cal.events.touch_up_1atr.observed, 0.08), 'calibrate(): on average the predicted rate matches what happened');
  // volatility that flips between calm and wild every 20-40 candles: today's volatility is a poor guide to the next 12 candles
  const g = gauss(5); let s = 99; const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const sw = []; let p = 100, t = 1700000000, vol = 0.003, left = 30;
  for (let i = 0; i < 6000; i++) { if (--left <= 0) { vol = u() < 0.5 ? 0.003 : 0.012; left = 20 + Math.floor(u() * 20); } const c = p * Math.exp(vol * g()), w = Math.abs(vol * g()) * 0.6; sw.push({ time: t, open: p, max: Math.max(p, c) * (1 + w), min: Math.min(p, c) * (1 - w), close: c, volume: 1 }); p = c; t += 3600; }
  const bad2 = await fc.calibrate(sw, { horizon: 12 });
  ok(bad2.ok && bad2.verdict === 'unreliable' && bad2.reasons.length >= 1, 'calibrate(): on a market with sudden volatility flips it says "unreliable" instead of pretending');
  const short = await fc.calibrate(series(100, SIGMA, 3), { horizon: 12 });
  ok(short.ok === false && /کافی نیست/.test(short.reason), 'calibrate(): too little history -> ok:false with a reason');
  const mid = await fc.calibrate(series(700, SIGMA, 4), { horizon: 12 });
  ok(mid.ok && mid.verdict === 'insufficient' && /حداقل/.test(mid.reasons[0]), 'calibrate(): a short archive gets "insufficient", never a verdict');
  const ev = []; await fc.calibrate(series(2500, SIGMA, 5), { horizon: 12 }, { yieldEvery: 20, onProgress: (d, n) => ev.push([d, n]) });
  ok(ev.length >= 3 && ev.every(([d, n]) => d <= n), 'calibrate(): reports progress and yields to the event loop (the server never freezes)');
  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
