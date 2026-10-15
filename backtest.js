// Backtester: replays the same strategy + risk rules on historical candles.
// Used both by the CLI (npm run backtest / npm run sweep) and by the dashboard's
// "Backtest" tab (server.js runs it on a worker thread via backtest-runner.js).
//   node backtest.js                      -> full report with your config.js settings
//   node backtest.js --sweep              -> tries many settings, checks them on unseen data
//   options: --tf 60  --candles 3000  --symbols BINANCE:BTCUSDT,NASDAQ:AAPL  --refresh
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fsutil');
const cfg = require('./config');
const T = require('./trials');
const { rsi, ema, atr, macd, avgVolume, checks, confluence, STRATEGIES, STRATEGY_READS, strategySignal, donchianHigh, donchianLow, makeCtx, customErrors, resetCustomErrors } = require('./strategy');
const store = require('./candle-store');
const { tradeStats, maxDrawdownPct, regimeOf, rng: seededRng, seedFrom, MIN_BLOCKS } = require('./significance');
const { costsFor, sizePosition, groupBlockReason } = require('./risk');

const TV_MAX = 20000; // most candles asked from TradingView in one request; older history comes from the archive (see history-import.js)
const WINDOW = 300; // same history window the live bot sees (chart range in server.js)
const DATA = process.env.DATA_DIR || __dirname; // same folder as state.json / events.log (a Docker volume when DATA_DIR is set)
const DEFAULT_CACHE = process.env.BT_CACHE || path.join(DATA, 'backtest-cache');
const CACHE_MAX_AGE_MS = 12 * 3600 * 1000; // downloaded candles older than this are fetched again
const emit = (opts, p) => { if (opts && opts.onProgress) opts.onProgress(p); };

// ---------------- data ----------------
const cacheFile = (dir, s, tf, n) => path.join(dir, `${s.replace(/[^A-Za-z0-9]/g, '_')}_${tf}_${n}.json`);

function fetchBars(client, symbol, tf, n) {
  return new Promise((resolve) => {
    const chart = new client.Session.Chart();
    let timer, done = false;
    const finish = () => {
      if (done) return; done = true; clearTimeout(timer);
      const bars = (chart.periods || []).slice().reverse();
      chart.delete(); resolve(bars);
    };
    const hard = setTimeout(finish, 40000);
    chart.setMarket(symbol, { timeframe: tf, range: n });
    chart.onError((...e) => { console.error(symbol, ...e); finish(); });
    chart.onUpdate(() => {
      if (chart.periods.length >= n) return finish();
      clearTimeout(timer); timer = setTimeout(() => { clearTimeout(hard); finish(); }, 4000);
    });
  });
}

// Downloads (in parallel, a few symbols at a time) whatever is not already cached and fresh.
// onProgress({phase:'data', symbol, state:'cached'|'downloading'|'done', done, total}) lets the caller show status.
// Returns { data: {symbol: bars}, stamps: {symbol: cache-file mtime} } (stamps identify a data version for caching).
async function loadAll({ symbols, tf, candles, cacheDir = DEFAULT_CACHE, refresh = false, onProgress, concurrency = 6 }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const data = {}, stamps = {}, todo = [];
  let done = 0;
  const note = (symbol, state) => emit({ onProgress }, { phase: 'data', symbol, state, done, total: symbols.length });
  for (const s of symbols) {
    const f = cacheFile(cacheDir, s, tf, candles);
    let fresh = false;
    if (!refresh && fs.existsSync(f)) { const st = fs.statSync(f); fresh = Date.now() - st.mtimeMs < CACHE_MAX_AGE_MS; if (fresh) stamps[s] = st.mtimeMs; }
    if (fresh) { data[s] = JSON.parse(fs.readFileSync(f, 'utf8')); done++; note(s, 'cached'); } else todo.push(s);
  }
  if (todo.length) {
    const client = new (require('@mathieuc/tradingview').Client)();
    let next = 0;
    const lane = async () => {
      while (next < todo.length) {
        const s = todo[next++];
        note(s, 'downloading');
        let bars = await fetchBars(client, s, tf, Math.min(candles, TV_MAX));
        if (bars.length) { store.merge(s, tf, bars.slice(0, -1)); bars = store.combine(s, tf, bars, candles); } // keep what we saw, and use older archived candles the feed no longer offers
        const f = cacheFile(cacheDir, s, tf, candles);
        if (bars.length) { atomicWrite(f, JSON.stringify(bars)); stamps[s] = fs.statSync(f).mtimeMs; data[s] = bars; }
        else if (fs.existsSync(f)) { data[s] = JSON.parse(fs.readFileSync(f, 'utf8')); stamps[s] = fs.statSync(f).mtimeMs; } // download failed: better old candles than none
        else { const arch = store.read(s, tf); data[s] = arch.length ? arch.slice(-candles) : bars; } // nothing downloaded and no cache: our own archive is better than nothing
        done++; note(s, 'done');
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, lane));
    client.end();
  }
  const ordered = {};
  symbols.forEach((s) => { ordered[s] = data[s] || []; });
  return { data: ordered, stamps };
}

// RSI is needed on every candle (it is the trigger), but ATR / trend EMA / MACD / average volume are only
// looked at on the few candles where a signal actually fires — so they are computed on demand and remembered.
// Every value is computed exactly as the live bot would (same 300-candle window), just not up front.
function prepare(bars, rsiCfg, riskCfg) {
  const n = bars.length, closes = bars.map((b) => b.close);
  const lo = (i) => Math.max(0, i - WINDOW + 1);
  const rs = new Array(n);
  for (let i = 0; i < n; i++) rs[i] = rsi(closes.slice(lo(i), i + 1), rsiCfg.period);
  const memo = (fn) => { const c = new Array(n); return (i) => (c[i] !== undefined ? c[i] : (c[i] = fn(i))); };
  return {
    bars, rs,
    at: memo((i) => atr(bars.slice(lo(i), i + 1), riskCfg.atrPeriod)),
    em: memo((i) => ema(closes.slice(lo(i), i + 1), riskCfg.trendEma)),
    mh: memo((i) => { const m = macd(closes.slice(lo(i), i + 1)); return m ? m.hist : null; }),
    av: memo((i) => avgVolume(bars.slice(lo(i), i + 1), 20)),
    // only used by non-default strategies (trend_ma / breakout); computed lazily so rsi_dip backtests pay nothing for these
    esh: memo((i) => ema(closes.slice(lo(i), i + 1), 10)),
    elg: memo((i) => ema(closes.slice(lo(i), i + 1), 30)),
    hh: memo((i) => donchianHigh(bars.slice(Math.max(0, i - 20), i), 20)), // the 20 bars strictly BEFORE i — never looks at bar i itself
    ll: memo((i) => donchianLow(bars.slice(Math.max(0, i - 20), i), 20)),
  };
}

// Prepared data is reused between runs while the cached candle file is unchanged.
const prepCache = new Map();
function buildPrep(loaded, opts, base = cfg) {
  const prep = {}, skipped = [];
  // rsi.period / risk.atrPeriod / risk.trendEma change what prepare() computes, so they're part of the cache key
  // too (atrMult/takeProfitRR/rsi.buy/confluence.* only affect the decision layer in run(), not prepare()).
  const sig = `${base.rsi.period}|${base.risk.atrPeriod}|${base.risk.trendEma}`;
  for (const s of opts.symbols) {
    const bars = loaded.data[s];
    if (!bars || bars.length <= WINDOW / 2) { skipped.push({ symbol: s, candles: bars ? bars.length : 0 }); continue; }
    const key = `${s}|${opts.tf}|${opts.candles}|${loaded.stamps[s] || 'x'}|${bars.length}|${sig}`;
    if (!prepCache.has(key)) { if (prepCache.size > 80) prepCache.clear(); prepCache.set(key, prepare(bars, base.rsi, base.risk)); }
    prep[s] = prepCache.get(key);
  }
  return { prep, skipped };
}

// ---------------- engine ----------------
const tlCache = new WeakMap(); // per prepared data set, so different runs never share a timeline

// Which bars of each symbol belong to the slice [from, to) of the test? Returns [[a, z), ...] per symbol (z exclusive).
// ONE symbol: a plain fraction of its own bars (same as always).
// SEVERAL symbols: the fraction is a fraction of the CALENDAR (earliest bar .. latest bar of all symbols), identical for every
// symbol. Cutting each symbol by its own bar count put "the last 30%" / "fold 3" on different dates for symbols with
// different bars per day (24/7 crypto vs stocks that close at night), which mixed different periods inside one portfolio
// (shared position limits, group caps, drawdown halt) and made the train/test/walk-forward splits mean different things.
// Consecutive slices share their cut time, so folds never overlap and never leave a gap. A symbol whose history is shorter
// simply has no bars in the early slices.
function ranges(prep, from, to) {
  const keys = Object.keys(prep);
  if (keys.length <= 1) return keys.map((s) => { const n = prep[s].bars.length; return [Math.floor(n * from), Math.floor(n * to)]; });
  let t0 = Infinity, t1 = -Infinity;
  for (const s of keys) { const b = prep[s].bars; t0 = Math.min(t0, b[0].time); t1 = Math.max(t1, b[b.length - 1].time); }
  const cut = (f) => (f <= 0 ? -Infinity : f >= 1 ? Infinity : t0 + f * (t1 - t0));
  const lower = (bars, t) => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].time < t) lo = m + 1; else hi = m; } return lo; };
  const cf = cut(from), ct = cut(to);
  return keys.map((s) => { const b = prep[s].bars; return [lower(b, cf), lower(b, ct)]; });
}

