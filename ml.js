// The ML lab: "can a small model learn something from candles that survives an honest test?"  Pure JavaScript (no Python).
//
// What it does, in the order the data flows:
//   1. features — a dozen numbers per candle (returns, RSI, distance from EMAs, volatility, candle shape, position in the
//      recent range ...), every one computed ONLY from that candle and the ones before it;
//   2. labels  — "if I had entered at the NEXT candle's open with a stop and a target measured in ATR, would the trade have
//      ended positive after costs?" (stop wins if both are touched in one candle; a trade that times out is closed at the close);
//   3. models  — logistic regression (very hard to overfit) or gradient-boosted shallow trees;
//   4. WALK-FORWARD test — the model is trained on the past only, predicts the NEXT block it has never seen, then the window
//      grows and it repeats. A gap of `horizon` candles separates training from test, because a label looks that far ahead.
//      The decision threshold is set from the training part alone (never tuned on the test part);
//   5. a one-position-at-a-time simulation of those out-of-sample predictions, costs included, compared with "enter at random"
//      and judged with a bootstrap p-value, the number of trades and how many test blocks were profitable.
// Optional extra feature groups (all computed with the same "only what was known at that candle" rule):
//   time      hour of day, day of week and the Asia / London / New York sessions (UTC clock of the archive)
//   htf       higher-timeframe context: trend over about 4 hours and about a day, volatility rank, distance to the recent short / long
//             range highs and lows (windows are counted in candles, scaled from the archive's own timeframe)
//   structure the numbers of market-structure.js: trend, last break (BOS / CHoCH), distance and strength of the nearest support /
//             resistance zone, break-and-pullback setups
//   ref       a second archive (another symbol, e.g. DXY for gold, BTC for an altcoin): its latest CLOSED candle at each moment
// and two extra checks on the result: a permutation test that keeps the overlap of the labels (shifted labels / shifted signals) and
// a block-bootstrap interval for the AUC — "is that 0.53 more than luck, given that neighbouring labels are almost the same label?".
// It never trades by itself and never touches the bot: it only produces a report. Most runs should end in "no edge" — that is
// the honest outcome for most candle data, and the verdict says so plainly.
'use strict';

class MLError extends Error { constructor(msg) { super(msg); this.name = 'MLError'; } }

const FEATURES = [
  ['r1', 'تغییر ۱ کندل'], ['r3', 'تغییر ۳ کندل'], ['r5', 'تغییر ۵ کندل'], ['r10', 'تغییر ۱۰ کندل'], ['r20', 'تغییر ۲۰ کندل'],
  ['rsi', 'RSI'], ['dEma20', 'فاصله از EMA20'], ['dEma50', 'فاصله از EMA50'], ['volRegime', 'نوسان نسبت به معمول'],
  ['rangePos', 'جای قیمت در بازه‌ی ۲۰ کندل'], ['body', 'بدنه‌ی کندل'], ['upWick', 'سایه‌ی بالا'], ['dnWick', 'سایه‌ی پایین'], ['volRatio', 'حجم نسبت به معمول'],
];
const WARM = 110; // candles needed before the first sample (the slowest feature looks back ~100)

// ---------------------------------------------------------------------------------------------------------------------------
// 1. features
function series(bars) {
  const n = bars.length, c = new Float64Array(n), o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), v = new Float64Array(n);
  bars.forEach((b, i) => { c[i] = b.close; o[i] = b.open; h[i] = b.max; l[i] = b.min; v[i] = b.volume || 0; });
  const atr = new Float64Array(n), rsi = new Float64Array(n), e20 = new Float64Array(n), e50 = new Float64Array(n);
  let a = 0, ag = 0, al = 0;
  e20[0] = e50[0] = c[0];
  for (let i = 1; i < n; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    a = i <= 14 ? a + tr / 14 : (a * 13 + tr) / 14; atr[i] = i >= 14 ? a : NaN;
    const d = c[i] - c[i - 1], g = Math.max(d, 0), ls = Math.max(-d, 0);
    if (i <= 14) { ag += g / 14; al += ls / 14; } else { ag = (ag * 13 + g) / 14; al = (al * 13 + ls) / 14; }
    rsi[i] = i >= 14 ? (al === 0 ? 100 : 100 - 100 / (1 + ag / al)) : NaN;
    e20[i] = e20[i - 1] + (c[i] - e20[i - 1]) * 2 / 21; e50[i] = e50[i - 1] + (c[i] - e50[i - 1]) * 2 / 51;
  }
  return { n, c, o, h, l, v, atr, rsi, e20, e50 };
}

