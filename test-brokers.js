// Tests the Alpaca (stocks) and OANDA (forex) live order paths against a fake fetch.
// No network, no real money. Run: npm test
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-brokers-'));
process.env.CONFIG_OVERRIDES_FILE = path.join(tmp, 'config.local.json'); // never touch the real project's saved settings
Object.assign(process.env, {
  MODE: 'live', STATE_FILE: path.join(tmp, 's.json'), EVENT_LOG: path.join(tmp, 'e.log'),
  LIVE_CONFIRM: 'YES',
  ALPACA_KEY: 'ak', ALPACA_SECRET: 'as',
  OANDA_TOKEN: 'ot', OANDA_ACCOUNT_ID: 'acc-1',
});

const calls = [];
const orderQty = {}; // order id -> the qty actually submitted in the POST, so GET echoes it back correctly
let oid = 0, positionsExist = true;
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push({ url, method: opts.method || 'GET', body });

  // ---- Alpaca ----
  if (url.includes('paper-api.alpaca.markets')) {
    if (opts.method === 'POST' && url.endsWith('/v2/orders')) {
      const id = 'a' + (++oid);
      orderQty[id] = body.qty;
      return json({ id, status: 'accepted', ...body });
    }
    if (opts.method === 'GET' && url.includes('/v2/orders/')) {
      const id = url.split('/').pop();
      return json({ status: 'filled', filled_qty: orderQty[id] || '1.5', filled_avg_price: '190.25' });
    }
    if (opts.method === 'DELETE' && url.includes('/v2/positions/')) {
      if (!positionsExist) return json({ message: 'position does not exist' }, 404);
      const id = 'a' + (++oid);
      return json({ id });
    }
  }
  // ---- OANDA ----
  if (url.includes('api-fxpractice.oanda.com')) {
    if (opts.method === 'POST' && url.endsWith('/orders')) {
      if (!positionsExist) return json({ orderCancelTransaction: { reason: 'INSUFFICIENT_MARGIN' } });
      return json({ orderFillTransaction: { units: body.order.units, price: '1.10123' } });
    }
    if (opts.method === 'PUT' && url.includes('/positions/')) {
      if (!positionsExist) return json({ errorMessage: 'CLOSEOUT_POSITION_DOESNT_EXIST' }, 404);
      return json({ longOrderFillTransaction: { units: '-1000', price: '1.10500' } });
    }
  }
  throw new Error('unmocked request: ' + opts.method + ' ' + url);
};
function json(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj), json: async () => obj };
}

delete require.cache[require.resolve('./bot')];
delete require.cache[require.resolve('./broker-alpaca')];
delete require.cache[require.resolve('./broker-oanda')];
const bot = require('./bot');
let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ok  ' + m); };
// Risk halts (daily loss / max drawdown) are already covered by test.js; the mock fill prices
// here are unrealistic on purpose (to keep the math simple), so reset any halt before each buy
// to isolate what this file actually tests: the broker order paths.
const buy = (symbol, price = 200, atr = 2) => { bot.setHalt(false); return bot.signal({ symbol, side: 'buy', price, atr, trendOk: true }); };

(async () => {
  ok(bot.classify('NASDAQ:AAPL').cls === 'stock' && bot.classify('NASDAQ:AAPL').ticker === 'AAPL', 'NASDAQ:AAPL classifies as a stock');
  ok(bot.classify('OANDA:EURUSD').instrument === 'EUR_USD' && bot.classify('OANDA:XAUUSD').instrument === 'XAU_USD', 'OANDA symbols classify as forex with an underscore instrument');
  ok(bot.classify('BINANCE:BTCUSDT').cls === 'crypto' && bot.classify('NYSE:VOO').cls === 'stock', 'crypto and stock routing both still work alongside the new forex routing');

  let e = await buy('NASDAQ:AAPL');
  const order = calls.find((c) => c.method === 'POST' && c.url.endsWith('/v2/orders'));
  ok(e.side === 'buy' && order.body.symbol === 'AAPL' && order.body.order_class === 'bracket', 'stock buy: Alpaca bracket order submitted for the plain ticker');
  ok(Number(order.body.take_profit.limit_price) > 200 && Number(order.body.stop_loss.stop_price) < 200, 'stock buy: bracket carries take-profit above and stop-loss below entry');
  ok(e.note.includes('SL/TP placed at broker'), 'stock buy: event notes broker-side protection');

  let close = await bot.tick({ symbol: 'NASDAQ:AAPL', price: 250 }); // above TP -> tries to close
  ok(close && close.note.startsWith('take-profit') && calls.some((c) => c.method === 'DELETE'), 'stock exit: DELETE position called on take-profit');

  await buy('NASDAQ:MSFT');
  positionsExist = false; // simulate Alpaca's own bracket stop having already closed it
  close = await bot.tick({ symbol: 'NASDAQ:MSFT', price: 1 });
  ok(close && close.note.startsWith('closed by broker'), 'stock exit: DELETE 404 (already closed) is treated as broker-side stop/target fill, not an error');
  positionsExist = true;

  e = await buy('OANDA:EURUSD', 1.1, 0.01); // realistic ATR scale for a ~1.1-priced FX pair
  const fx = calls.find((c) => c.method === 'POST' && c.url.includes('/orders') && c.url.includes('oanda'));
  ok(e.side === 'buy' && fx.body.order.instrument === 'EUR_USD' && fx.body.order.stopLossOnFill && fx.body.order.takeProfitOnFill, 'forex buy: OANDA market order carries stopLossOnFill and takeProfitOnFill');
  ok(Number.isInteger(Number(fx.body.order.units)), 'forex buy: units sent to OANDA are a whole number');

  close = await bot.tick({ symbol: 'OANDA:EURUSD', price: 0.5 });
  ok(close && close.note.startsWith('stop-loss') && calls.some((c) => c.method === 'PUT' && c.url.includes('oanda')), 'forex exit: PUT close called on stop-loss');

  await buy('OANDA:GBPUSD', 1.3, 0.01); // realistic ATR scale, like the EURUSD case above
  positionsExist = false;
  close = await bot.tick({ symbol: 'OANDA:GBPUSD', price: 999 });
  ok(close && close.note.startsWith('closed by broker'), 'forex exit: already-closed response is treated as broker-side fill, not an error');
  positionsExist = true;

  console.log(`\n${n} broker checks passed (fake fetch)`);
  global.fetch = realFetch;
})().catch((err) => { global.fetch = realFetch; console.error('\nFAILED:', err.message); process.exit(1); });