function timeline(prep, from, to) {
  let m = tlCache.get(prep);
  if (!m) { m = new Map(); tlCache.set(prep, m); }
  const key = `${from}-${to}`;
  if (m.has(key)) return m.get(key);
  const tl = [], rg = ranges(prep, from, to);
  Object.keys(prep).forEach((s, k) => {
    for (let i = rg[k][0]; i < rg[k][1]; i++) tl.push([prep[s].bars[i].time, k, i]);
  });
  tl.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  m.set(key, tl);
  return tl;
}

// base = { risk, rsi, confluence } to test/report against. Defaults to config.js, but the dashboard's worker
// thread always passes the CURRENT live settings explicitly (see backtest-runner.js) — a worker thread has
// its own separate copy of config.js, so without this, applying a new setting wouldn't be seen here until
// the worker thread happened to restart.
function run(prep, from = 0, to = 1, over = {}, base = cfg) {
  const R = { ...base.risk, ...(over.risk || {}) }, RS = { ...base.rsi, ...(over.rsi || {}) };
  const CF = { ...base.confluence, ...(over.confluence || {}) };
  const SID = (over.strategy && over.strategy.id) || base.strategy.id;
  const READS = STRATEGY_READS[SID] || STRATEGY_READS.rsi_dip;
  const capital = cfg.paper.balance, syms = Object.keys(prep);
  // Costs differ by market (crypto fee, forex spread...), so they are looked up per symbol, not one global number.
  const costOf = (s) => { const c = costsFor(s, R); return { feeM: c.feePct / 100, slip: c.slippagePct / 100 }; };
  // Realistic fills: a signal is only KNOWN when its candle has closed, so the order can only fill at the NEXT candle's
  // open. fillMode 'close' keeps the old optimistic "filled at the very close that made the signal" for comparison.
  const NEXT_OPEN = (R.fillMode || 'next_open') !== 'close';
  const pending = {}; // symbol -> order decided at a candle close, waiting for the next candle's open
  let cash = capital, peak = capital, dayKey = '', dayStart = capital, dailyHalt = false, ddHalt = false, maxDD = 0, lastT = 0;
  const pos = {}, cool = {}, last = {}, prevSig = {}, trades = [], curve = [];
  // Where do buy signals die? Sequential counts (each stage only sees what survived the one before)
  // plus, independently, how often each filter alone would have passed (so the real culprit is obvious).
  const funnel = { edges: 0, confirmed: 0, limits: 0, trend: 0, noAtr: 0, small: 0, group: 0, opened: 0, macdN: 0, macdOk: 0, volN: 0, volOk: 0, trendN: 0, trendOk: 0 };
  const equity = () => { let e = cash; for (const s in pos) e += pos[s].qty * (last[s] ?? pos[s].entry); return e; };

  const closeTrade = (s, px, t, reason) => {
    const p = pos[s], { feeM, slip } = costOf(s), fill = px * (1 - slip), proceeds = p.qty * fill * (1 - feeM), pnl = proceeds - p.cost;
    cash += proceeds; delete pos[s]; cool[s] = t + R.cooldownMin * 60;
    trades.push({ symbol: s, entryTime: p.t, exitTime: t, entry: p.entry, exit: fill, qty: p.qty, pnl, pct: pnl / p.cost * 100, r: pnl / p.risk, reason });
  };

  // Staged exit: bank part of the position at the nearer tp1, free the rest from the original fixed target
  // (it rides the trailing stop instead), same mechanism as the live bot. Never deletes pos[s] itself — a
  // closePct of (near) 100% is routed through closeTrade so a dust-sized "open" position is never left behind.
  const partialCloseTrade = (s, px, t) => {
    const p = pos[s], pct = R.partialExit.closePct / 100;
    if (pct >= 0.995) return closeTrade(s, px, t, 'take-profit (partial = 100%)');
    if (pct <= 0) { p.partialDone = true; return; }
    const qty = p.qty * pct, { feeM, slip } = costOf(s), fill = px * (1 - slip), proceeds = qty * fill * (1 - feeM);
    const costPortion = p.cost * pct, riskPortion = p.risk * pct, pnl = proceeds - costPortion;
    cash += proceeds;
    trades.push({ symbol: s, entryTime: p.t, exitTime: t, entry: p.entry, exit: fill, qty, pnl, pct: pnl / costPortion * 100, r: pnl / riskPortion, reason: 'partial take-profit' });
    p.qty -= qty; p.cost -= costPortion; p.risk -= riskPortion; p.partialDone = true;
    if (R.partialExit.moveStopToBreakeven) p.sl = Math.max(p.sl, p.entry);
    if (R.trailing) p.tp = Infinity;
  };

  // Opens a long at price `px` (this candle's close in 'close' mode, the next candle's open in 'next_open' mode).
  const openLong = (s, px, atrV, t) => {
    const { feeM, slip } = costOf(s), eq = equity();
    const { qty, dist } = sizePosition({ equity: eq, cash, price: px, atrVal: atrV, R: { ...R, ...costOf2(s) } });
    if (qty * px < R.minNotional) funnel.small++;
    else if (groupBlockReason(pos, last, s, eq, qty * px, R)) funnel.group++;
    else {
      const fill = px * (1 + slip), spend = qty * fill * (1 + feeM);
      cash -= spend; funnel.opened++;
      const tp1 = R.partialExit.enabled ? fill + dist * R.partialExit.atR : null;
      pos[s] = { qty, entry: fill, sl: fill - dist, tp: fill + dist * R.takeProfitRR, dist, peak: fill, cost: spend, risk: qty * dist, t, tp1, partialDone: false };
    }
  };
  const costOf2 = (s) => { const c = costsFor(s, R); return { feePct: c.feePct, slippagePct: c.slippagePct }; };

  const tl = timeline(prep, from, to);
  const step = over.curve ? Math.max(1, Math.ceil(tl.length / 300)) : 0; // equity curve, sampled to ~300 points
  for (let x = 0; x < tl.length; x++) {
    const [t, k, i] = tl[x];
    const s = syms[k], { bars, rs, at, em, mh, av, esh, elg, hh, ll } = prep[s], b = bars[i];
    // Orders decided at the PREVIOUS candle's close fill now, at this candle's open (before anything else this candle).
    const po = pending[s];
    if (po) {
      delete pending[s];
      if (po.type === 'sell') { if (pos[s]) closeTrade(s, b.open, t, 'RSI sell signal'); }
      else if (!pos[s]) {
        const blocked = ddHalt || dailyHalt || Object.keys(pos).length >= R.maxOpenPositions;
        if (blocked) funnel.limits++; else openLong(s, b.open, po.atr, t);
      }
    }
    last[s] = b.close; lastT = t;
    const day = new Date(t * 1000).toISOString().slice(0, 10);
    if (day !== dayKey) { dayKey = day; dayStart = equity(); dailyHalt = false; }

    let p = pos[s];
    if (p) { // exits, judged conservatively: stop is checked before target within a candle
      // partial exit first, at the nearer tp1 — same stop-before-target priority as the main check below.
      // Deliberately does NOT also check the (possibly just-updated) full exit within this same candle;
      // that's picked up on the next candle, a small conservative simplification of an already-approximate
      // same-candle sequencing (OHLC alone can't say which level was actually touched first).
      if (R.partialExit.enabled && p.tp1 != null && !p.partialDone) {
        const slName0 = p.sl >= p.entry ? 'trailing stop' : 'stop-loss';
        let px0 = null, why0 = '';
        if (b.open <= p.sl) { px0 = b.open; why0 = slName0; }
        else if (b.open >= p.tp1) { px0 = b.open; why0 = 'partial'; }
        else if (b.min <= p.sl) { px0 = p.sl; why0 = slName0; }
        else if (b.max >= p.tp1) { px0 = p.tp1; why0 = 'partial'; }
        if (why0 === 'partial') partialCloseTrade(s, px0, t);
        else if (px0 !== null) closeTrade(s, px0, t, why0);
      }
      p = pos[s]; // a full stop just above, or a partial reducing it to dust, may have already removed it
      if (p) {
        const slName = p.sl >= p.entry ? 'trailing stop' : 'stop-loss';
        let px = null, why = '';
        if (b.open <= p.sl) { px = b.open; why = slName; }
        else if (b.open >= p.tp) { px = b.open; why = 'take-profit'; }
        else if (b.min <= p.sl) { px = p.sl; why = slName; }
        else if (b.max >= p.tp) { px = p.tp; why = 'take-profit'; }
        if (px !== null) closeTrade(s, px, t, why);
        else {
          p.peak = Math.max(p.peak, b.max);
          if (R.trailing && p.peak - p.entry >= p.dist) p.sl = Math.max(p.sl, p.entry, p.peak - p.dist);
        }
      }
    }

    // RSI cross is the trigger (edge-detected, same as the live bot); confluence() then decides
    // whether MACD/volume agree enough to actually act on it.
    // Build exactly the readings the chosen strategy (or combined setup) needs — one generic path, no per-strategy special cases,
    // so adding a strategy in strategy.js can never silently disagree with what the backtester feeds it.
    const readAt = (j) => {
      const o = {};
      if (READS.custom) o.ctx = makeCtx(bars, j); // custom (JavaScript) strategies: indicators on demand, never past candle j
      for (const f of READS.fields) {
        o[f] = f === 'rsi' ? rs[j] : f === 'emaShort' ? esh(j) : f === 'emaLong' ? elg(j) : f === 'hist' ? mh(j)
          : f === 'close' ? bars[j].close : f === 'hh' ? hh(j) : ll(j);
      }
      return o;
    };
    const curr = readAt(i), prevv = READS.needsPrev && i > 0 ? readAt(i - 1) : null;
    const sig = strategySignal(SID, curr, prevv, RS);
    const before = prevSig[s]; prevSig[s] = sig;
    // only look at the (lazily computed) extra indicators when a signal could actually lead to an action
    if (before !== undefined && sig !== before && ((sig === 'sell' && pos[s]) || (sig === 'buy' && !pos[s]))) {
      const extra = { macdHist: mh(i), macdPrevHist: i > 0 ? mh(i - 1) : null, volume: b.volume, avgVol: av(i) };
      const filtered = confluence(sig, extra, CF);
      const emaV = sig === 'buy' ? em(i) : null;
      if (sig === 'buy') {
        funnel.edges++;
        const c = checks('buy', extra, CF.volumeMult);
        if (c.macd !== null) { funnel.macdN++; if (c.macd) funnel.macdOk++; }
        if (c.volume !== null) { funnel.volN++; if (c.volume) funnel.volOk++; }
        if (emaV !== null) { funnel.trendN++; if (b.close > emaV) funnel.trendOk++; }
        if (filtered === 'buy') funnel.confirmed++;
      }
      if (filtered === 'sell') { if (NEXT_OPEN) pending[s] = { type: 'sell' }; else closeTrade(s, b.close, t, 'RSI sell signal'); }
      else if (filtered === 'buy') {
        const blocked = ddHalt || dailyHalt || Object.keys(pos).length >= R.maxOpenPositions || t < (cool[s] || 0);
        const atrV = at(i);
        if (blocked) funnel.limits++;
        else if (R.trendFilter && !(emaV !== null && b.close > emaV)) funnel.trend++;
        else if (!atrV) funnel.noAtr++;
        else if (NEXT_OPEN) pending[s] = { type: 'buy', atr: atrV };
        else openLong(s, b.close, atrV, t);
      }
    }

    const eq = equity(); peak = Math.max(peak, eq);
    const dd = (peak - eq) / peak * 100; maxDD = Math.max(maxDD, dd);
    if (dd >= R.maxDrawdownPct) ddHalt = true;
    if ((dayStart - eq) / dayStart * 100 >= R.dailyLossLimitPct) dailyHalt = true;
    if (step && x % step === 0) curve.push([t, eq]);
  }
  for (const s of Object.keys(pos)) closeTrade(s, last[s], lastT, 'end of test');
  if (step) curve.push([lastT, cash]);

  const rgBH = ranges(prep, from, to), bh = [];
  syms.forEach((s, k) => { const [a, z] = rgBH[k]; if (z > a) bh.push(prep[s].bars[z - 1].close / prep[s].bars[a].close - 1); }); // a symbol with no bars in this slice is left out
  return { trades, curve, funnel, capital, endEq: cash, maxDD, ddHalt, buyHold: bh.length ? bh.reduce((x, y) => x + y, 0) / bh.length * 100 : 0 };
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
function summarize(res) {
  const t = res.trades, n = t.length, w = t.filter((x) => x.pnl > 0);
  const gw = sum(w.map((x) => x.pnl)), gl = Math.abs(sum(t.filter((x) => x.pnl <= 0).map((x) => x.pnl)));
  let streak = 0, worst = 0;
  t.slice().sort((a, b) => a.exitTime - b.exitTime).forEach((x) => { streak = x.pnl <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak); });
  return {
    n, ret: (res.endEq / res.capital - 1) * 100, maxDD: res.maxDD, ddHalt: res.ddHalt, buyHold: res.buyHold,
    winRate: n ? w.length / n * 100 : 0, pf: gl ? gw / gl : gw > 0 ? Infinity : 0,
    avgR: n ? sum(t.map((x) => x.r)) / n : 0, worstStreak: worst,
    startCapital: res.capital, endEquity: res.endEq,
  };
}