// The feature row of candle i. Uses candles 0..i only (this is what the "no peeking at the future" test checks).
function featureRow(s, i) {
  const { c, o, h, l, v, atr, rsi, e20, e50 } = s, A = atr[i];
  const ret = (k) => Math.log(c[i] / c[i - k]) / (A / c[i]);
  let hi = -Infinity, lo = Infinity, vs = 0, as = 0;
  for (let k = i - 19; k <= i; k++) { if (h[k] > hi) hi = h[k]; if (l[k] < lo) lo = l[k]; vs += v[k]; }
  for (let k = i - 99; k <= i; k++) as += atr[k];
  const vAvg = vs / 20;
  return [
    ret(1), ret(3), ret(5), ret(10), ret(20), rsi[i] / 100, (c[i] - e20[i]) / A, (c[i] - e50[i]) / A, A / (as / 100),
    hi > lo ? (c[i] - lo) / (hi - lo) : 0.5, (c[i] - o[i]) / A, (h[i] - Math.max(o[i], c[i])) / A, (Math.min(o[i], c[i]) - l[i]) / A,
    vAvg > 0 ? v[i] / vAvg : 1,
  ];
}

// ---------------------------------------------------------------------------------------------------------------------------
// 1b. optional feature groups
const GROUPS = ['time', 'htf', 'structure'];
const NAMES = {
  time: [['hSin', 'ساعت روز (سینوس)'], ['hCos', 'ساعت روز (کسینوس)'], ['dSin', 'روز هفته (سینوس)'], ['dCos', 'روز هفته (کسینوس)'], ['sAsia', 'سشن آسیا'], ['sLondon', 'سشن لندن'], ['sNY', 'سشن نیویورک']],
  htf: [['htfT1', 'روند کوتاه‌مدت (≈۴ ساعت)'], ['htfT2', 'روند میان‌مدت (≈یک روز)'], ['atrRank', 'رتبه‌ی نوسان در ۲۵۰ کندل'], ['dHiS', 'فاصله تا سقف بازه‌ی کوتاه'], ['dLoS', 'فاصله تا کف بازه‌ی کوتاه'], ['dHiL', 'فاصله تا سقف بازه‌ی بلند'], ['dLoL', 'فاصله تا کف بازه‌ی بلند']],
  structure: [['msTrend', 'ساختار: روند'], ['msBreak', 'ساختار: شکست اخیر'], ['msChoch', 'ساختار: تغییر ماهیت (CHoCH)'], ['msSup', 'فاصله تا حمایت'], ['msRes', 'فاصله تا مقاومت'], ['msSupStr', 'قدرت حمایت'], ['msResStr', 'قدرت مقاومت'], ['msInside', 'داخل ناحیه'], ['msSetupL', 'ستاپ پولبک خرید'], ['msSetupS', 'ستاپ پولبک فروش'], ['msDHi', 'فاصله تا آخرین سقف'], ['msDLo', 'فاصله تا آخرین کف']],
  ref: [['refR1', 'نماد وابسته: تغییر ۱'], ['refR5', 'نماد وابسته: تغییر ۵'], ['refR20', 'نماد وابسته: تغییر ۲۰'], ['refDEma', 'نماد وابسته: فاصله از EMA50']],
};
const clampN = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function inferTf(bars) {
  const d = [];
  for (let i = 1; i < Math.min(bars.length, 3000); i++) { const x = bars[i].time - bars[i - 1].time; if (x > 0) d.push(x); }
  d.sort((a, b) => a - b);
  return d.length ? d[d.length >> 1] : 3600;
}
// windows are counted in candles, scaled from the archive's timeframe (about 4 hours / a day / a week; never absurdly small or large)
function windows(tfSec) {
  const m1 = clampN(Math.round(14400 / tfSec), 3, 60), wS = clampN(Math.round(86400 / tfSec), 5, 150), wL = clampN(wS * 5, 25, 700);
  return { m1, m2: wS, wS, wL };
}
const warmFor = (groups, w) => Math.max(WARM, groups.includes('htf') ? Math.max(262, w.wL + 2) : 0, groups.includes('structure') ? 305 : 0);

