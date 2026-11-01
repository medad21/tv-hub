// ---------------------------------------------------------------------------------------------------------------
// نمونه‌ی استراتژی شخصی — برای استفاده، این فایل را کپی کن به  custom-strategies.user.js  (کنار همین فایل)،
// ویرایشش کن، و در داشبورد (بخش «استراتژی دلخواه») روی «بارگذاری دوباره‌ی فایل» بزن. نیازی به ری‌استارت نیست.
//
// Example custom strategies. Copy this file to custom-strategies.user.js (same folder), edit it, then press
// "reload file" in the dashboard (section "استراتژی دلخواه"). No restart needed.
//
// Each strategy:   { id, name, description, signal(ctx) }          (set enabled: false to switch one off)
//   id          lowercase letters/digits/_ ; it becomes  js_<id>  everywhere (backtest, comparison, bot)
//   signal(ctx) is called once per CLOSED candle and returns 'buy' or 'sell' (anything else = no opinion).
//               Describe the STATE ("my entry condition is true right now"), not an event: the engine acts when the
//               answer CHANGES, so a condition that stays true does not buy again on every candle.
//               It must be synchronous (no async/await) and must not touch the network or files.
//
// ctx (everything is as of the candle that just closed — future candles are never visible):
//   ctx.close / open / high / low / volume / time        this candle
//   ctx.rsi(14)  ctx.ema(50)  ctx.sma(20)  ctx.atr(14)   numbers, or null while there is not enough history
//   ctx.macd(12,26,9)        -> { macd, signal, hist } | null
//   ctx.bollinger(20, 2)     -> { mid, upper, lower, width } | null
//   ctx.highest(20) / ctx.lowest(20)    highest high / lowest low of the 20 candles BEFORE this one
//   ctx.avgVolume(20)        average volume of the last 20 candles
//   ctx.structure()          market structure: { ok, atr, structure:{trend:'up'|'down'|'range', break}, zones, nearest:{support,resistance}, setups:[{dir,state,zone,invalidation}] }
//                            (support/resistance zones, swings, break + pullback state; ok:false while there are too few candles)
//   ctx.swingHigh(3) / ctx.swingLow(3)   price of the last confirmed swing high / low (null if none yet)
//   ctx.back(1)              the same ctx one candle earlier (ctx.back(1).ema(20) = yesterday's EMA) or null — for crossovers
//   ctx.bars                 the last ~300 candles, oldest -> newest ({ time, open, max, min, close, volume })
// Periods must be whole numbers from 1 to 250 (indicators only see the last ~300 candles, as in the live bot).
// If your code throws, that candle counts as "no signal" and the dashboard/report tells you the error message.
//
// Remember: every strategy you add is one more thing tested. Decide the rule from a trading idea BEFORE looking at
// results — trying many rules and keeping the winner finds luck, not an edge. Prove it in the backtest (and on a
// different symbol / period), then run it in paper mode before real money.
// ---------------------------------------------------------------------------------------------------------------
module.exports = [
  {
    id: 'pullback_in_uptrend',
    enabled: false, // <- change to true to use it
    name: 'اصلاح در روند صعودی (EMA100 + RSI)',
    description: 'قیمت بالای EMA100 است (روند صعودی) و RSI زیر ۴۰ رفته (اصلاح) → خرید؛ قیمت زیر EMA100 بیاید → فروش.',
    signal(ctx) {
      const trend = ctx.ema(100), r = ctx.rsi(14);
      if (trend === null || r === null) return 'none';
      if (ctx.close < trend) return 'sell';
      if (r < 40) return 'buy';
      return 'hold';
    },
  },
  {
    id: 'bollinger_bounce',
    enabled: false,
    name: 'برگشت از باند پایین بولینگر',
    description: 'قیمت زیر باند پایین بولینگر (۲۰، ۲) بسته شد → خرید؛ بالای میانه‌ی باند برگشت → فروش.',
    signal(ctx) {
      const bb = ctx.bollinger(20, 2);
      if (!bb) return 'none';
      if (ctx.close > bb.mid) return 'sell';
      if (ctx.close < bb.lower) return 'buy';
      return 'hold';
    },
  },
  {
    id: 'ema_cross_with_filter',
    enabled: false,
    name: 'تقاطع EMA20/50 با فیلتر EMA200',
    description: 'EMA20 از پایین EMA50 را قطع کرد و قیمت بالای EMA200 است → خرید؛ قطع به پایین → فروش.',
    signal(ctx) {
      const p = ctx.back(1);
      if (!p) return 'none';
      const f = ctx.ema(20), s = ctx.ema(50), long = ctx.ema(200), pf = p.ema(20), ps = p.ema(50);
      if ([f, s, long, pf, ps].some((x) => x === null)) return 'none';
      if (pf <= ps && f > s && ctx.close > long) return 'buy';
      if (pf >= ps && f < s) return 'sell';
      return 'hold';
    },
  },
];