// ---------------- validation: is this a real edge, or just one lucky run? ----------------

// Walk-forward: instead of one 70/30 split, test the SAME fixed setting on several separate, consecutive,
// non-overlapping time segments (default 5). A setting that only worked in one segment and lost in the others
// was never reliable — it just happened to suit whatever few months that one split landed on.
function walkForward(prep, over, base, folds = 5, lo = 0, hi = 1) {
  const edges = Array.from({ length: folds + 1 }, (_, k) => lo + (hi - lo) * k / folds);
  const windows = edges.slice(0, -1).map((from, k) => {
    const r = summarize(run(prep, from, edges[k + 1], over, base));
    return { from, to: edges[k + 1], ret: r.ret, trades: r.n, maxDD: r.maxDD, winRate: r.winRate };
  });
  const rets = windows.map((w) => w.ret);
  return {
    folds, windows,
    profitableFolds: windows.filter((w) => w.ret > 0).length,
    worstFoldRet: Math.min(...rets), avgFoldRet: sum(rets) / folds,
    totalTrades: sum(windows.map((w) => w.trades)),
  };
}

// Monte Carlo: the backtest only shows ONE path the trades happened to fall into. Build many alternate paths
// by resampling WITH replacement from this same set of trade outcomes (bootstrap) — each simulated path reuses
// some trades more than once and skips others, approximating "another similar stretch of trading with this
// strategy's actual win/loss mix". This is NOT a plain reshuffle: a reshuffle only reorders the same fixed set,
// and since addition is commutative, that makes the FINAL return mathematically identical in every single
// reshuffle (only drawdown/streak would vary, and probLoss would degenerate to a flat 0% or 100%) — reshuffling
// alone cannot show what it claims to. Resampling actually varies the final return too, so every percentile
// below is a real distribution, not a repeated constant.
function monteCarlo(trades, capital, iterations = 1000) {
  if (!trades || trades.length < 10) return null; // too few trades for the percentiles below to mean anything
  const pnls = trades.map((t) => t.pnl), n = pnls.length;
  // seeded from the trades themselves: the same trades always give the same percentiles (before, every click gave slightly different numbers)
  const rand = seededRng(seedFrom(pnls, 53)), finals = [], maxDDs = [], streaks = [];
  for (let it = 0; it < iterations; it++) {
    let eq = capital, peak = capital, dd = 0, streak = 0, worst = 0;
    for (let i = 0; i < n; i++) {
      const pnl = pnls[Math.floor(rand() * n)]; // sample WITH replacement
      eq += pnl; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak * 100);
      streak = pnl <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak);
    }
    finals.push((eq / capital - 1) * 100); maxDDs.push(dd); streaks.push(worst);
  }
  finals.sort((a, b) => a - b); maxDDs.sort((a, b) => a - b); streaks.sort((a, b) => a - b);
  const at = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return {
    iterations, trades: n, actualRet: (sum(pnls) / capital) * 100, // the real observed order, for comparison
    retP5: at(finals, 0.05), retP25: at(finals, 0.25), retMedian: at(finals, 0.5), retP75: at(finals, 0.75), retP95: at(finals, 0.95),
    ddMedian: at(maxDDs, 0.5), ddP95: at(maxDDs, 0.95), ddWorst: maxDDs[maxDDs.length - 1],
    streakP95: at(streaks, 0.95), streakWorst: streaks[streaks.length - 1],
    probLoss: finals.filter((r) => r < 0).length / iterations * 100,
  };
}

