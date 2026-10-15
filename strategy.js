// All series are ordered oldest -> newest.
function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

function ema(values, n) {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// Same as ema() but returns the whole series (index n-1 .. end), needed to build MACD.
function emaSeries(values, n) {
  if (values.length < n) return [];
  const k = 2 / (n + 1);
  const out = new Array(values.length);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

// bars: [{max, min, close}]
function atr(bars, n = 14) {
  if (bars.length <= n) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const { max: h, min: l } = bars[i], pc = bars[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

// Classic MACD: fast EMA minus slow EMA, plus a signal line (EMA of that) and the histogram.
// hist > 0 means recent momentum is up (fast EMA pulling above slow), hist < 0 means down.
function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null;
  const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
  const line = [];
  for (let i = slow - 1; i < closes.length; i++) line.push(ef[i] - es[i]);
  if (line.length < signalPeriod) return null;
  const k = 2 / (signalPeriod + 1);
  let s = line.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
  for (let i = signalPeriod; i < line.length; i++) s = line[i] * k + s * (1 - k);
  const last = line[line.length - 1];
  return { macd: last, signal: s, hist: last - s };
}

// Average volume of the last n bars.
function avgVolume(bars, n = 20) {
  if (bars.length < n) return null;
  const vols = bars.slice(-n).map((b) => b.volume || 0);
  const a = vols.reduce((x, y) => x + y, 0) / n;
  return a > 0 ? a : null; // some feeds don't report volume (e.g. forex) -> treat as "no data"
}

// ---------------------------------------------------------------------------
// Streaming versions: same exact math as rsi()/ema()/atr()/macd()/avgVolume() above,
// just fed one bar at a time and kept as running state instead of recomputing over a
// slice on every call. Used by the backtester to process each candle in O(1) instead of
// O(window) — a plain replay of N candles used to redo up to a 300-candle calculation at
// every single step; this makes it a single O(N) pass instead. The live bot still uses the
// plain functions above on whatever short window TradingView hands it each tick, since that
// happens once per candle close and was never the slow part.
function createEmaStream(n) {
  const k = 2 / (n + 1);
  const seed = []; let value = null;
  return (x) => {
    if (value !== null) return (value = x * k + value * (1 - k));
    seed.push(x);
    if (seed.length < n) return null;
    return (value = seed.reduce((a, b) => a + b, 0) / n);
  };
}

function createRsiStream(period = 14) {
  let prev = null, avgGain = null, avgLoss = null;
  const gains = [], losses = [];
  return (close) => {
    if (prev === null) { prev = close; return null; }
    const d = close - prev; prev = close;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (avgGain === null) {
      gains.push(g); losses.push(l);
      if (gains.length < period) return null;
      avgGain = gains.reduce((a, b) => a + b, 0) / period;
      avgLoss = losses.reduce((a, b) => a + b, 0) / period;
    } else {
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
    }
    return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  };
}

function createAtrStream(n = 14) {
  let prevClose = null, a = null;
  const trs = [];
  return (bar) => {
    if (prevClose === null) { prevClose = bar.close; return null; }
    const tr = Math.max(bar.max - bar.min, Math.abs(bar.max - prevClose), Math.abs(bar.min - prevClose));
    prevClose = bar.close;
    if (a === null) {
      trs.push(tr);
      if (trs.length < n) return null;
      a = trs.reduce((x, y) => x + y, 0) / n;
    } else a = (a * (n - 1) + tr) / n;
    return a;
  };
}

function createMacdStream(fast = 12, slow = 26, signalPeriod = 9) {
  const fastS = createEmaStream(fast), slowS = createEmaStream(slow), sigS = createEmaStream(signalPeriod);
  return (close) => {
    const ef = fastS(close), es = slowS(close);
    if (ef === null || es === null) return null;
    const line = ef - es, sig = sigS(line);
    return sig === null ? null : { macd: line, signal: sig, hist: line - sig };
  };
}

function createVolumeStream(n = 20) {
  const buf = []; let sum = 0;
  return (vol) => {
    buf.push(vol || 0); sum += vol || 0;
    if (buf.length > n) sum -= buf.shift();
    if (buf.length < n) return null;
    return sum > 0 ? sum / n : null; // some feeds don't report volume (e.g. forex) -> treat as "no data"
  };
}
// ---------------------------------------------------------------------------

// Highest 'max' / lowest 'min' over the last n bars — used by the breakout strategy below.
function donchianHigh(bars, n = 20) {
  if (bars.length < n) return null;
  return Math.max(...bars.slice(-n).map((b) => b.max));
}
function donchianLow(bars, n = 20) {
  if (bars.length < n) return null;
  return Math.min(...bars.slice(-n).map((b) => b.min));
}

// ---------------------------------------------------------------------------
// Custom strategies (written by the user in custom-strategies.js, or built from others in the dashboard).
// A custom strategy's signal(ctx) is called once per CLOSED candle and sees ONLY candles up to and including that
// one (never a future candle), through the helpers below. It returns 'buy' / 'sell' / anything else = no opinion.
// Like the built-ins it describes a STATE ("entry condition is true right now"); the engine acts when that state
// CHANGES (hold -> buy, hold -> sell), the same edge-detection every strategy gets.
const WINDOW = 300; // the same history window the live bot and the backtester use for every indicator
const CTX_MAX_PERIOD = 250; // an indicator needs its period to fit comfortably inside WINDOW

function makeCtx(allBars, index = allBars.length - 1) {
  const lo = Math.max(0, index - WINDOW + 1);
  let win = null;
  const W = () => win || (win = allBars.slice(lo, index + 1));
  const memo = new Map();
  const memoize = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
  const per = (p, name) => {
    if (!Number.isInteger(p) || p < 1 || p > CTX_MAX_PERIOD) throw new Error(`${name}: period must be a whole number from 1 to ${CTX_MAX_PERIOD} (got ${p})`);
    return p;
  };
  const closes = () => memoize('closes', () => W().map((b) => b.close));
  const bar = allBars[index];
  return {
    index, bar, prev: index > 0 ? allBars[index - 1] : null, time: bar.time,
    open: bar.open, high: bar.max, low: bar.min, close: bar.close, volume: bar.volume,
    get bars() { return W(); }, // oldest -> newest, last = this candle (bars carry open, max, min, close, volume, time)
    rsi: (p = 14) => memoize('rsi' + per(p, 'rsi'), () => rsi(closes(), p)),
    ema: (p) => memoize('ema' + per(p, 'ema'), () => ema(closes(), p)),
    sma: (p) => memoize('sma' + per(p, 'sma'), () => { const c = closes(); return c.length < p ? null : c.slice(-p).reduce((a, b) => a + b, 0) / p; }),
    atr: (p = 14) => memoize('atr' + per(p, 'atr'), () => atr(W(), p)),
    macd: (f = 12, sl = 26, sg = 9) => memoize(`macd${f}.${sl}.${sg}`, () => macd(closes(), f, sl, sg)), // { macd, signal, hist } or null
    avgVolume: (n = 20) => memoize('av' + per(n, 'avgVolume'), () => avgVolume(W(), n)),
    // highest high / lowest low of the n candles strictly BEFORE this one (the candle itself is never part of its own breakout level)
    highest: (n) => memoize('hi' + per(n, 'highest'), () => { const w = W(); return w.length - 1 < n ? null : Math.max(...w.slice(-1 - n, -1).map((b) => b.max)); }),
    lowest: (n) => memoize('lo' + per(n, 'lowest'), () => { const w = W(); return w.length - 1 < n ? null : Math.min(...w.slice(-1 - n, -1).map((b) => b.min)); }),
    bollinger: (p = 20, mult = 2) => memoize(`bb${per(p, 'bollinger')}.${mult}`, () => {
      const c = closes(); if (c.length < p) return null;
      const x = c.slice(-p), mid = x.reduce((a, b) => a + b, 0) / p, sd = Math.sqrt(x.reduce((a, b) => a + (b - mid) ** 2, 0) / p);
      return { mid, upper: mid + mult * sd, lower: mid - mult * sd, width: (2 * mult * sd) / mid };
    }),
    back: (k = 1) => (Number.isInteger(k) && k >= 1 && index - k >= 0 ? makeCtx(allBars, index - k) : null), // the same view, k candles earlier (for crossovers)
  };
}

// Errors thrown by user code never crash the bot or the backtest: the candle is treated as "no signal" and the
// first message is remembered so the dashboard / report can say what went wrong.
const customErr = new Map(); // strategy id -> { count, message }
function customErrors(id) { return customErr.get(id) || null; }
function resetCustomErrors(id) { if (id === undefined) customErr.clear(); else customErr.delete(id); }
function runCustomFn(id, def, ctx) {
  const fail = (e) => {
    const cur = customErr.get(id) || { count: 0, message: e && e.message ? e.message : String(e) };
    cur.count++; customErr.set(id, cur);
    return 'none';
  };
  try {
    const r = def.fn(ctx);
    if (r && typeof r.then === 'function') return fail(new Error('signal() must not be async: it has to return \'buy\' or \'sell\' right away'));
    return r === 'buy' || r === 1 ? 'buy' : r === 'sell' || r === -1 ? 'sell' : r === 'none' ? 'none' : 'hold';
  } catch (e) { return fail(e); }
}

// ---------------------------------------------------------------------------
// Selectable entry strategies. cfg.strategy.id picks one; both the live bot and the
// backtester call strategySignal() below, so the two always agree on what a "buy"/"sell"
// trigger means. Whichever is chosen, everything else stays the same: the same risk sizing,
// stop-loss/take-profit, trend filter, correlation-group caps, and (if enabled) the same
// confluence confirmation filter — only how the raw buy/sell trigger fires is different.
const STRATEGIES = {
  rsi_dip: {
    name: 'اصلاح موقت (RSI)',
    description: 'وقتی قیمت خیلی سریع و بیش از حد افت می‌کند می‌خرد (به امید یک برگشت کوتاه)، و وقتی خیلی سریع و بیش از حد رشد می‌کند می‌فروشد. برای بازار نوسانی و بدون روند مشخص مناسب‌تر است؛ در یک روند قوی و یک‌طرفه ممکن است زود و بی‌موقع وارد شود.',
    usesRsiThreshold: true,
  },
  trend_ma: {
    name: 'دنبال‌کردن روند',
    description: 'وقتی میانگین کوتاه‌مدت قیمت از میانگین بلندمدت بالاتر می‌رود می‌خرد (یعنی روند تازه صعودی شده)، و وقتی برعکس می‌شود می‌فروشد. برای بازار پرروند مناسب‌تر است؛ در بازار بی‌روند و نوسانی ممکن است پشت سر هم اشتباه بزند.',
    usesRsiThreshold: false,
  },
  breakout: {
    name: 'شکست سطح',
    description: 'وقتی قیمت از بالاترین قیمت ۲۰ کندل اخیر بالاتر می‌زند می‌خرد (چون این معمولاً شروع یک حرکت بزرگ است)، و وقتی از پایین‌ترین قیمت ۲۰ کندل اخیر پایین‌تر می‌رود می‌فروشد. برای بازاری که گاه‌به‌گاه حرکت‌های قوی و ناگهانی دارد مناسب‌تر است.',
    usesRsiThreshold: false,
  },
  // ---- Combined setups: several of the strategies above must AGREE (a vote), instead of trusting one alone. ----
  // Each component gives a stance on the closed bar (bullish / bearish / neutral); see componentStance().
  // entryVotes = how many components must be bullish to buy; exitVotes = how many bearish ones close the trade.
  setup_trend_dip: {
    name: 'ستاپ: خرید اصلاح در روند صعودی',
    description: 'ترکیب «دنبال‌کردن روند» و «اصلاح موقت (RSI)»: فقط وقتی می‌خرد که هم روند کوتاه‌مدت صعودی باشد (میانگین ۱۰ بالای میانگین ۳۰) و هم RSI زیر ۴۰ باشد (یک عقب‌نشینی، نه سقوط کامل — آستانه‌ی ۳۰ در روند صعودی تقریباً هرگز دیده نمی‌شود)؛ یعنی «دیپِ داخل یک روند بالا». بسته شدن: وقتی روند کوتاه‌مدت برگردد پایین یا RSI به ناحیه‌ی اشباع خرید برسد. سیگنال‌ها کمتر ولی گزینش‌شده‌ترند.',
    usesRsiThreshold: false, rsiBuy: 40, components: ['trend_ma', 'rsi_dip'], entryVotes: 2, exitVotes: 1,
  },
  setup_breakout_momentum: {
    name: 'ستاپ: شکست با تأیید شتاب',
    description: 'ترکیب «شکست سطح» و «برگشت شتاب (MACD)»: شکست بالای سقف ۲۰ کندل اخیر فقط وقتی معتبر است که شتاب (MACD) هم مثبت باشد؛ از شکست‌های بی‌جان جلوگیری می‌کند. بسته شدن: وقتی هرکدام از دو نشانه منفی شود.',
    usesRsiThreshold: false, components: ['breakout', 'momentum_macd'], entryVotes: 2, exitVotes: 1,
  },
  setup_consensus: {
    name: 'ستاپ: اجماع چهار استراتژی',
    description: 'هر چهار استراتژی را رأی‌گیری می‌کند: خرید وقتی حداقل ۳ از ۴ هم‌نظر صعودی باشند، و بستن وقتی حداقل ۲ از ۴ نزولی شوند. کندتر و محتاط‌تر است؛ برای کم کردن سیگنال‌های کاذب.',
    usesRsiThreshold: true, components: ['rsi_dip', 'trend_ma', 'breakout', 'momentum_macd'], entryVotes: 3, exitVotes: 2,
  },
  momentum_macd: {
    name: 'برگشت شتاب',
    description: 'وقتی شتاب قیمت به سمت بالا برمی‌گردد می‌خرد، و وقتی به سمت پایین برمی‌گردد می‌فروشد (بر پایه‌ی MACD). واکنش کمی کندتر از RSI ولی معمولاً کم‌نویزتر است.',
    usesRsiThreshold: false,
  },
};

// Which reading(s) each strategy looks at, and whether it needs the previous bar's reading too
// (a crossover strategy does; a threshold/level strategy doesn't). Used by evalStrategy() below,
// and by anything (like the dashboard) that wants to know without hardcoding the list.
const STRATEGY_READS = {
  rsi_dip: { fields: ['rsi'], needsPrev: false },
  trend_ma: { fields: ['emaShort', 'emaLong'], needsPrev: true },
  breakout: { fields: ['close', 'hh', 'll'], needsPrev: false },
  momentum_macd: { fields: ['hist'], needsPrev: true },
};

// Combined setups read everything their components read. They vote on the CURRENT state of each component, so no previous bar.
// A custom (JavaScript) strategy reads through ctx instead of fixed fields; a combination containing one needs ctx too.
function computeReads(id) {
  const st = STRATEGIES[id];
  if (st.fn) STRATEGY_READS[id] = { fields: [], needsPrev: false, custom: true };
  else if (st.components) {
    const rs = st.components.map((c) => STRATEGY_READS[c]);
    STRATEGY_READS[id] = { fields: [...new Set(rs.flatMap((r) => r.fields))], needsPrev: false, custom: rs.some((r) => r.custom) };
  }
}
for (const id of Object.keys(STRATEGIES)) computeReads(id);

// Used by custom-strategies.js: adds / removes user-made strategies at runtime (the dashboard, the backtest worker thread
// and the live bot all read STRATEGIES / STRATEGY_READS live, so a registered strategy is usable everywhere at once).
function registerStrategy(id, def) { STRATEGIES[id] = def; computeReads(id); }
function unregisterStrategy(id) { delete STRATEGIES[id]; delete STRATEGY_READS[id]; customErr.delete(id); }

// Builds the exact curr/prev reading the chosen strategy needs (picking only the relevant fields out of
// whatever raw readings are supplied — the caller doesn't need to know which strategy needs what) and
// evaluates it. raw/prevRaw: whichever of { rsi, emaShort, emaLong, hist, close, hh, ll } are available.
// THIS is the one place, used by both server.js (live, one tick) and backtest.js (replay, one bar at a
// time), that decides what a signal is for each strategy — so the two can never quietly disagree.
function evalStrategy(id, raw, prevRaw, rsiCfg) {
  const r = STRATEGY_READS[id] || STRATEGY_READS.rsi_dip;
  const pick = (o) => { const out = {}; r.fields.forEach((f) => { out[f] = o ? o[f] : undefined; }); if (r.custom && o && o.ctx) out.ctx = o.ctx; return out; };
  return strategySignal(id, pick(raw), r.needsPrev ? pick(prevRaw) : null, rsiCfg);
}

// curr/prev: plain readings — whichever the chosen strategy needs, others are ignored:
//   rsi_dip: {rsi}   trend_ma: {emaShort, emaLong}   breakout: {close, hh, ll}   momentum_macd: {hist}
// Prefer evalStrategy() above over calling this directly — it builds curr/prev correctly from raw
// readings so nothing here needs to be duplicated at each call site.
// One component's stance on the current bar: 1 = bullish, -1 = bearish, 0 = neutral/unknown. These are LEVELS (the
// state right now), not one-bar crossings: a vote needs to know "is the trend up", not "did it just turn up".
function componentStance(id, c, rsiCfg) {
  const cd = STRATEGIES[id];
  if (cd && cd.fn) { if (!c.ctx) return 0; const g = runCustomFn(id, cd, c.ctx); return g === 'buy' ? 1 : g === 'sell' ? -1 : 0; } // custom: 'buy' = bullish right now, 'sell' = bearish right now
  if (id === 'trend_ma') return c.emaShort == null || c.emaLong == null ? 0 : c.emaShort > c.emaLong ? 1 : -1;
  if (id === 'breakout') return c.hh == null || c.ll == null ? 0 : c.close > c.hh ? 1 : c.close < c.ll ? -1 : 0;
  if (id === 'momentum_macd') return c.hist == null ? 0 : c.hist > 0 ? 1 : c.hist < 0 ? -1 : 0;
  if (c.rsi == null) return 0; // rsi_dip
  return c.rsi < rsiCfg.buy ? 1 : c.rsi > rsiCfg.sell ? -1 : 0;
}

function strategySignal(id, curr, prev, rsiCfg) {
  const def = STRATEGIES[id];
  if (!def) return 'none'; // an unknown / deleted strategy must never silently trade as some OTHER strategy
  if (def.fn) return curr && curr.ctx ? runCustomFn(id, def, curr.ctx) : 'none';
  if (def.components) {
    const rc = def.rsiBuy != null || def.rsiSell != null ? { ...rsiCfg, ...(def.rsiBuy != null ? { buy: def.rsiBuy } : {}), ...(def.rsiSell != null ? { sell: def.rsiSell } : {}) } : rsiCfg; // a setup may use its own dip level
    const st = def.components.map((cid) => componentStance(cid, curr, rc));
    const notReady = (cid) => { const r = STRATEGY_READS[cid]; return r.fields.length > 0 && curr[r.fields[0]] == null; };
    if (st.every((x) => x === 0) && def.components.some(notReady)) return 'none';
    const bull = st.filter((x) => x === 1).length, bear = st.filter((x) => x === -1).length;
    if (bear >= def.exitVotes) return 'sell';   // exits are checked first: when in doubt, get out
    if (bull >= def.entryVotes) return 'buy';
    return 'hold';
  }
  if (id === 'trend_ma') {
    if (curr.emaShort == null || curr.emaLong == null || !prev || prev.emaShort == null || prev.emaLong == null) return 'none';
    const wasUp = prev.emaShort > prev.emaLong, isUp = curr.emaShort > curr.emaLong;
    if (!wasUp && isUp) return 'buy';
    if (wasUp && !isUp) return 'sell';
    return 'hold';
  }
  if (id === 'breakout') {
    if (curr.hh == null || curr.ll == null) return 'none';
    if (curr.close > curr.hh) return 'buy';
    if (curr.close < curr.ll) return 'sell';
    return 'hold';
  }
  if (id === 'momentum_macd') {
    if (curr.hist == null || !prev || prev.hist == null) return 'none';
    if (prev.hist <= 0 && curr.hist > 0) return 'buy';
    if (prev.hist >= 0 && curr.hist < 0) return 'sell';
    return 'hold';
  }
  return signal(curr.rsi, rsiCfg); // rsi_dip (default)
}
// ---------------------------------------------------------------------------

function signal(r, { buy, sell }) {
  if (r === null) return 'none';
  if (r < buy) return 'buy';
  if (r > sell) return 'sell';
  return 'hold';
}

// Each extra check on its own: true / false, or null when it cannot be judged yet (no data).
//   MACD: the histogram must be TURNING in the trade's direction (rising for a buy, falling for a sell).
//   It is deliberately "turning", not "already positive": an RSI < 30 dip has a negative MACD histogram by
//   construction, so demanding a positive one would reject practically every real buy signal.
//   Volume: the trigger candle traded at least `volumeMult` x its recent average (real interest, not noise).
function checks(base, extra, volumeMult = 1.2) {
  const e = extra || {};
  const macdOk = e.macdHist != null && e.macdPrevHist != null
    ? (base === 'buy' ? e.macdHist > e.macdPrevHist : e.macdHist < e.macdPrevHist) : null;
  const volOk = e.volume != null && e.avgVol != null ? e.volume >= e.avgVol * volumeMult : null;
  return { macd: macdOk, volume: volOk };
}

// Confluence filter: the RSI crossing 30/70 (`base`) is the trigger, but it fires alone
// on every noisy wiggle. This requires extra indicators to agree before acting on it —
// like asking a couple of other opinions before moving, instead of trusting the first one.
//   extra: { macdHist, macdPrevHist, volume, avgVol }  (any can be null/undefined if unavailable)
//   opts:  cfg.confluence  { enabled, minConfirm, useMacd, useVolume, volumeMult }
// Returns the original `base` signal if confluence isn't required or isn't checkable yet,
// 'hold' if it is checkable but disagrees, or `base` again if enough checks confirm it.
function confluence(base, extra, opts) {
  if (base !== 'buy' && base !== 'sell') return base;
  if (!opts || !opts.enabled) return base;
  const c = checks(base, extra, opts.volumeMult ?? 1.2);
  const used = [opts.useMacd ? c.macd : null, opts.useVolume ? c.volume : null].filter((x) => x !== null);
  if (used.length === 0) return base; // nothing to check yet (not enough history) -> fall back to RSI alone
  const need = Math.min(opts.minConfirm ?? 1, used.length);
  return used.filter(Boolean).length >= need ? base : 'hold';
}

module.exports = {
  componentStance, rsi, ema, atr, macd, avgVolume, signal, checks, confluence,
  donchianHigh, donchianLow, STRATEGIES, STRATEGY_READS, strategySignal, evalStrategy,
  createEmaStream, createRsiStream, createAtrStream, createMacdStream, createVolumeStream,
  WINDOW, makeCtx, registerStrategy, unregisterStrategy, customErrors, resetCustomErrors, runCustomFn,
};