// Everything that is computed once per candle set and does not depend on the cost: the base series and the extra feature columns.
function prepare(bars, p, refBars) {
  const s = series(bars), tfSec = inferTf(bars), w = windows(tfSec), groups = p.features, hasRef = !!(refBars && refBars.length > 200);
  const warm = warmFor(groups, w), names = FEATURES.map(([id, nm]) => [id, nm]);
  const daily = tfSec >= 86400;
  const timeNames = daily ? NAMES.time.filter(([id]) => id === 'dSin' || id === 'dCos') : NAMES.time;
  for (const g of GROUPS) if (groups.includes(g)) names.push(...(g === 'time' ? timeNames : NAMES[g]));
  if (hasRef) names.push(...NAMES.ref);
  const ms = groups.includes('structure') ? require('./market-structure') : null;
  let ref = null;
  if (hasRef) ref = { bars: refBars, s: series(refBars), tf: inferTf(refBars), j: -1 };
  const last = s.n - 1 - p.horizon, ext = new Array(s.n).fill(null);
  for (let i = warm; i <= last; i++) {
    const row = [], A = s.atr[i];
    if (groups.includes('time')) {
      const t = bars[i].time + tfSec, d = new Date(t * 1000), day = d.getUTCDay(), hr = (t % 86400) / 3600;
      if (!daily) row.push(Math.sin(2 * Math.PI * hr / 24), Math.cos(2 * Math.PI * hr / 24));
      row.push(Math.sin(2 * Math.PI * day / 7), Math.cos(2 * Math.PI * day / 7));
      if (!daily) row.push(hr < 8 ? 1 : 0, hr >= 7 && hr < 16 ? 1 : 0, hr >= 12 && hr < 21 ? 1 : 0);
    }
    if (groups.includes('htf')) {
      const { c, h, l, atr } = s, tr = (m) => Math.log(c[i] / c[i - m]) / (A / c[i]) / Math.sqrt(m);
      let rank = 0; for (let k = i - 249; k <= i; k++) if (atr[k] <= A) rank++;
      const hl = (win) => { let hi = -Infinity, lo = Infinity; for (let k = i - win; k < i; k++) { if (h[k] > hi) hi = h[k]; if (l[k] < lo) lo = l[k]; } return [hi, lo]; };
      const [hS, lS] = hl(w.wS), [hL, lL] = hl(w.wL);
      row.push(tr(w.m1), tr(w.m2), rank / 250, clampN((c[i] - hS) / A, -15, 15), clampN((c[i] - lS) / A, -15, 15), clampN((c[i] - hL) / A, -15, 15), clampN((c[i] - lL) / A, -15, 15));
    }
    if (ms) {
      const a = ms.analyze(bars.slice(Math.max(0, i - 299), i + 1)), st = a.ok ? a.structure : null, A2 = a.ok ? a.atr : A;
      if (!a.ok) row.push(0, 0, 0, 8, 8, 0, 0, 0, 0, 0, 0, 0);
      else {
        const brk = st.break, sup = a.nearest.support, res = a.nearest.resistance, score = { broke: 0.25, pullback: 0.5, confirmed: 1 };
        const setup = (dir) => { const q = a.setups.find((x) => x.dir === dir); return q ? score[q.state] || 0 : 0; };
        const sign = brk ? (brk.type.endsWith('_up') ? 1 : -1) : 0;
        row.push(st.trend === 'up' ? 1 : st.trend === 'down' ? -1 : 0, brk ? sign * (1 - Math.min(brk.barsAgo, 40) / 40) : 0, brk && brk.type.startsWith('choch') ? sign : 0,
          sup ? Math.min(8, sup.distAtr) : 8, res ? Math.min(8, res.distAtr) : 8, sup ? sup.strength / 100 : 0, res ? res.strength / 100 : 0, a.nearest.inside ? 1 : 0,
          setup('up'), setup('down'), st.lastHigh ? clampN((a.price - st.lastHigh.price) / A2, -10, 10) : 0, st.lastLow ? clampN((a.price - st.lastLow.price) / A2, -10, 10) : 0);
      }
    }
    if (ref) { // latest ref candle that was already CLOSED when this candle closed
      const now = bars[i].time + tfSec;
      while (ref.j + 1 < ref.bars.length && ref.bars[ref.j + 1].time + ref.tf <= now) ref.j++;
      const j = ref.j, r = ref.s, rr = (k) => (j - k >= 0 && Number.isFinite(r.atr[j]) ? Math.log(r.c[j] / r.c[j - k]) / (r.atr[j] / r.c[j]) : NaN);
      if (j < 60 || !Number.isFinite(r.atr[j])) row.push(NaN, NaN, NaN, NaN);
      else row.push(rr(1), rr(5), rr(20), (r.c[j] - r.e50[j]) / r.atr[j]);
    }
    ext[i] = row;
  }
  return { s, ext, names, warm, tfSec, hasRef, groups };
}

// ---------------------------------------------------------------------------------------------------------------------------
// 2. labels (triple barrier, entry at the next open)
function outcome(s, i, dir, p) {
  const { o, h, l, c, atr, n } = s, end = i + p.horizon;
  if (end > n - 1) return null; // the future is not complete yet: no label
  const entry = o[i + 1], sl = p.slAtr * atr[i], tp = p.rr * sl, long = dir === 'long';
  const stop = long ? entry - sl : entry + sl, target = long ? entry + tp : entry - tp;
  let R = null, exit = end;
  for (let j = i + 1; j <= end; j++) {
    const hitStop = long ? l[j] <= stop : h[j] >= stop, hitTp = long ? h[j] >= target : l[j] <= target;
    if (hitStop) { R = -1; exit = j; break; } // both in one candle -> assume the stop (the cautious choice)
    if (hitTp) { R = p.rr; exit = j; break; }
  }
  if (R === null) { const mv = long ? c[end] - entry : entry - c[end]; R = Math.max(-1, Math.min(p.rr, mv / sl)); }
  // net of the cost, measured in "R" (1 R = the stop distance). p.costPct (round-trip cost as a fraction of price, per symbol) wins over the fixed ATR cost.
  const costR = p.costPct != null ? p.costPct * entry / sl : p.costAtr / p.slAtr;
  return { R: R - costR, exit, c: costR * p.slAtr }; // c = the cost in ATR units (only for the report)
}