// JSON-friendly report: meta + summary + per-symbol breakdown + exit reasons + train/test split check.
// Used by both the CLI printer and the dashboard's /api/backtest endpoint.
function buildReport(prep, tf, base = cfg) {
  const res = run(prep, 0, 1, { curve: true }, base);
  const s = summarize(res), tt = res.trades;
  const times = Object.values(prep).flatMap((p) => [p.bars[0].time, p.bars[p.bars.length - 1].time]);
  const d = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const bySymbol = Object.keys(prep).map((sym) => {
    const x = tt.filter((y) => y.symbol === sym);
    return { symbol: sym, trades: x.length, winPct: x.length ? x.filter((y) => y.pnl > 0).length / x.length * 100 : null, pnl: sum(x.map((y) => y.pnl)) };
  });
  const exits = {}; tt.forEach((x) => { exits[x.reason] = (exits[x.reason] || 0) + 1; });
  const a = summarize(run(prep, 0, 0.7, {}, base)), b = summarize(run(prep, 0.7, 1, {}, base));
  // the same data with each filter switched off, so the effect of every filter is visible at a glance
  const sc = (label, over) => { const r = summarize(run(prep, 0, 1, over, base)); return { label, trades: r.n, ret: r.ret, maxDD: r.maxDD, winRate: r.winRate }; };
  const scenarios = [
    sc('تنظیمات فعلی', {}),
    sc('بدون فیلتر تأیید (فقط سیگنال اصلی استراتژی)', { confluence: { enabled: false } }),
    sc('بدون فیلتر روند', { risk: { trendFilter: false } }),
    sc('بدون هر دو فیلتر', { confluence: { enabled: false }, risk: { trendFilter: false } }),
  ];
  const sid = base.strategy.id;
  return {
    meta: { symbols: Object.keys(prep).length, tf, from: d(Math.min(...times)), to: d(Math.max(...times)) },
    strategy: { id: sid, name: STRATEGIES[sid] ? STRATEGIES[sid].name : sid },
    summary: s, bySymbol, exits,
    split: { first70: { ret: a.ret, trades: a.n }, last30: { ret: b.ret, trades: b.n } },
    walkForward: walkForward(prep, {}, base, 5), // same setting, tested on 5 separate time segments — not just one split
    monteCarlo: monteCarlo(tt, s.startCapital, 1000), // same trades, 1000 random orders — null if too few trades
    curve: res.curve, // [[unix time, equity], ...] ~300 points
    funnel: res.funnel, scenarios,
    trades: tt,
  };
}

// Confluence variants tried by the sweep. Off, each check alone, both together (1 confirm = either is enough),
// and both required (2 = strict) — this is the lever that most often decides whether a setting trades at all.
const CONFLUENCE_VARIANTS = [
  { enabled: false },
  { enabled: true, minConfirm: 1, useMacd: true, useVolume: false },
  { enabled: true, minConfirm: 1, useMacd: false, useVolume: true },
  { enabled: true, minConfirm: 1, useMacd: true, useVolume: true },
  { enabled: true, minConfirm: 2, useMacd: true, useVolume: true },
];

// every setting combination a Sweep tries (also what the research ledger counts, see trials.js)
function sweepGrid(base) {
  const sid = base.strategy.id;
  const strat = STRATEGIES[sid] || STRATEGIES.rsi_dip;
  // rsi.buy only matters to the rsi_dip strategy — sweeping it for the others would just run the same
  // backtest 3x over for no reason, since their trigger doesn't look at it at all.
  const rsiRange = strat.usesRsiThreshold ? [25, 30, 35] : [30];
  const grid = [];
  for (const atrMult of [1.5, 2, 3]) for (const rr of [1.5, 2, 3]) for (const buy of rsiRange) for (const trailing of [true, false]) for (const confluenceOv of CONFLUENCE_VARIANTS)
    grid.push({ risk: { atrMult, takeProfitRR: rr, trailing }, rsi: { buy }, confluence: confluenceOv, strategy: { id: sid } });
  return grid;
}
// the settings actually in force when a grid point `o` is applied on top of `base`
const effBase = (base, o) => ({ ...base, risk: { ...base.risk, ...o.risk }, rsi: { ...base.rsi, ...o.rsi }, confluence: { ...base.confluence, ...o.confluence } });

// The last SWEEP_HOLD share of the data is kept out of EVERY selection decision of a Sweep. Ranking, the 70/30 train/test screen and
// walk-forward all happen on the earlier part only; the single best candidate is then run ONCE on the kept-out part. Before this,
// the "test" 30% took part in the ranking and walk-forward ran over the same data the winner was picked on, so a "recommended"
// setting had never really been tried on anything it had not been chosen on (on pure random data it still appeared in ~9% of runs).
const SWEEP_HOLD = 0.25;

function buildSweep(prep, onProgress, base = cfg) {
  const sid = base.strategy.id;
  const strat = STRATEGIES[sid] || STRATEGIES.rsi_dip;
  const grid = sweepGrid(base);
  const H = 1 - SWEEP_HOLD;       // selection data = [0, H]; hold-out = [H, 1]
  const split = H * 0.7;          // inside the selection data: train = [0, split], test = [split, H]
  const rows = grid.map((o, x) => {
    const row = { o, a: summarize(run(prep, 0, split, o, base)), b: summarize(run(prep, split, H, o, base)) };
    if (onProgress && x % 10 === 9) onProgress({ phase: 'sweep', done: x + 1, total: grid.length });
    return row;
  }).filter((r) => r.a.n >= 10);
  const noOver = { risk: {}, rsi: {}, confluence: {} }; // no override at all -> run() falls back to `base` as-is
  const current = {
    o: {
      risk: { atrMult: base.risk.atrMult, takeProfitRR: base.risk.takeProfitRR, trailing: base.risk.trailing },
      rsi: { buy: base.rsi.buy },
      confluence: { enabled: base.confluence.enabled, minConfirm: base.confluence.minConfirm, useMacd: base.confluence.useMacd, useVolume: base.confluence.useVolume },
      strategy: { id: sid },
    },
    a: summarize(run(prep, 0, split, noOver, base)), b: summarize(run(prep, split, H, noOver, base)),
  };
  const label = (o) => {
    const c = o.confluence.enabled ? `تأیید(${o.confluence.minConfirm} از ${[o.confluence.useMacd && 'MACD', o.confluence.useVolume && 'حجم'].filter(Boolean).length})` : 'بدون فیلتر تأیید';
    const rsiPart = strat.usesRsiThreshold ? ` RSI<${o.rsi.buy}` : '';
    return `ATR x${o.risk.atrMult} RR ${o.risk.takeProfitRR} trail ${o.risk.trailing ? 'on' : 'off'}${rsiPart} | ${c}`;
  };
  const row = (r) => ({
    label: label(r.o), settings: r.o, trainRet: r.a.ret, trainDD: r.a.maxDD, trainTrades: r.a.n, testRet: r.b.ret, testDD: r.b.maxDD, testTrades: r.b.n,
    walkForward: r.wf, // attached below, only for the shortlist — running this on all 270 grid rows would be wasteful
  });

  // "best" = does well on BOTH halves of the selection data, not just on the training half (that would just be overfitting).
  // score = the weaker of the two returns, divided by the worse of the two drawdowns.
  const scored = rows.map((r) => ({ ...r, score: Math.min(r.a.ret, r.b.ret) / Math.max(r.a.maxDD, r.b.maxDD, 1) }))
    .sort((x, y) => y.score - x.score);
  // Walk-forward (5 separate segments of the SELECTION data) only for the shortlist: current config.js plus the top 5.
  current.wf = walkForward(prep, current.o, base, 5, 0, H);
  scored.slice(0, 5).forEach((r) => { r.wf = walkForward(prep, r.o, base, 5, 0, H); });

  const top = scored.slice(0, 5).map(row);
  const best = scored[0];
  const wfOk = (wf) => wf && wf.profitableFolds >= Math.ceil(wf.folds * 0.6);
  // A recommendation must clear ALL of these, in this order (the kept-out data is only looked at if everything before it passed,
  // so it is looked at as rarely as possible):
  //   1. weak:         good on train AND test of the selection data, with enough trades
  //   2. inconsistent: profitable in most of the 5 walk-forward segments
  //   3. luck:         after correcting for the number of settings compared (Bonferroni over every setting that had enough trades —
  //                    deliberately strict: neighbouring settings are correlated, so this over-counts rather than under-counts luck),
  //                    the chance that this result is just luck must be at most RELIABILITY.maxPAdj
  //   4. holdout:      one run on the kept-out data must confirm it (positive return, PF >= 1, positive avg R, >= 10 trades)
  let reason = !rows.length || !best ? 'nomatch' : null, hv = null, stat = null, peek = null;
  if (!reason && !(best.b.n >= 8 && best.b.ret > 0 && best.a.ret > 0)) reason = 'weak';
  if (!reason && !wfOk(best.wf)) reason = 'inconsistent';
  if (!reason) {
    stat = tradeStats(run(prep, 0, H, best.o, base).trades, rows.length);
    if (!stat || stat.pAdj === null || stat.pAdj > RELIABILITY.maxPAdj) reason = 'luck';
  }
  if (!reason) {
    peek = best.o;
    hv = holdoutVerdict(summarize(run(prep, H, 1, best.o, base)));
    if (hv.status === 'failed') reason = 'holdout_failed';
    else if (hv.status === 'inconclusive') reason = 'holdout_inconclusive';
  }
  const statOut = stat ? { tests: stat.tests, p: stat.p, pAdj: stat.pAdj, ci: stat.ci, blocks: stat.blocks, blockDays: stat.blockDays, fewBlocks: stat.fewBlocks } : null;
  return {
    total: grid.length, strategy: { id: sid, name: strat.name }, top, current: { label: 'config.js فعلی', ...row(current) },
    recommended: !reason ? { ...row(best), holdout: hv, stat: statOut } : null,
    noRecommendationReason: reason,
    holdFraction: SWEEP_HOLD, comparedSettings: rows.length, holdout: hv, stat: statOut,
    _peek: peek, // internal: which settings looked at the kept-out data (runSweep records it in the ledger, then removes this)
  };
}

