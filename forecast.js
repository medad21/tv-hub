// "How likely is it that price reaches a level in the next N candles?" — answered with numbers, from the market's OWN recent history,
// not with a guess about direction. No neural network, no download, no model file: pure JavaScript.
//
// How it works: every past candle is turned into a shape relative to the previous close (close, high and low as log-moves). Thousands of
// possible futures are built by chaining blocks of those real shapes (a block bootstrap keeps volatility clustering: calm stretches stay
// calm, wild ones stay wild). Then we simply count: in how many of the futures did price touch the target before the stop?
//
// WHAT IT IS NOT. It does not predict direction: the average drift is removed on purpose (otherwise a gold bull market in the history
// would make every forecast "bullish"). It says how far price typically travels in N candles at TODAY's volatility, so "will it reach
// 2320 before 2305" gets an honest probability. Whether those probabilities can be trusted is measured, not assumed: calibrate() replays
// the method over the archive and checks that "40%" really happens about 40% of the time (and that it beats just quoting the long-run rate).
//
// Candles: oldest -> newest, CLOSED only: [{ time, open, max, min, close, volume }]  (the same shape everywhere in tv-hub).
const { atrOf } = require('./market-structure');

const DEFAULTS = { horizon: 12, paths: 2000, block: 6, minBars: 120, recent: 50, maxHistory: 3000, volScale: true, drift: 'zero', seed: null };
const MAX_CELLS = 1500000; // paths x horizon: keeps memory and time bounded
const opt = (o) => ({ ...DEFAULTS, ...(o || {}) });
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function mulberry32(a) { // small deterministic generator: the same candles give the same answer every time
  let t = a >>> 0;
  return () => { t = (t + 0x6D2B79F5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
const seedOf = (bars) => { const l = bars[bars.length - 1]; return (Math.floor(l.time) ^ Math.floor(l.close * 1000)) >>> 0; };

const clean = (bars) => (Array.isArray(bars) ? bars : []).filter((b) => b && finite(b.time) && finite(b.open) && finite(b.max) && finite(b.min) && finite(b.close) && b.close > 0 && b.max > 0 && b.min > 0 && b.max >= b.min);

// each candle as moves relative to the PREVIOUS close: { ret, up, dn } (log). Optionally drift removed and volatility rescaled to today's.
function shapes(bars, p) {
  const use = bars.slice(-p.maxHistory), out = [];
  for (let i = 1; i < use.length; i++) {
    const pc = use[i - 1].close;
    out.push({ ret: Math.log(use[i].close / pc), up: Math.log(use[i].max / pc), dn: Math.log(use[i].min / pc) });
  }
  if (out.length < 30) return { shapes: out, scale: 1, sd: 0 };
  const mean = out.reduce((s, x) => s + x.ret, 0) / out.length;
  const sd = (arr) => { const m = arr.reduce((s, x) => s + x, 0) / arr.length; return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); };
  const all = sd(out.map((x) => x.ret)), rec = sd(out.slice(-p.recent).map((x) => x.ret));
  const scale = p.volScale && all > 0 ? clamp(rec / all, 0.5, 2) : 1; // today's volatility vs the whole sample (never more than 2x either way)
  const shift = p.drift === 'zero' ? mean : 0;
  for (const s of out) { s.ret = (s.ret - shift) * scale; s.up = (s.up - shift) * scale; s.dn = (s.dn - shift) * scale; }
  return { shapes: out, scale, sd: all };
}

// -----------------------------------------------------------------------------------------------------------------
// Build the futures. Returns null (and a reason) when the data cannot support it.
function simulate(input, o) {
  const p = opt(o), bars = clean(input);
  if (bars.length < p.minBars) return { ok: false, reason: `کندل کافی نیست (${bars.length} از حداقل ${p.minBars})` };
  const H = Math.round(p.horizon), N = Math.round(p.paths);
  if (!(H >= 1 && H <= 200)) return { ok: false, reason: 'افق باید بین ۱ تا ۲۰۰ کندل باشد' };
  if (!(N >= 100) || N * H > MAX_CELLS) return { ok: false, reason: `تعداد مسیرها باید حداقل ۱۰۰ باشد و (مسیر × افق) از ${MAX_CELLS} بیشتر نشود` };
  const sh = shapes(bars, p), m = sh.shapes.length, B = Math.max(1, Math.min(Math.round(p.block), m));
  if (m < 30) return { ok: false, reason: 'تاریخچه‌ی قابل استفاده خیلی کوتاه است' };
  const rnd = mulberry32(p.seed !== null && p.seed !== undefined ? p.seed : seedOf(bars));
  const P0 = bars[bars.length - 1].close;
  const highs = new Float64Array(N * H), lows = new Float64Array(N * H), closes = new Float64Array(N * H);
  for (let k = 0; k < N; k++) {
    let cur = P0, start = 0, left = 0;
    for (let t = 0; t < H; t++) {
      if (left === 0) { start = Math.floor(rnd() * (m - B + 1)); left = B; }
      const s = sh.shapes[start + (B - left)]; left--;
      const i = k * H + t;
      highs[i] = cur * Math.exp(s.up); lows[i] = cur * Math.exp(s.dn); closes[i] = cur * Math.exp(s.ret);
      cur = closes[i];
    }
  }
  return { ok: true, H, N, P0, highs, lows, closes, scale: sh.scale, history: m, block: B, drift: p.drift };
}

// share of futures in which price TOUCHED `price` (dir 'up': a high reached it; 'down': a low reached it) within the horizon
function touch(sim, price, dir) {
  const { H, N, highs, lows } = sim; let hit = 0; const when = [];
  for (let k = 0; k < N; k++) {
    for (let t = 0; t < H; t++) {
      const i = k * H + t;
      if (dir === 'up' ? highs[i] >= price : lows[i] <= price) { hit++; when.push(t + 1); break; }
    }
  }
  when.sort((a, b) => a - b);
  return { p: hit / N, medianBars: when.length ? when[when.length >> 1] : null };
}

// A long trade started at the last close: which comes first, the target or the stop? A candle that reaches BOTH counts as the stop
// (the same cautious rule as the backtester). R = result in units of the stop distance; paths that reach neither close at their horizon value.
function tradeOdds(sim, { sl, tp, entry, costR = 0 }) {
  const { H, N, highs, lows, closes } = sim, e = finite(entry) ? entry : sim.P0;
  const dist = e - sl, rr = (tp - e) / dist;
  if (!(dist > 0) || !(rr > 0)) return { ok: false, reason: 'حد ضرر باید پایین‌تر و حد سود بالاتر از نقطه‌ی ورود باشد' };
  let nTp = 0, nSl = 0, nNone = 0, sumR = 0; const rs = [];
  for (let k = 0; k < N; k++) {
    let r = null;
    for (let t = 0; t < H; t++) {
      const i = k * H + t;
      if (lows[i] <= sl) { nSl++; r = -1; break; }
      if (highs[i] >= tp) { nTp++; r = rr; break; }
    }
    if (r === null) { nNone++; r = clamp((closes[k * H + H - 1] - e) / dist, -1, rr); }
    r -= costR; sumR += r; rs.push(r);
  }
  return { ok: true, pTp: nTp / N, pSl: nSl / N, pNone: nNone / N, rr, expectedR: sumR / N, horizon: H };
}

function quantiles(sim, qs = [0.05, 0.25, 0.5, 0.75, 0.95]) {
  const { H, N, closes, P0 } = sim, end = new Float64Array(N);
  for (let k = 0; k < N; k++) end[k] = closes[k * H + H - 1];
  end.sort();
  return qs.map((q) => { const v = end[Math.min(N - 1, Math.floor(q * N))]; return { q, price: v, pct: (v / P0 - 1) * 100 }; });
}

// One call for the app: levels = [{ name, price, dir }], trade = { sl, tp, entry?, costR? }
function forecast(bars, o, { levels = [], trade = null } = {}) {
  const sim = simulate(bars, o);
  if (!sim.ok) return sim;
  const out = {
    ok: true, horizon: sim.H, paths: sim.N, price: sim.P0,
    assumptions: { drift: sim.drift, volatilityScale: Number(sim.scale.toFixed(2)), historyCandles: sim.history, block: sim.block },
    closeQuantiles: quantiles(sim),
    levels: levels.filter((l) => l && finite(l.price) && (l.dir === 'up' || l.dir === 'down')).map((l) => ({ name: l.name || null, price: l.price, dir: l.dir, ...touch(sim, l.price, l.dir) })),
    trade: trade ? tradeOdds(sim, trade) : null,
    notes: ['جهت بازار پیش‌بینی نمی‌شود (میانگین روند تاریخی حذف شده)؛ فقط می‌گوید با نوسان امروز قیمت چقدر دور می‌شود.'],
  };
  return out;
}

// -----------------------------------------------------------------------------------------------------------------
// Is it honest? Replay the method over history: at each origin use ONLY the candles before it, forecast, then look at what happened.
// Events (relative to the origin's ATR): price touches +k ATR / -k ATR within the horizon, for k = 0.5, 1, 2.
//   brier         mean squared error of the probabilities (lower is better)
//   baselineBrier the same for just quoting the long-run frequency known at that time ("climatology")
//   skill         1 - brier/baselineBrier  (> 0: better than the lazy rate; <= 0: the model adds nothing)
//   ece           how far "40%" is from what really happened, averaged over probability bins (0 = perfectly calibrated)
//   eceNoise      the ece you would see from luck alone with this few samples (a small test can never show ece = 0)
// The method has NO tuned parameters, so every origin is a true out-of-sample test. The newest 30% are scored again alone ("holdout")
// to catch a market that changed character recently. Origins are `horizon` candles apart so outcomes do not overlap.
const KS = [0.5, 1, 2];
const ECE_EXCESS_MAX = 0.04, ECE_EXCESS_MAX_HOLD = 0.08, SKILL_MIN = -0.02, SKILL_MIN_HOLD = -0.06, MIN_ORIGINS = 150, MIN_HOLD = 50;
function scoreEvent(preds, outs) {
  const n = preds.length;
  if (!n) return null;
  let brier = 0, base = 0, sp = 0, so = 0, prior = 0, pn = 0;
  const bins = Array.from({ length: 5 }, () => ({ n: 0, p: 0, o: 0 }));
  for (let i = 0; i < n; i++) {
    const clim = pn >= 20 ? prior / pn : 0.5; // the long-run rate as known at that moment
    brier += (preds[i] - outs[i]) ** 2; base += (clim - outs[i]) ** 2; sp += preds[i]; so += outs[i];
    const b = bins[Math.min(4, Math.floor(preds[i] * 5))]; b.n++; b.p += preds[i]; b.o += outs[i];
    prior += outs[i]; pn++;
  }
  let ece = 0, noise = 0;
  for (const b of bins) if (b.n) { const pm = b.p / b.n; ece += (b.n / n) * Math.abs(pm - b.o / b.n); noise += (b.n / n) * 0.8 * Math.sqrt(Math.max(pm * (1 - pm), 0.01) / b.n); }
  return { n, meanPred: sp / n, observed: so / n, brier: brier / n, baselineBrier: base / n, skill: base > 0 ? 1 - brier / base : 0, ece, eceNoise: noise,
    bins: bins.map((b, i) => ({ lo: i / 5, hi: (i + 1) / 5, n: b.n, pred: b.n ? b.p / b.n : null, obs: b.n ? b.o / b.n : null })) };
}
// pure: verdict from the stats (tested directly)
function verdictOf(stats) {
  const evs = Object.values(stats.events || {});
  if (!evs.length || stats.origins < MIN_ORIGINS || evs.some((e) => !e.holdout || e.holdout.n < MIN_HOLD)) return { verdict: 'insufficient', reasons: [`نمونه‌ی کافی برای قضاوت نیست (${stats.origins || 0} نقطه‌ی آزمون؛ حداقل ${MIN_ORIGINS} لازم است)`] };
  const why = [], pp = (x) => (x * 100).toFixed(0);
  for (const [name, e] of Object.entries(stats.events)) {
    if (e.ece - e.eceNoise > ECE_EXCESS_MAX) why.push(`${name}: احتمال‌ها با واقعیت فاصله دارند (میانگین خطا ${pp(e.ece)} واحد درصد، در حالی که با شانس تنها حدود ${pp(e.eceNoise)} انتظار می‌رفت)`);
    if (e.skill < SKILL_MIN) why.push(`${name}: از «گفتن نرخ بلندمدت» بدتر است (مهارت ${e.skill.toFixed(2)})`);
    if (e.holdout.ece - e.holdout.eceNoise > ECE_EXCESS_MAX_HOLD) why.push(`${name}: روی جدیدترین بخش داده خطای احتمال‌ها زیاد است (${pp(e.holdout.ece)} واحد درصد در برابر ${pp(e.holdout.eceNoise)} ناشی از شانس)`);
    if (e.holdout.skill < SKILL_MIN_HOLD) why.push(`${name}: روی جدیدترین بخش داده از نرخ بلندمدت بدتر است (مهارت ${e.holdout.skill.toFixed(2)})`);
  }
  return why.length ? { verdict: 'unreliable', reasons: why } : { verdict: 'reliable', reasons: ['احتمال‌ها روی داده‌ی بیرون از نمونه با واقعیت جور بودند و از نرخ بلندمدت بدتر نبودند'] };
}
async function calibrate(input, o, { every = null, maxOrigins = 1500, yieldEvery = 40, onProgress } = {}) {
  const p = opt({ paths: 400, ...(o || {}) }), bars = clean(input), H = Math.round(p.horizon), step = every || H;
  const first = Math.max(p.minBars + 30, 150), last = bars.length - H - 1;
  if (last < first) return { ok: false, reason: `تاریخچه برای آزمون کافی نیست (${bars.length} کندل)`, origins: 0 };
  let origins = []; for (let t = first; t <= last; t += step) origins.push(t);
  if (origins.length > maxOrigins) origins = origins.slice(-maxOrigins); // the newest ones
  const ev = {}; for (const k of KS) { ev[`touch_up_${k}atr`] = { preds: [], outs: [] }; ev[`touch_down_${k}atr`] = { preds: [], outs: [] }; }
  let done = 0;
  for (const t of origins) {
    const hist = bars.slice(Math.max(0, t + 1 - p.maxHistory), t + 1), a = atrOf(hist.slice(-120), 14), P0 = hist[hist.length - 1].close;
    if (!a) continue;
    const sim = simulate(hist, { ...p, seed: (t * 2654435761) >>> 0 });
    if (!sim.ok) continue;
    const fut = bars.slice(t + 1, t + 1 + H), hi = Math.max(...fut.map((b) => b.max)), lo = Math.min(...fut.map((b) => b.min));
    for (const k of KS) {
      ev[`touch_up_${k}atr`].preds.push(touch(sim, P0 + k * a, 'up').p); ev[`touch_up_${k}atr`].outs.push(hi >= P0 + k * a ? 1 : 0);
      ev[`touch_down_${k}atr`].preds.push(touch(sim, P0 - k * a, 'down').p); ev[`touch_down_${k}atr`].outs.push(lo <= P0 - k * a ? 1 : 0);
    }
    if (++done % yieldEvery === 0) { if (onProgress) onProgress(done, origins.length); await new Promise((r) => setImmediate(r)); } // never freeze the server
  }
  const n = ev[`touch_up_1atr`].preds.length, cut = Math.floor(n * 0.7), events = {};
  for (const [name, { preds, outs }] of Object.entries(ev)) events[name] = { ...scoreEvent(preds, outs), holdout: scoreEvent(preds.slice(cut), outs.slice(cut)) };
  const stats = { ok: true, origins: n, horizon: H, step, paths: p.paths, candles: bars.length, events };
  return { ...stats, ...verdictOf(stats), assumptions: { drift: p.drift, volScale: p.volScale, block: p.block } };
}

module.exports = { simulate, touch, tradeOdds, quantiles, forecast, calibrate, verdictOf, scoreEvent, shapes, DEFAULTS, KS, ECE_EXCESS_MAX, SKILL_MIN, MIN_ORIGINS };