// ---------------------------------------------------------------------------------------------------------------------------
// 3. models
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function trainLogistic(X, y) {
  const n = X.length, d = X[0].length, mean = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const r of X) for (let k = 0; k < d; k++) mean[k] += r[k] / n;
  for (const r of X) for (let k = 0; k < d; k++) sd[k] += (r[k] - mean[k]) ** 2 / n;
  for (let k = 0; k < d; k++) sd[k] = Math.sqrt(sd[k]) || 1;
  const Z = X.map((r) => r.map((x, k) => Math.max(-4, Math.min(4, (x - mean[k]) / sd[k]))));
  const w = new Array(d).fill(0), m = new Array(d + 1).fill(0), vv = new Array(d + 1).fill(0);
  let b = 0;
  const base = y.reduce((x, t) => x + t, 0) / n; b = Math.log((base + 1e-6) / (1 - base + 1e-6));
  const lam = 0.02, lr = 0.05;
  for (let it = 1; it <= 250; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let s = 0; s < n; s++) {
      let z = b; const r = Z[s];
      for (let k = 0; k < d; k++) z += w[k] * r[k];
      const e = sigmoid(z) - y[s]; gb += e / n;
      for (let k = 0; k < d; k++) gw[k] += e * r[k] / n;
    }
    for (let k = 0; k <= d; k++) { // Adam
      const g = k < d ? gw[k] + lam * w[k] : gb;
      m[k] = 0.9 * m[k] + 0.1 * g; vv[k] = 0.999 * vv[k] + 0.001 * g * g;
      const step = lr * (m[k] / (1 - 0.9 ** it)) / (Math.sqrt(vv[k] / (1 - 0.999 ** it)) + 1e-8);
      if (k < d) w[k] -= step; else b -= step;
    }
  }
  return {
    predict: (x) => { let z = b; for (let k = 0; k < d; k++) z += w[k] * Math.max(-4, Math.min(4, (x[k] - mean[k]) / sd[k])); return sigmoid(z); },
    importance: () => w.map((q) => Math.abs(q)),
  };
}

function trainBoost(X, y, { trees = 60, lr = 0.08, minLeaf = 80, bins = 16 } = {}) {
  const n = X.length, d = X[0].length;
  const thr = [], bin = [];
  for (let k = 0; k < d; k++) { // candidate cut points = quantiles of the training values
    const col = X.map((r) => r[k]).sort((p, q) => p - q), cuts = [];
    for (let q = 1; q < bins; q++) { const t = col[Math.floor(q * n / bins)]; if (!cuts.length || t > cuts[cuts.length - 1]) cuts.push(t); }
    thr.push(cuts);
    const bk = new Uint8Array(n);
    for (let s = 0; s < n; s++) { let b = 0; while (b < cuts.length && X[s][k] > cuts[b]) b++; bk[s] = b; }
    bin.push(bk);
  }
  const base = y.reduce((x, t) => x + t, 0) / n, F0 = Math.log((base + 1e-6) / (1 - base + 1e-6));
  const F = new Float64Array(n).fill(F0), forest = [], gain = new Array(d).fill(0), LAM = 5;
  const bestSplit = (idx, g, h) => {
    let G = 0, Hh = 0; for (const s of idx) { G += g[s]; Hh += h[s]; }
    let best = null;
    for (let k = 0; k < d; k++) {
      const nb = thr[k].length + 1, gs = new Float64Array(nb), hs = new Float64Array(nb), cs = new Uint32Array(nb);
      for (const s of idx) { const b = bin[k][s]; gs[b] += g[s]; hs[b] += h[s]; cs[b]++; }
      let gl = 0, hl = 0, cl = 0;
      for (let b = 0; b < nb - 1; b++) {
        gl += gs[b]; hl += hs[b]; cl += cs[b];
        if (cl < minLeaf || idx.length - cl < minLeaf) continue;
        const gr = G - gl, hr = Hh - hl, gn = gl * gl / (hl + LAM) + gr * gr / (hr + LAM) - G * G / (Hh + LAM);
        if (!best || gn > best.gain) best = { k, cut: thr[k][b], bi: b, gain: gn };
      }
    }
    return best;
  };
  for (let t = 0; t < trees; t++) {
    const g = new Float64Array(n), h = new Float64Array(n);
    for (let s = 0; s < n; s++) { const p = sigmoid(F[s]); g[s] = y[s] - p; h[s] = Math.max(p * (1 - p), 1e-6); }
    const all = Array.from({ length: n }, (_, s) => s);
    const leaf = (idx) => { let G = 0, Hh = 0; for (const s of idx) { G += g[s]; Hh += h[s]; } return G / (Hh + LAM); };
    const root = bestSplit(all, g, h);
    if (!root) break;
    gain[root.k] += root.gain;
    const node = { k: root.k, cut: root.cut };
    const sides = [[], []];
    for (const s of all) sides[bin[root.k][s] <= root.bi ? 0 : 1].push(s);
    [node.l, node.r] = sides.map((idx) => {
      const sp = idx.length >= 2 * minLeaf ? bestSplit(idx, g, h) : null;
      if (!sp) return { v: leaf(idx) };
      gain[sp.k] += sp.gain;
      const a = [], b = [];
      for (const s of idx) (bin[sp.k][s] <= sp.bi ? a : b).push(s);
      return { k: sp.k, cut: sp.cut, l: { v: leaf(a) }, r: { v: leaf(b) } };
    });
    const walk = (nd, x) => { while (nd.v === undefined) nd = x[nd.k] <= nd.cut ? nd.l : nd.r; return nd.v; };
    for (let s = 0; s < n; s++) F[s] += lr * walk(node, X[s]);
    forest.push(node);
  }
  const walk = (nd, x) => { while (nd.v === undefined) nd = x[nd.k] <= nd.cut ? nd.l : nd.r; return nd.v; };
  return {
    predict: (x) => { let z = F0; for (const t of forest) z += lr * walk(t, x); return sigmoid(z); },
    importance: () => gain,
  };
}
const MODELS = { logistic: trainLogistic, boost: trainBoost };