// ---------------- one call for the CLI or the dashboard ----------------
// opts: { symbols, tf, candles, cacheDir, refresh, onProgress, withTrades, liveCfg }
// liveCfg ({risk, rsi, confluence}), when given, is used INSTEAD OF this module's own config.js — this
// matters because the dashboard runs backtests on a worker thread (backtest-runner.js), which has its own
// separate copy of config.js; liveCfg is a snapshot taken from the main thread's live settings at call time,
// so a setting applied from the sweep result (config-overrides.js) is honoured on the very next backtest,
// not only after the worker thread happens to restart.
// opts.strategyId, if given, overrides which strategy this ONE call uses — lets the dashboard try out
// a different strategy without "applying" it (applying is a separate, explicit step for the live bot).
// opts.partialExitOverride, if given, lets the dashboard TRY staged-exit settings in one backtest/sweep run
// without "applying" them to the live bot first — same idea as opts.strategyId above.
function resolveBase(opts) {
  const base = opts.liveCfg ? { ...opts.liveCfg } : { risk: cfg.risk, rsi: cfg.rsi, confluence: cfg.confluence, strategy: cfg.strategy };
  if (opts.strategyId && STRATEGIES[opts.strategyId]) base.strategy = { id: opts.strategyId };
  if (opts.partialExitOverride) base.risk = { ...base.risk, partialExit: { ...base.risk.partialExit, ...opts.partialExitOverride } };
  return base;
}

async function runBacktest(opts) {
  const base = resolveBase(opts);
  if (!STRATEGIES[base.strategy.id]) return { error: `استراتژی «${base.strategy.id}» پیدا نشد (حذف شده یا فایل استراتژی شخصی خطا دارد)` };
  resetCustomErrors(base.strategy.id);
  const loaded = await loadAll(opts);
  const { prep, skipped } = buildPrep(loaded, opts, base);
  if (!Object.keys(prep).length) return { error: 'no data (check internet, symbols, or TradingView access)', skipped };
  emit(opts, { phase: 'compute' });
  for (const sym of Object.keys(prep)) T.record(sym, [T.trialKey(sym, opts.tf, base.strategy.id, base)]); // looking at it counts as one idea tried
  const rep = buildReport(prep, opts.tf, base);
  rep.skipped = skipped;
  const ce = customErrors(base.strategy.id); if (ce) rep.strategyError = ce;
  if (!opts.withTrades) delete rep.trades; // the full trade list is large; only the CLI (CSV export) asks for it
  return rep;
}

async function runSweep(opts) {
  const base = resolveBase(opts);
  if (!STRATEGIES[base.strategy.id]) return { error: `استراتژی «${base.strategy.id}» پیدا نشد (حذف شده یا فایل استراتژی شخصی خطا دارد)` };
  resetCustomErrors(base.strategy.id);
  const loaded = await loadAll(opts);
  const { prep } = buildPrep(loaded, opts, base);
  if (!Object.keys(prep).length) return { error: 'no data (check internet, symbols, or TradingView access)' };
  emit(opts, { phase: 'compute' });
  const grid = sweepGrid(base);
  for (const sym of Object.keys(prep)) T.record(sym, grid.map((o) => T.trialKey(sym, opts.tf, base.strategy.id, effBase(base, o)))); // a Sweep tries the whole grid, whatever it finally shows
  const sw = buildSweep(prep, opts.onProgress, base);
  if (sw._peek) for (const sym of Object.keys(prep)) T.recordPeek(sym, [T.trialKey(sym, opts.tf, base.strategy.id, effBase(base, sw._peek))]); // the kept-out data was looked at once
  delete sw._peek;
  const ce = customErrors(base.strategy.id); if (ce) sw.strategyError = ce;
  return sw;
}

// ---------------- timeframe x strategy comparison (the dashboard's "مقایسه چند تایم‌فریم") ----------------
// What makes a comparison like this trustworthy (and what the first version got wrong):
//  1. SAME CALENDAR WINDOW for every timeframe. A fixed candle count means 2000 x 15-minute candles (about a month) were
//     compared with 2000 x daily candles (about 8 years) — different markets, not different timeframes. Here every cell
//     is judged on exactly the same dates.
//  2. EVERY cell gets the same validation as a full report: 5 separate time segments (walk-forward) and 1000 bootstrap paths.
//  3. A VERDICT per cell, never just "highest return": too few trades = "insufficient", losing = "negative", and only a
//     result that holds up on all the checks is called "reliable". If nothing is reliable the report says so — it does
//     not crown the least-bad cell.
//  4. Many cells are tested at once, so some will look good by luck alone; the report states how many were tried.
// ---- hold-out: the last stretch of the window is kept out of every selection decision ----
// Candidates are judged on the earlier part only. Those that look good ("reliable" / "suspect") are then run ONCE on the kept-out
// part. A result that cannot repeat on data it never saw is not trusted; a result that repeats is far more believable than one
// that merely survived many looks at the same data.
const MIN_HOLD_TRADES = 10, HOLD_PEEK_WARN = 6;
function holdoutVerdict(h) {
  const base = { n: h.n, ret: h.ret, pf: h.pf, avgR: h.avgR, buyHold: h.buyHold };
  const pf = h.pf === Infinity ? '∞' : h.pf.toFixed(2);
  if (h.n < MIN_HOLD_TRADES) return { ...base, status: 'inconclusive', reason: `فقط ${h.n} معامله در بخش نگه‌داشته‌شده (حداقل ${MIN_HOLD_TRADES} لازم است)` };
  if (h.ret > 0 && h.pf >= 1 && h.avgR > 0) return { ...base, status: 'confirmed', reason: `${h.n} معامله، بازده ${h.ret.toFixed(1)}٪، PF ${pf}، میانگین R ${h.avgR.toFixed(2)}` };
  return { ...base, status: 'failed', reason: `${h.n} معامله، بازده ${h.ret.toFixed(1)}٪، PF ${pf}، میانگین R ${h.avgR.toFixed(2)}` };
}
// A "reliable" verdict that fails on the unseen part is demoted; an inconclusive one stays but says so. Pure (tested directly).
function applyHoldout(j, hv) {
  const notes = (j.notes || []).slice();
  if (j.verdict === 'reliable' && hv.status === 'failed') return { ...j, verdict: 'suspect', reasons: [`روی بخش نگه‌داشته‌شده‌ی داده که هنگام انتخاب دیده نشده بود جواب نداد (${hv.reason})`], notes };
  if (j.verdict === 'reliable' && hv.status === 'inconclusive') notes.push(`آزمون نهایی روی داده‌ی دیده‌نشده نتیجه‌ی قطعی نداد (${hv.reason})`);
  return { ...j, notes };
}

// maxPAdj: after correcting for how many combinations were tried, the chance that the result is just luck must be at most this
const RELIABILITY = { minTrades: 30, minPF: 1.2, minFolds: 3, folds: 5, maxProbLoss: 20, maxPAdj: 0.10 };

const tfMinutes = (tf) => { const t = String(tf).toUpperCase(); if (/^\d+$/.test(t)) return Number(t); if (/^\d*D$/.test(t)) return 1440 * (parseInt(t, 10) || 1); if (/^\d*W$/.test(t)) return 10080 * (parseInt(t, 10) || 1); if (/^\d*M$/.test(t)) return 43200 * (parseInt(t, 10) || 1); return 60; };
const TF_FA = { 1: '۱ دقیقه', 5: '۵ دقیقه', 15: '۱۵ دقیقه', 30: '۳۰ دقیقه', 60: '۱ ساعت', 120: '۲ ساعت', 240: '۴ ساعت', 1440: 'روزانه', 10080: 'هفتگی' };
const tfFa = (tf) => TF_FA[tfMinutes(tf)] || String(tf);

