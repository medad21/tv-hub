// "Is this result distinguishable from luck?" — small, dependency-free statistics for the backtest reports.
// Everything here is DETERMINISTIC (seeded random numbers), so running the same comparison twice gives the same numbers.
//
//  - bootstrapCI:   95% confidence interval of the average R per trade (resampling the trades, with replacement)
//  - pValueMean:    one-sided p-value for "the true average R is above zero": how often would a strategy with NO edge
//                   (the same trades, re-centred to average zero) show an average at least this good by chance?
//  - adjustP:       Bonferroni correction for having tried N combinations — the chance that at least one of N useless
//                   strategies looks this good is about N times larger than for a single one
//  - pfLowerBound:  the 5th-percentile Profit Factor of the resampled trades ("a bad-luck version of this PF")
// BLOCK BOOTSTRAP: trades are NOT independent. When crypto falls on Tuesday, BTC, ETH and SOL all lose together, and a trending
// week produces a run of similar trades — those are one piece of evidence, not several. Resampling single trades one by one
// ignores that and reports intervals that are too narrow and p-values that are too small. So when the trades carry their entry
// time, they are grouped into calendar BLOCKS (default 3 days, BLOCK_DAYS in .env) and whole blocks are resampled; everything
// that happened in the same block stays together. With fewer than MIN_BLOCKS blocks there are not enough independent pieces of
// evidence to say anything, and the adjusted p-value is forced to 1 ("cannot be told apart from luck").
// Without entry times (or when no `blocks` are given) every trade is its own block: the old behaviour, number for number.
// Limits worth knowing: the block length is a rule of thumb (a longer block is more cautious), and combinations that share
// trades are correlated, which makes Bonferroni on the CONSERVATIVE side (it can only over-count the luck, never under-count it).

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
const pick = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];
// a seed that depends on the data itself, so different cells do not share the same random stream but reruns are identical
const seedFrom = (x, salt = 1) => { let h = (2166136261 ^ salt) >>> 0; for (const v of x) { h = Math.imul(h ^ (Math.round(v * 1e6) | 0), 16777619) >>> 0; } return h || 1; };

const MIN_BLOCKS = 6; // fewer independent time blocks than this: no statistical claim is made
const blockDays = () => { const n = Number(process.env.BLOCK_DAYS); return n > 0 ? n : 3; };
const singles = (n) => Array.from({ length: n }, (_, i) => [i]);
// times: seconds, one per value. Returns blocks = arrays of indices that share a calendar block (a value without a usable time is alone).
function blocksOf(times, days = blockDays()) {
  const span = Math.max(0.01, days) * 86400, m = new Map();
  times.forEach((t, i) => { const k = Number.isFinite(t) ? Math.floor(t / span) : `i${i}`; if (!m.has(k)) m.set(k, []); m.get(k).push(i); });
  return [...m.values()];
}

function bootstrapCI(values, iters = 2000, blocks = null) {
  const n = values.length;
  if (n < 5) return null;
  const bl = blocks || singles(n), nb = bl.length;
  const r = rng(seedFrom(values, 11)), means = [];
  for (let it = 0; it < iters; it++) {
    let s = 0, c = 0;
    for (let b = 0; b < nb; b++) { const blk = bl[Math.floor(r() * nb)]; for (let k = 0; k < blk.length; k++) s += values[blk[k]]; c += blk.length; }
    means.push(s / c);
  }
  means.sort((a, b) => a - b);
  return { mean: mean(values), lo: pick(means, 0.025), hi: pick(means, 0.975) };
}

function pValueMean(values, iters = 4000, blocks = null) {
  const n = values.length, m = n ? mean(values) : 0;
  if (n < 5) return null;
  if (m <= 0) return 1;
  const centred = values.map((v) => v - m), r = rng(seedFrom(values, 23)), bl = blocks || singles(n), nb = bl.length;
  let ge = 0;
  for (let it = 0; it < iters; it++) {
    let s = 0, c = 0;
    for (let b = 0; b < nb; b++) { const blk = bl[Math.floor(r() * nb)]; for (let k = 0; k < blk.length; k++) s += centred[blk[k]]; c += blk.length; }
    if (s / c >= m) ge++;
  }
  return (ge + 1) / (iters + 1); // never reports exactly 0: with finite resampling "0" would be a false claim of certainty
}

const adjustP = (p, tests) => (p === null ? null : Math.min(1, p * Math.max(1, tests)));

function pfLowerBound(pnls, iters = 1500, blocks = null) {
  const n = pnls.length;
  if (n < 5) return null;
  const r = rng(seedFrom(pnls, 37)), pfs = [], bl = blocks || singles(n), nb = bl.length;
  for (let it = 0; it < iters; it++) {
    let gw = 0, gl = 0;
    for (let b = 0; b < nb; b++) { const blk = bl[Math.floor(r() * nb)]; for (let k = 0; k < blk.length; k++) { const v = pnls[blk[k]]; if (v > 0) gw += v; else gl -= v; } }
    pfs.push(gl > 0 ? gw / gl : gw > 0 ? Infinity : 0);
  }
  pfs.sort((a, b) => a - b);
  return pick(pfs, 0.05);
}

// everything the report needs for one cell's trades (needs >= 10 trades, otherwise the numbers would pretend to be precise).
// Trades that carry `entryTime` (seconds) are resampled in calendar blocks (see the top of this file); opts.blockDays overrides the length.
function tradeStats(trades, tests, opts = {}) {
  if (!trades || trades.length < 10) return null;
  const rs = trades.map((t) => t.r), times = trades.map((t) => t.entryTime), timed = times.every(Number.isFinite);
  const days = opts.blockDays || blockDays(), blocks = timed ? blocksOf(times, days) : singles(trades.length);
  const fewBlocks = timed && blocks.length < MIN_BLOCKS;
  const p = pValueMean(rs, 4000, blocks);
  return {
    n: trades.length, tests: Math.max(1, tests), p, pAdj: fewBlocks && p !== null ? 1 : adjustP(p, tests),
    ci: bootstrapCI(rs, 2000, blocks), pfLo: pfLowerBound(trades.map((t) => t.pnl), 1500, blocks),
    blocks: blocks.length, blockDays: timed ? days : 0, fewBlocks,
  };
}

// worst peak-to-trough fall of a close series, in percent (what a person who simply held would have lived through)
function maxDrawdownPct(closes) {
  let peak = -Infinity, dd = 0;
  for (const c of closes) { if (c > peak) peak = c; if (peak > 0) dd = Math.max(dd, (peak - c) / peak * 100); }
  return dd;
}

// what kind of market the window was, judged by simply holding the asset (scaled to a year so a 50-day window and a
// 1000-day window are comparable)
function regimeOf(holdReturnPct, days) {
  const perYear = days > 0 ? holdReturnPct * 365 / days : 0;
  // +25 %/year is far above what holding a market earns in a normal year, so a long-only strategy looks good almost by default there
  if (perYear >= 25) return { id: 'strong_up', label: 'صعودی قوی', perYear };
  if (perYear <= -15) return { id: 'down', label: 'نزولی', perYear };
  return { id: 'mild', label: 'ملایم / بی‌روند', perYear };
}

module.exports = { rng, seedFrom, blocksOf, blockDays, MIN_BLOCKS, bootstrapCI, pValueMean, adjustP, pfLowerBound, tradeStats, maxDrawdownPct, regimeOf };
