// Tests the LIVE order paths against a fake exchange (no network, no real money). Run: npm test
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-live-'));
process.env.CONFIG_OVERRIDES_FILE = path.join(tmp, 'config.local.json'); // never touch the real project's saved settings
Object.assign(process.env, {
  MODE: 'live', STATE_FILE: path.join(tmp, 's.json'), EVENT_LOG: path.join(tmp, 'e.log'),
  LIVE_CONFIRM: 'YES', EXCHANGE_TESTNET: 'YES', EXCHANGE_STOPS: 'YES',
  BINANCE_KEY: 'k', BINANCE_SECRET: 's', OKX_KEY: 'k', OKX_SECRET: 's', OKX_PASSPHRASE: 'p',
});

const calls = [], orders = {}; let oid = 0;
class Fake {
  constructor() { this.has = { createStopLossOrder: true }; }
  setSandboxMode(v) { if (process.env.FAKE_NO_SANDBOX) throw new Error('sandbox not supported'); calls.push({ sandbox: v }); }
  async loadMarkets() {}
  async fetchBalance() { return { free: { BTC: 5, ETH: 5, SOL: 5 } }; }
  amountToPrecision(p, a) { return a.toFixed(6); }
  priceToPrecision(p, x) { return x.toFixed(2); }
  async createOrder(pair, type, side, amount, price, params) {
    const id = 'o' + (++oid);
    const o = { id, status: type === 'market' ? 'closed' : 'open', filled: amount, average: type === 'market' ? price : undefined };
    orders[id] = o; calls.push({ id, pair, type, side, amount, price, params }); return o;
  }
  async fetchOrder(id) { return orders[id]; }
  async cancelOrder(id) { orders[id].status = 'canceled'; calls.push({ cancel: id }); }
}
const load = Module._load;
Module._load = function (req, ...a) { return req === 'ccxt' ? { binance: Fake, okx: Fake } : load.call(this, req, ...a); };

const bot = require('./bot');
let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ok  ' + m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const buy = (symbol, price = 100) => bot.signal({ symbol, side: 'buy', price, atr: 2, trendOk: true });
const stopsOf = () => calls.filter((c) => c.params && c.params.stopLossPrice);
const marketSells = () => calls.filter((c) => c.side === 'sell' && c.type === 'market');

(async () => {
  ok(bot.liveExchanges().join() === 'binance,okx', 'only exchanges with keys are live-enabled');

  process.env.FAKE_NO_SANDBOX = '1';
  let e = await buy('BINANCE:BTCUSDT');
  ok(e.side === 'skip' && e.note.includes('sandbox') && !calls.some((c) => c.side), 'testnet requested but unsupported -> refuses to trade, never falls back to real money');
  delete process.env.FAKE_NO_SANDBOX;

  e = await buy('BINANCE:BTCUSDT');
  const b = calls.find((c) => c.side === 'buy');
  ok(e.side === 'buy' && b.type === 'market' && b.pair === 'BTC/USDT' && Math.abs(b.amount - 0.2) < 1e-9, 'market buy, size capped by maxOrderUsdt');
  ok(calls.some((c) => c.sandbox === true), 'sandbox mode switched on');
  ok(stopsOf().length === 1 && stopsOf()[0].side === 'sell' && Math.abs(stopsOf()[0].params.stopLossPrice - 96) < 0.01, 'exchange stop placed at the stop-loss price');

  await bot.tick({ symbol: 'BINANCE:BTCUSDT', price: 105 }); await wait(50);
  ok(stopsOf().length === 2 && Math.abs(stopsOf()[1].params.stopLossPrice - 101) < 0.01 && calls.some((c) => c.cancel === stopsOf()[0].id), 'trailing: old exchange stop cancelled, new higher one placed');

  e = await bot.tick({ symbol: 'BINANCE:BTCUSDT', price: 108.5 });
  ok(e && e.note.startsWith('take-profit') && marketSells().length === 1 && calls.some((c) => c.cancel === stopsOf()[1].id), 'take-profit: cancels the exchange stop, then sells at market');

  await buy('OKX:ETHUSDT');
  const st = stopsOf().pop(); orders[st.id].status = 'closed'; orders[st.id].average = 96; orders[st.id].filled = st.amount;
  const before = marketSells().length;
  e = await bot.tick({ symbol: 'OKX:ETHUSDT', price: 95 });
  ok(e && e.note.startsWith('exchange stop filled') && marketSells().length === before, 'stop executed by the exchange is booked without a second sell');

  const orderCount = calls.filter((c) => c.side).length;
  for (const s of ['BYBIT:BTCUSDT', 'BINANCE:BTCUSDT.P', 'NASDAQ:AAPL', 'OANDA:XAUUSD']) {
    e = await buy(s);
    ok(e.side === 'buy' && e.note.includes('signal only'), `${s}: no keys / no live route -> signal only`);
  }
  ok(calls.filter((c) => c.side).length === orderCount, 'no order was sent for those symbols');

  process.env.LIVE_CONFIRM = 'NO';
  e = await buy('OKX:SOLUSDT');
  ok(e.side === 'skip' && e.note.includes('LIVE_CONFIRM'), 'LIVE_CONFIRM=NO blocks real orders');
  console.log(`\n${n} live-path checks passed (fake exchange)`);
})().catch((err) => { console.error('\nFAILED:', err.message); process.exit(1); });