// ---------------------------------------------------------------------------------------------------------------------------
// 4/5. statistics
function auc(p, y) {
  const idx = p.map((_, i) => i).sort((a, b) => p[a] - p[b]);
  let rank = 1, sumPos = 0, pos = 0;
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && p[idx[j + 1]] === p[idx[i]]) j++;
    const avg = (rank + rank + (j - i)) / 2;
    for (let k = i; k <= j; k++) if (y[idx[k]] === 1) { sumPos += avg; pos++; }
    rank += j - i + 1; i = j + 1;
  }
  const neg = idx.length - pos;
  return pos && neg ? (sumPos - pos * (pos + 1) / 2) / (pos * neg) : null;
}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bootstrapP(rs) { // one-sided: how often would a strategy with ZERO true edge look this good by luck?
  const n = rs.length; if (n < 5) return null;
  const mean = rs.reduce((a, b) => a + b, 0) / n, c = rs.map((x) => x - mean), rand = rng(12345);
  let hit = 0; const B = 3000;
  for (let b = 0; b < B; b++) { let s = 0; for (let k = 0; k < n; k++) s += c[Math.floor(rand() * n)]; if (s / n >= mean) hit++; }
  return (hit + 1) / (B + 1);
}
function tradeStats(trades) {
  const n = trades.length, rs = trades.map((t) => t.R), sum = rs.reduce((a, b) => a + b, 0);
  let peak = 0, cum = 0, dd = 0;
  for (const r of rs) { cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return { trades: n, meanR: n ? sum / n : 0, totalR: sum, winRate: n ? rs.filter((r) => r > 0).length / n : 0, maxDrawdownR: dd };
}

// Permutation + bootstrap checks that respect the overlap of the labels (a label looks `horizon` candles ahead, so neighbouring labels
// are nearly the same label and N samples carry only about N / horizon candles' worth of independent information).
function ranksOf(p) {
  const n = p.length, idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => p[a] - p[b]), r = new Float64Array(n);
  for (let i = 0; i < n;) { let j = i; while (j + 1 < n && p[idx[j + 1]] === p[idx[i]]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k]] = avg; i = j + 1; }
  return r;
}
// The predictions are genuinely out of sample (made without these labels), so the labels can be circularly shifted against them: the
// shifted labels keep their own overlap structure exactly, and only the alignment with the predictions is destroyed. Statistic = the
// better of the buy / sell AUC (so picking the better side is part of the test, not a free bonus).
function permutationAuc(oos, H, B = 2000) {
  const n = oos.length, pL = oos.map((q) => q.pL), pS = oos.map((q) => q.pS), yL = oos.map((q) => q.yL), yS = oos.map((q) => q.yS);
  const PL = yL.reduce((a, b) => a + b, 0), PS = yS.reduce((a, b) => a + b, 0);
  if (!PL || !PS || PL === n || PS === n) return null;
  const rL = ranksOf(pL), rS = ranksOf(pS);
  const aucOf = (r, y, P, o) => { let sum = 0; for (let i = 0; i < n; i++) { let k = i + o; if (k >= n) k -= n; if (y[k]) sum += r[i]; } return (sum - P * (P + 1) / 2) / (P * (n - P)); };
  const obs = Math.max(aucOf(rL, yL, PL, 0), aucOf(rS, yS, PS, 0)), lo = Math.min(2 * H, Math.floor(n / 4)), rand = rng(777);
  let ge = 0, sum = 0;
  for (let b = 0; b < B; b++) {
    const o = lo + Math.floor(rand() * (n - 2 * lo)), a = Math.max(aucOf(rL, yL, PL, o), aucOf(rS, yS, PS, o));
    sum += a; if (a >= obs) ge++;
  }
  return { p: (ge + 1) / (B + 1), nullMean: sum / B, B };
}
// The same idea for the trading result: shift the SIGNALS against the outcomes (same number of signals, random timing) and see how
// often the average trade comes out as good as the real one.
function permutationTrades(oos, obsMean, nTrades, H, B = 400) {
  const n = oos.length; if (nTrades < 10) return null;
  const lo = Math.min(2 * H, Math.floor(n / 4)), rand = rng(4242);
  let ge = 0, used = 0, sum = 0;
  for (let b = 0; b < B; b++) {
    const o = lo + Math.floor(rand() * (n - 2 * lo)); let busy = -1, tot = 0, cnt = 0;
    for (let s = 0; s < n; s++) {
      const q = oos[s]; if (q.i < busy) continue;
      let k = s + o; if (k >= n) k -= n; const w = oos[k], eL = w.pL - w.tL, eS = w.pS - w.tS;
      if (eL <= 0 && eS <= 0) continue;
      const out = eL >= eS ? q.L : q.S; tot += out.R; cnt++; busy = out.exit;
    }
    if (cnt < 5) continue;
    used++; const m = tot / cnt; sum += m; if (m >= obsMean) ge++;
  }
  return used ? { p: (ge + 1) / (used + 1), nullMean: sum / used, B: used } : null;
}
// Moving-block bootstrap (blocks as long as the label horizon) -> 95% interval of the AUC.
function bootstrapAucCI(oos, H, key, ykey, B = 300) {
  const n = oos.length, p = oos.map((q) => q[key]), y = oos.map((q) => q[ykey]), order = Array.from({ length: n }, (_, i) => i).sort((a, b) => p[a] - p[b]);
  const nb = Math.ceil(n / H), rand = rng(99), aucs = [], m = new Int32Array(n);
  for (let b = 0; b < B; b++) {
    m.fill(0);
    for (let k = 0; k < nb; k++) { const st = Math.floor(rand() * Math.max(1, n - H + 1)); for (let t = 0; t < H && st + t < n; t++) m[st + t]++; }
    let cumNeg = 0, num = 0, P = 0, N = 0;
    for (let k = 0; k < n; k++) { const i = order[k], mm = m[i]; if (!mm) continue; if (y[i]) { P += mm; num += mm * cumNeg; } else { cumNeg += mm; N += mm; } }
    if (P && N) aucs.push(num / (P * N));
  }
  if (aucs.length < 20) return null;
  aucs.sort((a, b) => a - b);
  return [aucs[Math.floor(aucs.length * 0.025)], aucs[Math.floor(aucs.length * 0.975)]];
}

