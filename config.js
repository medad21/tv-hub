try { require('dotenv').config(); } catch {}
require('./lang'); // APP_LANG=en: Telegram messages, console output and reports in English
const fs = require('fs');
const { parseSymbols } = require('./symbols');
const path = require('path');

// Settings you (or "بهترین تنظیمات را پیدا کن" on the Backtest tab) chose to keep are saved here and
// re-applied on top of the defaults below every time the app starts — so a restart doesn't lose them.
// Delete this file (or use "بازگشت به تنظیمات پیش‌فرض" in the dashboard) to go back to the values below.
const OVERRIDES_FILE = process.env.CONFIG_OVERRIDES_FILE || path.join(process.env.DATA_DIR || __dirname, 'config.local.json');
let overrides = {};
try { overrides = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')); } catch {}

const rsi = { period: 14, buy: 30, sell: 70 };

// Which entry logic decides buy/sell (see strategy.js's STRATEGIES for the full list and plain-language
// descriptions — the Backtest tab shows these too, no need to know trading jargon to pick one).
const strategy = { id: 'rsi_dip' };

// ---- Confluence filter: require other indicators to agree with the RSI cross before acting ----
// The RSI cross alone stays the trigger (and is still shown as a "signal" line/dashboard chip);
// this only decides whether the bot is allowed to act on it (open/close a position).
const confluence = {
  enabled: true,
  minConfirm: 1,      // how many of the checks below must agree (clamped to however many are enabled). 2 = very strict
  useMacd: true,       // MACD histogram must be turning in the trade's direction (rising for a buy, falling for a sell)
  useVolume: true,     // volume on the trigger bar must be above its recent average (real interest, not noise)
  volumeMult: 1.2,      // "above average" = at least 1.2x the 20-bar average volume
};

// ---- Risk management (applies to paper and live) ----
const risk = {
  riskPerTradePct: 1,     // max loss per trade = 1% of equity (position size is derived from this)
  atrPeriod: 14,
  atrMult: 2,             // stop-loss distance = 2 x ATR (adapts to each market's volatility)
  takeProfitRR: 2,        // take-profit = 2 x stop distance (risk:reward 1:2)
  trailing: true,         // after +1R: stop moves to breakeven, then trails 1R behind the peak
  maxOpenPositions: 4,
  maxPositionPct: 25,     // no single position above 25% of equity
  dailyLossLimitPct: 3,   // -3% on the day: no new entries until next UTC day
  maxDrawdownPct: 10,     // -10% from peak: no new entries until you press Resume
  cooldownMin: 60,        // wait after closing a symbol before re-entering it
  trendFilter: true,      // buy dips only when price is above the trend EMA
  trendEma: 100,
  feePct: 0.1,            // per side, used for paper realism and PnL estimate
  slippagePct: 0.05,      // per side, paper only
  // Real trading costs differ a lot between markets, so the flat numbers above are only the fallback.
  // These are ROUGH starting assumptions (per side, %) — set them to what YOUR broker/exchange really charges:
  //   crypto: exchange fee + slippage | stock: commission-free brokers, mostly slippage | forex/gold: no fee, but the
  //   spread (about half of it per side) plus slippage. A backtest is only as honest as these numbers.
  costs: {
    crypto: { feePct: 0.1, slippagePct: 0.05 },
    stock:  { feePct: 0.0, slippagePct: 0.05 },
    forex:  { feePct: 0.0, slippagePct: 0.03 },
  },
  // How the backtester fills a signal. 'next_open' (default, realistic): the signal is known only when the candle
  // CLOSES, so the order fills at the NEXT candle's open. 'close' = the old optimistic behaviour (fill at the
  // very close that produced the signal), kept only for comparing with old results.
  fillMode: 'next_open',
  minNotional: 10,        // skip positions smaller than this (in quote currency)

  // Correlation-aware exposure caps: symbols in the same group tend to move together
  // (e.g. BTC and ETH), so a single-symbol cap isn't enough. Max % of equity that may
  // be committed, combined, to open positions within each group. Omit/comment out a
  // group to leave it uncapped.
  groupExposure: {
    crypto: 50,
    stock: 50,
    forex: 50,
  },

  // Volatility-adaptive sizing: on a symbol whose ATR is unusually large relative to
  // its price (a genuinely choppy/violent market), shrink the risked % itself on top
  // of the normal ATR-based stop distance.
  volAdaptive: true,
  volAdaptiveAtrPct: 5,     // ATR / price * 100 above this counts as "unusually volatile"
  volAdaptiveFactor: 0.5,   // and riskPerTradePct is multiplied by this (e.g. 0.5 = halved)

  // Staged exit: instead of all-or-nothing at the fixed target, bank part of the position at a nearer
  // milestone and let the rest ride. Off by default — it changes how trades/wins are counted (a partial
  // fill and the remainder's later close are each booked separately), so it's an explicit opt-in.
  // Live trading: only works for crypto (BINANCE/BYBIT/... via ccxt, which supports selling a partial
  // amount). Stock (Alpaca) and forex (OANDA) orders in this bot are broker-side bracket/full-close orders
  // that can't be split, so partial exits are silently skipped for those and the position runs to the
  // original full target instead — paper trading and backtests are unaffected by this limitation.
  partialExit: {
    enabled: false,
    atR: 1,                   // bank some profit at this many R (multiples of the stop distance) — independent of takeProfitRR
    closePct: 50,              // % of the position closed at that point
    moveStopToBreakeven: true, // move the stop for the REMAINING qty to the entry price once the partial fires
  },
};

// snapshot of the hand-written defaults above, before any saved override is applied — lets the dashboard
// offer "بازگشت به تنظیمات پیش‌فرض" without needing to remember/hardcode these numbers a second time
const CODE_DEFAULTS = { risk: { ...risk }, rsi: { ...rsi }, confluence: { ...confluence }, strategy: { ...strategy } };
if (overrides.risk) Object.assign(risk, overrides.risk);
if (overrides.rsi) Object.assign(rsi, overrides.rsi);
if (overrides.confluence) Object.assign(confluence, overrides.confluence);
if (overrides.strategy) Object.assign(strategy, overrides.strategy);

// ---- Symbols & timeframe: set them in .env (SYMBOLS=..., TIMEFRAME=...) or edit the default list below ----
// Any TradingView symbol works for data/signals/backtest: EXCHANGE:TICKER
// Live orders work for spot pairs on: BINANCE BYBIT OKX KUCOIN KRAKEN COINBASE BITGET GATEIO MEXC
// (quoted in USDT / USDC / USD, e.g. BYBIT:ETHUSDT, KRAKEN:XBTUSD, COINBASE:SOLUSD)
// .env example, to focus on just two markets:   SYMBOLS=BINANCE:BTCUSDT,OANDA:XAUUSD
const DEFAULT_SYMBOLS = [
    // crypto (BINANCE spot — live orders work if BINANCE_KEY/SECRET are set)
    'BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:SOLUSDT', 'BINANCE:BNBUSDT',
    'BINANCE:XRPUSDT', 'BINANCE:ADAUSDT', 'BINANCE:DOGEUSDT', 'BINANCE:LINKUSDT',
    // US stocks (Alpaca)
    'NASDAQ:AAPL', 'NASDAQ:TSLA', 'NASDAQ:NVDA', 'NASDAQ:MSFT',
    'NASDAQ:AMZN', 'NASDAQ:GOOGL', 'NASDAQ:META',
    // forex + metals (OANDA)
    'OANDA:XAUUSD', 'OANDA:XAGUSD', 'OANDA:EURUSD', 'OANDA:GBPUSD',
    'OANDA:USDJPY', 'OANDA:AUDUSD', 'OANDA:USDCAD', 'OANDA:NZDUSD',
    'OANDA:USDCHF', 'OANDA:EURJPY',
];
const parsedSymbols = parseSymbols(process.env.SYMBOLS);
if (parsedSymbols.rejected.length) console.warn(`SYMBOLS: ignored invalid entries (expected EXCHANGE:TICKER): ${parsedSymbols.rejected.join(', ')}`);
if (process.env.SYMBOLS && !parsedSymbols.symbols.length) console.warn('SYMBOLS has no valid entries — using the default list');
const symbols = parsedSymbols.symbols.length ? parsedSymbols.symbols : DEFAULT_SYMBOLS;

const TIMEFRAMES = ['1', '5', '15', '30', '60', '240', 'D', 'W'];
const tfEnv = String(process.env.TIMEFRAME || '').trim().toUpperCase();
if (tfEnv && !TIMEFRAMES.includes(tfEnv)) console.warn(`TIMEFRAME=${tfEnv} is not one of ${TIMEFRAMES.join(', ')} — using 15`);
// the timeframe the BOT trades on. Order of precedence: saved from the dashboard (config.local.json) > TIMEFRAME in .env > 15.
// The backtest tab's timeframe is only what you are TESTING; the bot follows this value, and changes only when you change it here.
const savedTf = String(overrides.timeframe || '').toUpperCase();
const timeframe = TIMEFRAMES.includes(savedTf) ? savedTf : TIMEFRAMES.includes(tfEnv) ? tfEnv : '15';

module.exports = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '127.0.0.1', // 127.0.0.1 = this computer only; 0.0.0.0 = reachable from phone/server (needs DASH_PASSWORD)
  mode: ['signal', 'paper', 'live'].includes(process.env.MODE) ? process.env.MODE : 'signal',
  symbols, timeframe, TIMEFRAMES,
  rsi, confluence, risk, strategy,
  paper: { balance: 10000 },
  live: {
    capitalUsdt: 100,       // the bot's own "book" size: only this much is managed by the bot
    maxOrderUsdt: 20,       // hard cap per single order
    // Live crypto: keep a protective stop order on the exchange itself (see the dashboard's "استاپ سمت صرافی" switch).
    // Order of precedence: what you saved from the dashboard > EXCHANGE_STOPS=NO in .env (old way) > ON.
    exchangeStops: typeof (overrides.live || {}).exchangeStops === 'boolean' ? overrides.live.exchangeStops : process.env.EXCHANGE_STOPS !== 'NO',
  },
  __overridesFile: OVERRIDES_FILE, __codeDefaults: CODE_DEFAULTS,
};