// Context a good number needs: compared with simply holding, and what kind of market it was. Never changes the verdict by
// itself (a lower-risk strategy can be worth having even if it earns less than holding) — it is said out loud instead.
function benchNotes(summary, bench, regime) {
  const notes = [];
  if (bench && bench.ret > 0 && summary.ret < bench.ret) notes.push(`بازده‌اش (${summary.ret.toFixed(1)}٪) از خرید-و-نگهداری (${bench.ret.toFixed(1)}٪) کمتر است${bench.beatsRiskAdj ? '، ولی نسبت بازده به افتش بهتر است' : ' و نسبت بازده به افت هم بهتر نیست'}`);
  if (regime && regime.id === 'strong_up' && summary.ret > 0) notes.push('بازار در این بازه صعودی قوی بود؛ استراتژی فقط‌خرید ممکن است صرفاً همراه روند بازار بوده باشد — روی بازه‌ای که ریزش هم دارد بسنج');
  return notes;
}

// Decide one cell's verdict from its numbers. Pure function (tested directly).
// extra (optional): { stat, bench, regime } — the significance numbers; with them, "reliable" also requires that the result is not
// explainable by luck once the number of combinations tried is accounted for.
function judge(summary, wf, mc, rel = RELIABILITY, extra = null) {
  const why = [];
  if (summary.n < rel.minTrades) return { verdict: 'insufficient', reasons: [`فقط ${summary.n} معامله انجام شد؛ برای قضاوت حداقل ${rel.minTrades} معامله لازم است`] };
  if (summary.ret <= 0) why.push(`بازده منفی یا صفر است (${summary.ret.toFixed(1)}٪)`);
  if (summary.pf < 1) why.push(`Profit Factor زیر ۱ است (${summary.pf.toFixed(2)})`);
  if (why.length) return { verdict: 'negative', reasons: why };
  if (summary.pf < rel.minPF) why.push(`Profit Factor ضعیف است (${summary.pf.toFixed(2)}؛ حداقل ${rel.minPF})`);
  if (summary.avgR <= 0) why.push('میانگین R صفر یا منفی است');
  if (wf.profitableFolds < rel.minFolds) why.push(`فقط در ${wf.profitableFolds} از ${wf.folds} بازه سودده بوده (حداقل ${rel.minFolds})`);
  if (mc && mc.probLoss > rel.maxProbLoss) why.push(`در شبیه‌سازی مونت‌کارلو احتمال پایان با ضرر ${mc.probLoss.toFixed(0)}٪ است (حداکثر ${rel.maxProbLoss}٪)`);
  const st = extra && extra.stat;
  if (st && st.fewBlocks) why.push(`معاملات فقط در ${st.blocks} بازه‌ی زمانی ${st.blockDays} روزه پخش شده‌اند (حداقل ${MIN_BLOCKS} لازم است)؛ معاملاتِ هم‌زمان یک شاهد حساب می‌شوند، پس شاهد مستقل کافی نیست`);
  else if (st && st.pAdj !== null && st.pAdj > rel.maxPAdj) why.push(`با احتساب اینکه ${st.tests} ترکیب آزمایش شده، احتمال اینکه این نتیجه فقط شانس باشد ${(st.pAdj * 100).toFixed(0)}٪ است (حداکثر ${(rel.maxPAdj * 100).toFixed(0)}٪)`);
  const notes = extra ? benchNotes(summary, extra.bench, extra.regime) : [];
  return why.length ? { verdict: 'suspect', reasons: why, notes } : { verdict: 'reliable', reasons: ['همه‌ی بررسی‌ها قبول شد'], notes };
}

// opts: { symbol, timeframes, strategies, days (default 180), maxCandles (default 20000), strict (default false: shrink the window to the shortest history; true: leave out timeframes whose history is shorter than `days`), cacheDir, refresh, onProgress, liveCfg, minTrades }
async function runMatrix(opts) {
  const days = Math.max(14, Number(opts.days) || 180), maxCandles = Math.max(500, Number(opts.maxCandles) || 200000); // cap on candles per timeframe (TradingView gives <= TV_MAX; the rest comes from the candle archive)
  const rel = { ...RELIABILITY, ...(opts.minTrades ? { minTrades: opts.minTrades } : {}) };
  const total = opts.timeframes.length * opts.strategies.length;
  // 1) download each timeframe (enough candles for `days` plus indicator warm-up, capped by what TradingView gives)
  const loadedBy = {};
  for (const tf of opts.timeframes) {
    const need = Math.ceil(days * 1440 / tfMinutes(tf)) + WINDOW;
    loadedBy[tf] = await loadAll({ ...opts, symbols: [opts.symbol], tf, candles: Math.min(maxCandles, need) });
  }
  // 2) the common window: starts where the SHORTEST-history timeframe starts having usable (warmed-up) data
  let winStart = 0, winEnd = Infinity;
  const usable = [], histDays = {}, excluded = [];
  for (const tf of opts.timeframes) {
    const bars = loadedBy[tf].data[opts.symbol];
    if (!bars || bars.length <= WINDOW / 2) continue;
    usable.push(tf);
    histDays[tf] = Math.round((bars[bars.length - 1].time - bars[Math.min(WINDOW, bars.length - 1)].time) / 86400);
  }
  // strict: a timeframe whose downloaded history is clearly shorter than the requested days is LEFT OUT, instead of silently
  // shrinking the window for every other timeframe (the old behaviour turned a 180-day request into 49 days because of 15m).
  // If nothing covers the request, fall back to the shortest-history window as before.
  let inWindow = usable;
  if (opts.strict) {
    const covering = usable.filter((tf) => histDays[tf] >= days * 0.9);
    if (covering.length) { inWindow = covering; usable.filter((tf) => !covering.includes(tf)).forEach((tf) => excluded.push({ tf, days: histDays[tf] })); }
  }
  for (const tf of inWindow) {
    const bars = loadedBy[tf].data[opts.symbol];
    winStart = Math.max(winStart, bars[Math.min(WINDOW, bars.length - 1)].time);
    winEnd = Math.min(winEnd, bars[bars.length - 1].time);
  }
  winStart = Math.max(winStart, winEnd - days * 86400);
  const windowDays = inWindow.length ? Math.round((winEnd - winStart) / 86400) : 0;
  // hold-out: judge on the earlier part, keep the last `hold` share unseen until a candidate is already shortlisted
  const hold = Math.min(0.5, Math.max(0, Number(opts.holdout) || 0));
  const trainEnd = hold ? winStart + (1 - hold) * (winEnd - winStart) : winEnd;
  const judgeDays = inWindow.length ? Math.round((trainEnd - winStart) / 86400) : 0;
  // the research ledger: record everything this comparison looks at BEFORE judging, so the correction counts it (and everything
  // tried on this symbol recently: other runs, Sweeps, ...), not just the cells of this one table
  const planned = [];
  for (const tf of inWindow) for (const strategyId of opts.strategies) planned.push(T.trialKey(opts.symbol, tf, strategyId, resolveBase({ liveCfg: opts.liveCfg, strategyId })));
  if (planned.length) T.record(opts.symbol, planned);
  const ledgerTests = Math.max(1, planned.length, T.summary(opts.symbol).trials);
  const holdKeys = [];
  const cells = [];
  let done = 0;
  for (const tf of opts.timeframes) {
    for (const strategyId of opts.strategies) {
      const sName = (STRATEGIES[strategyId] || {}).name || strategyId;
      const loaded = loadedBy[tf];
      const base = resolveBase({ liveCfg: opts.liveCfg, strategyId });
      resetCustomErrors(strategyId);
      const ex = excluded.find((e) => e.tf === tf);
      const { prep, skipped } = inWindow.includes(tf) ? buildPrep(loaded, { symbols: [opts.symbol], tf, candles: opts.candles || 0 }, base) : { prep: {}, skipped: [] };
      if (!Object.keys(prep).length) {
        const bars = loaded.data[opts.symbol];
        cells.push({ tf, strategyId, strategyName: sName, verdict: 'insufficient', reasons: [ex ? `تاریخچه‌ی قابل دریافت این تایم‌فریم فقط ${ex.days} روز است (کمتر از ${days} روز درخواستی) و کنار گذاشته شد تا بازه‌ی بقیه کوتاه نشود` : `داده‌ی کافی نیست (${bars ? bars.length : 0} کندل)`], error: true });
      } else {
        const bars = prep[opts.symbol].bars, n = bars.length;
        const a = bars.findIndex((x) => x.time >= winStart), zFull = bars.length - 1 - [...bars].reverse().findIndex((x) => x.time <= winEnd);
        const zTrain = hold ? bars.length - 1 - [...bars].reverse().findIndex((x) => x.time <= trainEnd) : zFull;
        const z = zTrain; // everything below (summary, walk-forward, Monte Carlo, statistics) is computed on the part selection is allowed to see
        const from = Math.max(0, a) / n, to = (z + 1) / n;
        const res = run(prep, from, to, {}, base), summary = summarize(res);
        const wf = walkForward(prep, {}, base, rel.folds, from, to), mc = monteCarlo(res.trades, res.capital, 1000);
        // significance: how likely is luck, after counting every combination of this comparison; and how it compares with just holding
        const testsN = ledgerTests;
        const stat = tradeStats(res.trades, testsN);
        const bhDD = maxDrawdownPct(bars.slice(Math.max(0, a), z + 1).map((x) => x.close));
        const bench = { ret: summary.buyHold, maxDD: bhDD, beatsRaw: summary.ret >= summary.buyHold, beatsRiskAdj: summary.ret / Math.max(summary.maxDD, 1) >= summary.buyHold / Math.max(bhDD, 1) };
        const regime = regimeOf(summary.buyHold, judgeDays);
        const j0 = judge(summary, wf, mc, rel, { stat, bench, regime });
        // only a shortlisted candidate gets to look at the kept-out part (fewer looks = it stays unseen for longer)
        let holdInfo = null;
        if (hold && zFull > zTrain && (j0.verdict === 'reliable' || j0.verdict === 'suspect')) {
          holdInfo = holdoutVerdict(summarize(run(prep, (zTrain + 1) / n, (zFull + 1) / n, {}, base)));
          holdKeys.push(T.trialKey(opts.symbol, tf, strategyId, base));
        }
        const j = holdInfo ? applyHoldout(j0, holdInfo) : j0;
        const ce = customErrors(strategyId);
        // a strategy whose code throws is not "bad", it is BROKEN: say so instead of showing numbers made of skipped candles
        if (ce) cells.push({ tf, strategyId, strategyName: sName, verdict: 'insufficient', reasons: [`کد استراتژی روی ${ce.count} کندل خطا داد: ${ce.message}`], error: true, strategyError: ce });
        else cells.push({ tf, strategyId, strategyName: sName, summary, wf, mc, stat, bench, holdout: holdInfo, window: { candles: z + 1 - Math.max(0, a) }, ...j });
      }
      done++;
      emit(opts, { phase: 'matrix', done, total, tf, strategyId });
    }
  }
  if (holdKeys.length) T.recordPeek(opts.symbol, holdKeys);
  const led = T.summary(opts.symbol);
  if (hold && led.peeks > HOLD_PEEK_WARN) for (const c of cells) if (c.verdict === 'reliable' && c.holdout) (c.notes = c.notes || []).push(`بخش نگه‌داشته‌شده‌ی داده قبلاً برای بررسی ${led.peeks} ترکیب مختلف استفاده شده؛ دیگر کاملاً «دیده‌نشده» نیست و تأییدش وزن کمتری دارد`);
  const byQuality = (x, y) => { const d = (a, b) => (a === b ? 0 : a > b ? 1 : -1); return d(y.summary.avgR, x.summary.avgR) || d(y.summary.pf, x.summary.pf); };
  const reliable = cells.filter((c) => c.verdict === 'reliable').sort(byQuality);
  const out = {
    symbol: opts.symbol, cells, reliability: rel, cellsTested: cells.filter((c) => !c.error).length,
    window: { from: winStart, to: winEnd, days: windowDays, requestedDays: days },
    excludedTfs: excluded, historyDays: histDays,
    trials: led, holdout: hold ? { fraction: hold, from: trainEnd, to: winEnd, days: Math.round((winEnd - trainEnd) / 86400), trainDays: judgeDays, peeks: led.peeks, peekWarn: led.peeks > HOLD_PEEK_WARN } : null,
    regime: (() => { const c = cells.find((x) => x.summary); return c ? regimeOf(c.summary.buyHold, judgeDays) : null; })(),
    assumptions: { fillMode: (resolveBase({ liveCfg: opts.liveCfg }).risk.fillMode || 'next_open'), costs: costsFor(opts.symbol, resolveBase({ liveCfg: opts.liveCfg }).risk) },
    best: reliable[0] ? { tf: reliable[0].tf, strategyId: reliable[0].strategyId } : null,
  };
  out.text = matrixReportText(out);
  return out;
}