// one position at a time, in time order. `pick(sample)` returns 'long' | 'short' | null
function simulate(samples, pick) {
  const trades = []; let busy = -1;
  for (const s of samples) {
    if (s.i < busy) continue;
    const d = pick(s); if (!d) continue;
    const o = d === 'long' ? s.L : s.S;
    trades.push({ i: s.i, dir: d, R: o.R, fold: s.fold }); busy = o.exit;
  }
  return trades;
}

// ---------------------------------------------------------------------------------------------------------------------------
const DEFAULTS = { model: 'logistic', horizon: 20, slAtr: 1.5, rr: 1.5, costAtr: 0.1, costMode: 'fixed', costMult: 1, folds: 5, margin: 0.05, trainFrac: 0.4, features: [] };
const clamp = (x, lo, hi, d) => (Number.isFinite(Number(x)) ? Math.max(lo, Math.min(hi, Number(x))) : d);
function normalize(o = {}) {
  return {
    model: MODELS[o.model] ? o.model : DEFAULTS.model, horizon: Math.round(clamp(o.horizon, 3, 100, DEFAULTS.horizon)),
    slAtr: clamp(o.slAtr, 0.3, 6, DEFAULTS.slAtr), rr: clamp(o.rr, 0.5, 5, DEFAULTS.rr), costAtr: clamp(o.costAtr, 0, 2, DEFAULTS.costAtr),
    // cost model: 'fixed' = one number in ATR for every symbol (costAtr); 'real' = each symbol's own fee + slippage from the bot's market table (ml-pooled.js), times costMult
    costMode: o.costMode === 'real' ? 'real' : 'fixed', costMult: clamp(o.costMult, 0, 5, DEFAULTS.costMult),
    folds: Math.round(clamp(o.folds, 3, 10, DEFAULTS.folds)), margin: clamp(o.margin, 0, 0.3, DEFAULTS.margin), trainFrac: clamp(o.trainFrac, 0.3, 0.7, DEFAULTS.trainFrac),
    features: GROUPS.filter((g) => (Array.isArray(o.features) ? o.features.includes(g) : !!(o.features && o.features[g]))),
  };
}

