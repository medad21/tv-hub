// Classifies a TradingView symbol (EXCHANGE:TICKER) into an asset route/group.
// Shared by bot.js (live trading) and backtest.js (historical replay) so both
// agree on which symbols are crypto/stock/forex and how exposure is grouped.

const EXCH = { BINANCE: 'binance', BYBIT: 'bybit', OKX: 'okx', KUCOIN: 'kucoin', KRAKEN: 'kraken', COINBASE: 'coinbase', BITGET: 'bitget', GATEIO: 'gate', MEXC: 'mexc' };
const PARSE = /^([A-Z]+):([A-Z0-9]+?)(USDT|USDC|USD)$/; // spot pairs quoted in a dollar stablecoin/USD
const STOCK_RE = /^(NASDAQ|NYSE|AMEX|ARCA|BATS):([A-Z.]+)$/;
const FOREX_RE = /^OANDA:([A-Z]{6})$/;

function route(symbol) {
  const m = symbol.match(PARSE);
  if (!m || !EXCH[m[1]]) return null;
  const base = m[2] === 'XBT' ? 'BTC' : m[2];
  return { prefix: m[1], id: EXCH[m[1]], base, quote: m[3], pair: `${base}/${m[3]}` };
}

function classify(symbol) {
  let m = symbol.match(STOCK_RE);
  if (m) return { cls: 'stock', ticker: m[2] };
  m = symbol.match(FOREX_RE);
  if (m) return { cls: 'forex', instrument: `${m[1].slice(0, 3)}_${m[1].slice(3)}` };
  const r = route(symbol);
  if (r) return { cls: 'crypto', ...r };
  return null;
}

// Exposure group for correlation-aware risk caps. Crypto majors, US stocks and
// forex/metals each tend to move together within their own group, so we cap
// total exposure per group rather than only per symbol.
function group(symbol) {
  const c = classify(symbol);
  return c ? c.cls : null; // 'crypto' | 'stock' | 'forex' | null
}

// ---- symbol lists: .env parsing + the picker catalog -------------------------------------------------------
// A TradingView symbol is EXCHANGE:TICKER (BINANCE:BTCUSDT, NASDAQ:AAPL, OANDA:XAUUSD, BINANCE:BTCUSDT.P ...).
const SYMBOL_RE = /^[A-Z0-9_]+:[A-Z0-9._!-]+$/;

// "binance:btcusdt, OANDA:XAUUSD  nasdaq:aapl" -> { symbols: [...unique, upper-cased, valid], rejected: [...] }
// Separators: comma, semicolon, spaces or new lines.
function parseSymbols(raw) {
  const symbols = [], rejected = [];
  String(raw || '').split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean).forEach((x) => {
    if (!SYMBOL_RE.test(x)) rejected.push(x);
    else if (!symbols.includes(x)) symbols.push(x);
  });
  return { symbols, rejected };
}

// Symbols offered as tap-to-select chips in the dashboard (Backtest tab). Backtests download their own data, so
// any of these can be tested even if the live bot is not watching it. Free typing still works for anything else.
const CATALOG = {
  crypto: ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:SOLUSDT', 'BINANCE:BNBUSDT', 'BINANCE:XRPUSDT', 'BINANCE:ADAUSDT',
    'BINANCE:DOGEUSDT', 'BINANCE:LINKUSDT', 'BINANCE:AVAXUSDT', 'BINANCE:DOTUSDT', 'BINANCE:LTCUSDT', 'BINANCE:TRXUSDT'],
  stock: ['NASDAQ:AAPL', 'NASDAQ:TSLA', 'NASDAQ:NVDA', 'NASDAQ:MSFT', 'NASDAQ:AMZN', 'NASDAQ:GOOGL', 'NASDAQ:META',
    'NASDAQ:AMD', 'NASDAQ:NFLX', 'NYSE:JPM'],
  forex: ['OANDA:XAUUSD', 'OANDA:XAGUSD', 'OANDA:EURUSD', 'OANDA:GBPUSD', 'OANDA:USDJPY', 'OANDA:AUDUSD', 'OANDA:USDCAD',
    'OANDA:NZDUSD', 'OANDA:USDCHF', 'OANDA:EURJPY', 'OANDA:GBPJPY', 'OANDA:EURGBP'],
};

// { crypto, stock, forex, other }: the bot's own watch list first (so it is easy to spot), then the catalog; no duplicates.
function buildCatalog(watched = []) {
  const out = { crypto: [], stock: [], forex: [], other: [] }, seen = new Set();
  const add = (x) => { if (seen.has(x)) return; seen.add(x); const c = classify(x); out[c ? c.cls : 'other'].push(x); };
  watched.forEach(add);
  Object.values(CATALOG).flat().forEach(add);
  return out;
}

module.exports = { EXCH, route, classify, group, SYMBOL_RE, parseSymbols, CATALOG, buildCatalog };