const VERDICT_FA = { reliable: '✅ قابل اتکا', suspect: '⚠️ مشکوک', negative: '❌ منفی', insufficient: '⏳ داده‌ی ناکافی' };
function matrixReportText(r) {
  const d = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const L = [];
  L.push(`گزارش مقایسه‌ی تایم‌فریم و استراتژی — ${r.symbol}`);
  if (!r.window.days) { L.push('داده‌ی کافی برای هیچ تایم‌فریمی دریافت نشد.'); return L.join('\n'); }
  L.push(`بازه‌ی بررسی (برای همه‌ی تایم‌فریم‌ها یکسان): ${d(r.window.from)} تا ${d(r.window.to)} (${r.window.days} روز${r.window.days < r.window.requestedDays ? `؛ از ${r.window.requestedDays} روز درخواستی کمتر است چون تاریخچه‌ی کوتاه‌ترین تایم‌فریم همین‌قدر بود` : ''})`);
  if (r.excludedTfs && r.excludedTfs.length) L.push(`کنار گذاشته‌شده به‌خاطر تاریخچه‌ی کوتاه‌تر از ${r.window.requestedDays} روز: ${r.excludedTfs.map((e) => `${tfFa(e.tf)} (فقط ${e.days} روز)`).join('، ')}`);
  L.push(`فرض‌ها: ورود/خروج روی ${r.assumptions.fillMode === 'close' ? 'قیمت بسته‌شدن همان کندل (خوش‌بینانه)' : 'قیمت باز شدن کندل بعد (واقع‌بینانه)'} | هزینه‌ی هر طرف: کارمزد ${r.assumptions.costs.feePct}٪ + لغزش ${r.assumptions.costs.slippagePct}٪`);
  if (r.holdout) L.push(`تقسیم داده: انتخاب و داوری فقط روی ${d(r.window.from)} تا ${d(r.holdout.from)} (${r.holdout.trainDays} روز) انجام شد. آخرین ${r.holdout.days} روز (${d(r.holdout.from)} تا ${d(r.holdout.to)}) کنار گذاشته شد و فقط برای تأیید نهایی نامزدها دیده می‌شود.`);
  if (r.trials) L.push(`آزمایش‌های ثبت‌شده برای این نماد در ${r.trials.windowDays} روز اخیر (این گزارش + اجراها و Sweepهای قبلی): معادل ${r.trials.trials} آزمایش مستقل. آمار روی همین عدد تعدیل شده، نه فقط روی همین جدول.`);
  L.push(`تعداد ترکیب آزمایش‌شده: ${r.cellsTested}. وقتی چندین ترکیب را با هم می‌آزمایی، بعضی‌ها صرفاً از روی شانس خوب به نظر می‌رسند؛ برای همین فقط ترکیبی «قابل اتکا» حساب شده که معامله‌ی کافی، سودِ پایدار در بازه‌های جدا، مونت‌کارلوی قابل‌قبول دارد و پس از تعدیل برای تعداد آزمایش‌ها هم از شانس قابل تشخیص است.`);
  if (r.regime) L.push(`وضعیت بازار در این بازه (با خرید-و-نگهداری سنجیده): ${r.regime.label}${r.cells.find((x) => x.summary) ? ` — ${r.cells.find((x) => x.summary).summary.buyHold.toFixed(1)}٪` : ''}.${r.regime.id === 'strong_up' ? ' استراتژی‌های فقط‌خرید در بازار صعودی قوی راحت‌تر خوب به نظر می‌رسند؛ نتیجه را روی بازه‌ای با ریزش هم بسنج.' : ''}`);
  L.push('');
  for (const c of r.cells) {
    const head = `${tfFa(c.tf)} × ${c.strategyName}: ${VERDICT_FA[c.verdict]}`;
    if (c.error || !c.summary) { L.push(`${head} — ${c.reasons[0]}`); continue; }
    const s = c.summary;
    L.push(`${head}\n   بازده ${s.ret.toFixed(1)}٪ | ${s.n} معامله | برد ${s.winRate.toFixed(0)}٪ | PF ${s.pf === Infinity ? '∞' : s.pf.toFixed(2)} | میانگین R ${s.avgR.toFixed(2)} | افت ${s.maxDD.toFixed(1)}٪ | خرید-و-نگهداری ${s.buyHold.toFixed(1)}٪ | سودده در ${c.wf.profitableFolds}/${c.wf.folds} بازه${c.mc ? ` | احتمال ضرر ${c.mc.probLoss.toFixed(0)}٪` : ''}`);
    if (c.stat && c.stat.ci) {
      const st = c.stat, f2 = (x) => (x === Infinity ? '∞' : x.toFixed(2));
      L.push(`   آمار: میانگین R ${st.ci.mean.toFixed(2)} (بازه‌ی ۹۵٪: ${st.ci.lo.toFixed(2)} تا ${st.ci.hi.toFixed(2)}) | احتمال شانسی‌بودن: خام ${(st.p * 100).toFixed(1)}٪ ← تعدیل‌شده برای ${st.tests} ترکیب ${(st.pAdj * 100).toFixed(0)}٪ | PF در سناریوی بدشانسی ${f2(st.pfLo)}${st.blocks ? ` | معاملات در ${st.blocks} بلوک ${st.blockDays} روزه گروه‌بندی شد (هم‌زمان‌ها یک شاهد)` : ''}`);
    }
    if (c.holdout) L.push(`   آزمون نهایی روی داده‌ی دیده‌نشده: ${{ confirmed: '✅ تأیید شد', failed: '❌ رد شد', inconclusive: '⏳ نتیجه‌ی قطعی نداد' }[c.holdout.status]} — ${c.holdout.reason}`);
    if (c.verdict !== 'reliable') L.push(`   دلیل: ${c.reasons.join('؛ ')}`);
    if (c.notes && c.notes.length && (c.verdict === 'reliable' || c.verdict === 'suspect')) c.notes.forEach((n) => L.push(`   توجه: ${n}`));
  }
  L.push('');
  const rel = r.cells.filter((c) => c.verdict === 'reliable');
  if (!rel.length) L.push('نتیجه: هیچ ترکیبی از نظر آماری قابل اتکا نبود. این یعنی در این بازه نمی‌شود با اطمینان یک تایم‌فریم/استراتژی را برتر دانست — نه این‌که «بهترینِ بد» را انتخاب کنیم. گزینه‌ها: بازه‌ی طولانی‌تر (روزهای بیشتر)، تایم‌فریم‌های بزرگ‌تر برای معامله‌ی بیشتر در بازه‌ی طولانی‌تر، یا نماد دیگر.');
  else {
    const b = rel.slice().sort((x, y) => { const d = (p, q) => (p === q ? 0 : p > q ? 1 : -1); return d(y.summary.avgR, x.summary.avgR) || d(y.summary.pf, x.summary.pf); })[0];
    L.push(`نتیجه: بهترین ترکیب قابل اتکا ${tfFa(b.tf)} × ${b.strategyName} است (میانگین R ${b.summary.avgR.toFixed(2)}، PF ${b.summary.pf === Infinity ? '∞' : b.summary.pf.toFixed(2)}، سودده در ${b.wf.profitableFolds} از ${b.wf.folds} بازه).`);
    if (rel.length > 1) L.push(`ترکیب‌های قابل اتکای دیگر: ${rel.filter((x) => x !== b).map((x) => `${tfFa(x.tf)} × ${x.strategyName}`).join('، ')}`);
  }
  if (r.holdout && r.holdout.peekWarn) L.push(`توجه: بخش نگه‌داشته‌شده‌ی داده قبلاً برای بررسی ${r.holdout.peeks} ترکیب استفاده شده؛ هرچه بیشتر به آن نگاه شود کمتر «دیده‌نشده» است. برای آزمون واقعی به داده‌ی تازه (چند هفته بعد) یا نماد دیگر نیاز داری.`);
  L.push('هشدار: این نتیجه روی گذشته است و تضمینی برای آینده نیست؛ قبل از پول واقعی چند هفته حالت آزمایشی (paper) را امتحان کن.');
  return L.join('\n');
}