function run(bars, options, extra = {}) {
  const p = normalize(options), t0 = Date.now();
  const warmNeed = Array.isArray(bars) && bars.length > 600 ? warmFor(p.features, windows(inferTf(bars))) : WARM;
  if (!Array.isArray(bars) || bars.length < warmNeed + p.horizon + 700) throw new MLError(`کندل کافی نیست: برای این آزمون دست‌کم ${warmNeed + p.horizon + 700} کندل لازم است (الان ${Array.isArray(bars) ? bars.length : 0}). از «ایمپورت MT5» یا آرشیو بیشتر استفاده کن.`);
  const pre = extra.pre || prepare(bars, p, extra.refBars), s = pre.s, samples = [];
  for (let i = pre.warm; i + p.horizon <= s.n - 1; i++) {
    const L = outcome(s, i, 'long', p), S = outcome(s, i, 'short', p);
    if (!L || !S || !pre.ext[i]) continue;
    const x = featureRow(s, i).concat(pre.ext[i]);
    if (x.some((q) => !Number.isFinite(q))) continue;
    samples.push({ i, x, L, S, yL: L.R > 0 ? 1 : 0, yS: S.R > 0 ? 1 : 0 });
  }
  const N = samples.length, first = Math.floor(N * p.trainFrac), size = Math.ceil((N - first) / p.folds);
  if (first < 300 || size < 50) throw new MLError('بعد از آماده‌سازی، نمونه‌ی کافی برای آموزش و آزمون نمانده؛ کندل بیشتری لازم است.');
  const train = MODELS[p.model], folds = [], oos = [], imp = new Array(pre.names.length).fill(0);
  for (let f = 0; f < p.folds; f++) {
    const a = first + f * size, b = Math.min(N, a + size); if (a >= b) break;
    const tr = samples.slice(0, Math.max(0, a - p.horizon)); // the gap: labels of the last `horizon` samples would peek into the test block
    if (tr.length < 300) throw new MLError('دادهٔ آموزش کم است.');
    const X = tr.map((q) => q.x), mL = train(X, tr.map((q) => q.yL)), mS = train(X, tr.map((q) => q.yS));
    const baseL = tr.reduce((q, r) => q + r.yL, 0) / tr.length, baseS = tr.reduce((q, r) => q + r.yS, 0) / tr.length;
    const imL = mL.importance(), imS = mS.importance(), tot = imL.reduce((q, r) => q + r, 0) + imS.reduce((q, r) => q + r, 0) || 1;
    for (let k = 0; k < imp.length; k++) imp[k] += (imL[k] + imS[k]) / tot / p.folds;
    for (const q of samples.slice(a, b)) oos.push({ i: q.i, L: q.L, S: q.S, yL: q.yL, yS: q.yS, pL: mL.predict(q.x), pS: mS.predict(q.x), tL: baseL + p.margin, tS: baseS + p.margin, fold: f });
    folds.push({ from: bars[samples[a].i].time, to: bars[samples[b - 1].i].time, samples: b - a, trainSamples: tr.length });
  }
  const aucL = auc(oos.map((q) => q.pL), oos.map((q) => q.yL)), aucS = auc(oos.map((q) => q.pS), oos.map((q) => q.yS));
  const model = simulate(oos, (q) => {
    const eL = q.pL - q.tL, eS = q.pS - q.tS;
    if (eL <= 0 && eS <= 0) return null;
    return eL >= eS ? 'long' : 'short';
  });
  const randL = simulate(oos, () => 'long'), randS = simulate(oos, () => 'short');
  const st = tradeStats(model), pv = bootstrapP(model.map((t) => t.R));
  const byFold = folds.map((fo, f) => { const t = model.filter((x) => x.fold === f), q = tradeStats(t); return { ...fo, trades: q.trades, meanR: q.meanR }; });
  const withTrades = byFold.filter((q) => q.trades >= 3), good = withTrades.filter((q) => q.meanR > 0).length;
  const sortedP = oos.map((q) => Math.max(q.pL - q.tL, q.pS - q.tS)).sort((a, b) => a - b);
  const aucBest = Math.max(aucL || 0, aucS || 0);
  const baseline = { long: tradeStats(randL), short: tradeStats(randS) };
  const beats = st.meanR > Math.max(baseline.long.meanR, baseline.short.meanR);
  const byDirection = {};
  for (const d of ['long', 'short']) byDirection[d] = tradeStats(model.filter((t) => t.dir === d));
  const hold = { pct: (bars[oos[oos.length - 1].i].close / bars[oos[0].i + 1].open - 1) * 100, from: bars[oos[0].i + 1].time, to: bars[oos[oos.length - 1].i].time };
  let stats = null;
  if (extra.stats !== false) {
    const aucPerm = permutationAuc(oos, p.horizon), tradePerm = permutationTrades(oos, st.meanR, st.trades, p.horizon);
    const aucCI = { long: bootstrapAucCI(oos, p.horizon, 'pL', 'yL'), short: bootstrapAucCI(oos, p.horizon, 'pS', 'yS') };
    stats = { aucPerm, tradePerm, aucCI, effectiveN: Math.round(oos.length / p.horizon) };
  }
  const bestSide = (aucL || 0) >= (aucS || 0) ? 'long' : 'short';
  const verdict = judge({ st, pv, aucBest, good, withTrades: withTrades.length, beats, stats, ciLow: stats && stats.aucCI[bestSide] ? stats.aucCI[bestSide][0] : null });
  return {
    ok: true, params: p, candles: bars.length, samples: N, oosSamples: oos.length, from: folds[0].from, to: folds[folds.length - 1].to,
    auc: { long: aucL, short: aucS }, trades: st, byDirection, hold, pValue: pv, baseline, folds: byFold, foldsProfitable: good, foldsWithTrades: withTrades.length,
    importance: pre.names.map(([id, fa], k) => ({ id, name: fa, share: imp[k] })).sort((a, b) => b.share - a.share).slice(0, 6),
    features: { groups: p.features, ref: pre.hasRef, count: pre.names.length }, stats,
    breakEvenWinRate: (1 + p.costAtr / p.slAtr) / (1 + p.rr), thresholdMargin: p.margin, unusedSignals: sortedP.filter((x) => x <= 0).length, verdict, ms: Date.now() - t0,
  };
}

