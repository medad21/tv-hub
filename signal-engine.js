// Live signal detection on CLOSED candles only (same view of the market the backtester has).
//
// Why closed-only: the newest candle TradingView sends is still forming. RSI/MACD computed on it can flip
// back and forth inside one candle (repainting), and its volume is a partial count compared against the
// average of complete candles. The backtester only ever sees closed candles, so using them live too keeps
// "what the backtest said" and "what the bot does" the same.
//
// bars: oldest -> newest, ALL of them closed (the caller drops the still-forming one).
const { rsi, ema, atr, macd, avgVolume, evalStrategy, donchianHigh, donchianLow, makeCtx } = require('./strategy');

// Every reading the selected strategy / filters might need, computed as of the last bar in `bars`.
function analyze(bars, cfg) {
  const closes = bars.map((b) => b.close);
  const last = bars[bars.length - 1];
  const price = last.close;
  const r = rsi(closes, cfg.rsi.period);
  const m = macd(closes), mPrev = macd(closes.slice(0, -1));
  const closesPrev = closes.slice(0, -1);
  const priorBars = bars.slice(0, -1); // the 20 bars strictly BEFORE the last one: never looks at itself
  const raw = {
    rsi: r, close: price, hist: m ? m.hist : null,
    emaShort: ema(closes, 10), emaLong: ema(closes, 30),
    hh: donchianHigh(priorBars, 20), ll: donchianLow(priorBars, 20),
    ctx: makeCtx(bars), // lets custom (JavaScript) strategies compute their own indicators; only read by those
  };
  const prevRaw = { hist: mPrev ? mPrev.hist : null, emaShort: ema(closesPrev, 10), emaLong: ema(closesPrev, 30) };
  const trend = ema(closes, cfg.risk.trendEma);
  return {
    rsi: r,
    sig: evalStrategy(cfg.strategy.id, raw, prevRaw, cfg.rsi),
    atr: atr(bars, cfg.risk.atrPeriod),
    trendOk: trend !== null && price > trend,
    extra: { macdHist: m ? m.hist : null, macdPrevHist: mPrev ? mPrev.hist : null, volume: last.volume, avgVol: avgVolume(bars, 20) },
  };
}

// Looks at the last closed bar AND the one before it, so "did a signal just appear on this bar?" is answered
// from the data itself instead of from a variable that is lost on restart.
//   fresh = true  ->  the signal on the last closed bar is buy/sell and differs from the previous bar's signal
function detect(closedBars, cfg) {
  const now = analyze(closedBars, cfg);
  const prevSig = closedBars.length > 1 ? analyze(closedBars.slice(0, -1), cfg).sig : undefined;
  const fresh = (now.sig === 'buy' || now.sig === 'sell') && prevSig !== undefined && now.sig !== prevSig;
  return { ...now, prevSig, fresh, barTime: closedBars[closedBars.length - 1].time };
}

// TradingView bar times are unix seconds (be tolerant of ms). Numeric timeframes are minutes; 'D', 'W'... are
// not handled here -> never considered stale (returns false).
function barAgeMs(barTime, nowMs = Date.now()) {
  const t = barTime < 1e12 ? barTime * 1000 : barTime;
  return nowMs - t;
}
// After a cold start (no remembered bar for this symbol) only act on a signal from a bar that closed recently,
// not on an old transition that merely happens to be the last one in the downloaded history (e.g. Friday's bar
// seen on Monday morning).
function isStale(barTime, timeframe, nowMs = Date.now()) {
  const tf = Number(timeframe);
  if (!Number.isFinite(tf) || tf <= 0) return false;
  return barAgeMs(barTime, nowMs) > 2 * tf * 60000 + tf * 60000; // bar opened tf ago + closed up to 2 bars ago
}

module.exports = { analyze, detect, isStale, barAgeMs };