module.exports = { buildPrep, ranges, SWEEP_HOLD, loadAll, prepare, run, summarize, buildReport, buildSweep, sweepGrid, holdoutVerdict, applyHoldout, MIN_HOLD_TRADES, runBacktest, runSweep, runMatrix, matrixReportText, judge, tfMinutes, RELIABILITY, walkForward, monteCarlo, WINDOW, STRATEGIES };

// ---------------- CLI ----------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return def;
    return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
  };
  const TF = String(opt('tf', cfg.timeframe));
  const N = Number(opt('candles', 2000));
  const SYMBOLS = String(opt('symbols', cfg.symbols.join(','))).split(',');
  const REFRESH = !!opt('refresh', false);
  require('./custom-strategies').load(); // so --strategy can name a js_ / combo_ strategy too
  const STRATEGY = String(opt('strategy', cfg.strategy.id));

  if (opt('list-strategies', false)) {
    console.log('Available --strategy values:');
    Object.entries(STRATEGIES).forEach(([id, s]) => console.log(`  ${id}${id === cfg.strategy.id ? ' (current)' : ''} — ${s.name}: ${s.description}`));
    process.exit(0);
  }
  if (!STRATEGIES[STRATEGY]) { console.log(`Unknown --strategy "${STRATEGY}". Run with --list-strategies to see the options.`); process.exit(1); }

  const f = (x, d = 2) => (x === Infinity ? '∞' : x.toFixed(d));
  const line = (a) => a.map((c, i) => String(c).padEnd(i === 0 ? 18 : 10)).join('');

  function printReport(rep) {
    const s = rep.summary;
    console.log(`\n=== Backtest | strategy: ${rep.strategy.name} | ${rep.meta.symbols} symbols | timeframe ${rep.meta.tf} | ${rep.meta.from} -> ${rep.meta.to} ===`);
    console.log(`Start ${s.startCapital}  ->  End ${s.endEquity.toFixed(2)}   Return ${f(s.ret)}%   (Buy&Hold avg ${f(s.buyHold)}%)`);
    console.log(`Trades ${s.n} | Win rate ${f(s.winRate, 1)}% | Profit factor ${f(s.pf)} | Avg ${f(s.avgR)}R per trade | Max drawdown ${f(s.maxDD)}%`);
    console.log(`Worst losing streak ${s.worstStreak}${s.ddHalt ? ' | STOPPED by max-drawdown limit during test' : ''}`);
    console.log('\nBy symbol:\n' + line(['symbol', 'trades', 'win%', 'net PnL']));
    rep.bySymbol.forEach((x) => console.log(line([x.symbol, x.trades, x.winPct == null ? '-' : f(x.winPct, 0), f(x.pnl)])));
    console.log('\nExits: ' + Object.entries(rep.exits).map(([k, v]) => `${k} ${v}`).join(' | '));
    const csv = 'symbol,entry_time,exit_time,entry,exit,qty,pnl,pct,R,reason\n' + rep.trades.map((x) =>
      [x.symbol, new Date(x.entryTime * 1000).toISOString().slice(0, 10), new Date(x.exitTime * 1000).toISOString().slice(0, 10), x.entry, x.exit, x.qty, x.pnl.toFixed(4), x.pct.toFixed(2), x.r.toFixed(2), x.reason].join(',')).join('\n');
    fs.writeFileSync(path.join(process.cwd(), 'backtest-trades.csv'), csv);
    console.log('All trades saved to backtest-trades.csv');
    console.log(`\nSplit check -> first 70%: ${f(rep.split.first70.ret)}% (${rep.split.first70.trades} trades) | last 30%: ${f(rep.split.last30.ret)}% (${rep.split.last30.trades} trades)`);
  }

  function printSweep(sw) {
    const head = ['setting', 'trainRet%', 'trainDD%', 'trades', 'TESTret%', 'TESTdd%', 'testTrades'];
    const row = (r) => [r.label, f(r.trainRet), f(r.trainDD), r.trainTrades, f(r.testRet), f(r.testDD), r.testTrades].map((c, i) => String(c).padEnd(i === 0 ? 34 : 11)).join('');
    console.log(`\n=== Sweep: strategy: ${sw.strategy.name} | ${sw.total} settings | ranked on the first ${Math.round((1 - sw.holdFraction) * 100)}% of the data (70/30 train/test inside it); the last ${Math.round(sw.holdFraction * 100)}% is kept out of every choice ===`);
    console.log(head.map((c, i) => c.padEnd(i === 0 ? 34 : 11)).join(''));
    sw.top.forEach((r) => console.log(row(r)));
    console.log('\nYour current config.js for comparison:');
    console.log(row(sw.current));
    const why = { nomatch: 'not enough trades for any setting', weak: 'nothing did well on both train and test', inconsistent: 'not profitable in most walk-forward segments', luck: `could easily be luck after comparing ${sw.comparedSettings} settings`, holdout_failed: 'it FAILED on the kept-out data', holdout_inconclusive: 'too few trades on the kept-out data to confirm it' };
    if (sw.recommended) console.log(`\nCandidate that passed every check, including the kept-out data: ${sw.recommended.label}`);
    else console.log(`\nNo recommendation: ${why[sw.noRecommendationReason] || sw.noRecommendationReason}.`);
    console.log(`\nRead this carefully: a recommendation is still only a candidate, not proof. Few trades = weak evidence; confirm with weeks of paper/signal mode.`);
  }

  (async () => {
    const onProgress = (p) => { if (p.phase === 'data' && p.state === 'downloading') console.log(`downloading ${p.symbol} ...`); };
    if (opt('sweep', false)) {
      const sw = await runSweep({ symbols: SYMBOLS, tf: TF, candles: N, refresh: REFRESH, strategyId: STRATEGY, onProgress });
      if (sw.error) { console.log(sw.error); process.exit(1); }
      printSweep(sw);
    } else {
      const rep = await runBacktest({ symbols: SYMBOLS, tf: TF, candles: N, refresh: REFRESH, strategyId: STRATEGY, onProgress, withTrades: true });
      if (rep.error) { console.log(rep.error); process.exit(1); }
      rep.skipped.forEach((x) => console.log(`skipping ${x.symbol}: not enough candles (${x.candles})`));
      printReport(rep);
    }
  })();
}