// The same experiment at several round-trip costs, so you can see how much of the result is the cost. Returns the run at
// options.costAtr plus a small table. Each cost is a different setting of the same idea (the research ledger counts them as variants).
function runSweep(bars, options, extra = {}) {
  const base = normalize(options), costs = [...new Set([0, 0.1, 0.2, base.costAtr].map((x) => Math.round(x * 1000) / 1000))].sort((a, b) => a - b);
  const mainIdx = costs.indexOf(Math.round(base.costAtr * 1000) / 1000), pre = prepare(bars, base, extra.refBars);
  const runs = costs.map((c, k) => run(bars, { ...base, costAtr: c }, { pre, stats: k === mainIdx })), main = runs[mainIdx];
  main.costSweep = runs.map((r) => ({ costAtr: r.params.costAtr, trades: r.trades.trades, meanR: r.trades.meanR, winRate: r.trades.winRate, aucBest: Math.max(r.auc.long || 0, r.auc.short || 0), level: r.verdict.level }));
  main.ms = runs.reduce((a, r) => a + r.ms, 0);
  return main;
}

function judge({ st, pv, aucBest, good, withTrades, beats, stats, ciLow }) {
  const warn = 'این فقط یک آزمون روی همین نماد و همین دوره است؛ قبل از هر اعتماد، روی نماد و دوره‌ی دیگر هم تکرارش کن و بعد در حالت کاغذی ببین.';
  if (st.trades < 30) return { level: 'none', text: `معامله‌ی کافی ساخته نشد (${st.trades} معامله) تا بشود قضاوت کرد. مدل تقریباً هیچ‌وقت به اطمینان لازم نرسید؛ این معمولاً یعنی چیز قابل‌اتکایی یاد نگرفته.` };
  if (st.meanR <= 0) return { level: 'none', text: 'مدل روی داده‌ی دیده‌نشده سود نشان نداد؛ میانگین هر معامله بعد از هزینه صفر یا منفی است. نتیجه: لبه‌ای پیدا نشد.' };
  const tp = stats && stats.tradePerm ? stats.tradePerm.p : pv, ap = stats && stats.aucPerm ? stats.aucPerm.p : null;
  const strong = st.trades >= 100 && tp !== null && tp < 0.05 && aucBest > 0.52 && beats && withTrades >= 3 && good / withTrades >= 0.6
    && (!stats || (ap !== null && ap < 0.05 && ciLow !== null && ciLow > 0.5));
  if (strong) return { level: 'promising', text: `نتیجه امیدوارکننده است (نه اثبات): میانگین ${st.meanR.toFixed(2)}R در هر معامله بعد از هزینه، و شانس اینکه این فقط اقبال باشد حدود ${(tp * 100).toFixed(1)}٪ است (آزمون جایگشت). ${warn}` };
  return { level: 'weak', text: `سود کوچکی دیده می‌شود (${st.meanR.toFixed(2)}R در هر معامله) ولی شواهد برای اعتماد کافی نیست: ${st.trades < 100 ? 'تعداد معاملات کم است؛ ' : ''}${tp !== null && tp >= 0.05 ? `احتمال اقبال ${(tp * 100).toFixed(0)}٪ است؛ ` : ''}${stats && ap !== null && ap >= 0.05 ? `آزمون جایگشت AUC (${(ap * 100).toFixed(0)}٪) از شانس جدا نشد؛ ` : ''}${stats && ciLow !== null && ciLow <= 0.5 ? 'کران پایین بازه‌ی اطمینان AUC زیر ۰٫۵ است؛ ' : ''}${!beats ? 'از ورود تصادفی بهتر نبود؛ ' : ''}${withTrades && good / withTrades < 0.6 ? 'همه‌ی بازه‌های آزمون سودده نبودند. ' : ''}${warn}` };
}

module.exports = { run, runSweep, prepare, inferTf, windows, permutationAuc, permutationTrades, bootstrapAucCI, GROUPS, normalize, featureRow, series, outcome, auc, bootstrapP, trainLogistic, trainBoost, FEATURES, WARM, MLError, DEFAULTS,
  // building blocks shared with ml-pooled.js
  MODELS, judge, tradeStats, simulate, rng, ranksOf, warmFor };
