// Live-money safety checks against a fake exchange / fake broker (no network, no real money): stops ON by default, never
// leaving a bought position unprotected, and the startup check of state.json against what really exists. Run: npm test
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-livesafe-'));
Object.assign(process.env, {
  CONFIG_OVERRIDES_FILE: path.join(tmp, 'config.local.json'), DATA_DIR: tmp, TRADE_LOG: path.join(tmp, 'trades.jsonl'), TRIALS_FILE: path.join(tmp, 'trials.json'),
  MODE: 'live', STATE_FILE: path.join(tmp, 's.json'), EVENT_LOG: path.join(tmp, 'e.log'), LIVE_CONFIRM: 'YES', EXCHANGE_TESTNET: 'YES',
  BINANCE_KEY: 'k', BINANCE_SECRET: 's', OKX_KEY: 'k', OKX_SECRET: 's', OKX_PASSPHRASE: 'p', ALPACA_KEY: 'k', ALPACA_SECRET: 's', OANDA_TOKEN: 't', OANDA_ACCOUNT_ID: '1',
});
delete process.env.EXCHANGE_STOPS; // the point: no setting at all must mean "stops ON"

const calls = [], orders = {}, totals = { BTC: 5, ETH: 5, SOL: 5, BNB: 5, XRP: 5, ADA: 5, DOGE: 5, LINK: 5 };
let oid = 0, failStops = 0, failSell = 0;
class Fake {
  constructor(hasStops = true) { this.has = { createStopLossOrder: hasStops }; }
  setSandboxMode() {}
  async loadMarkets() {}
  async fetchBalance() { return { free: { ...totals }, total: { ...totals } }; }
  amountToPrecision(p, a) { return a.toFixed(6); }
  priceToPrecision(p, x) { return x.toFixed(2); }
  async createOrder(pair, type, side, amount, price, params) {
    if (params && params.stopLossPrice && failStops > 0) { failStops--; throw new Error('stop rejected'); }
    if (type === 'market' && side === 'sell' && failSell > 0) { failSell--; throw new Error('sell boom'); }
    const id = 'o' + (++oid);
    const o = { id, status: type === 'market' ? 'closed' : 'open', filled: amount, average: type === 'market' ? price : undefined };
    orders[id] = o; calls.push({ id, pair, type, side, amount, price, params }); return o;
  }
  async fetchOrder(id) { return orders[id]; }
  async cancelOrder(id) { orders[id].status = 'canceled'; calls.push({ cancel: id }); }
}
class NoStopFake extends Fake { constructor() { super(false); } }
const load = Module._load;
Module._load = function (req, ...a) { return req === 'ccxt' ? { binance: Fake, okx: NoStopFake } : load.call(this, req, ...a); };

let alpacaPositions = [];
global.fetch = async (url, opt = {}) => {
  const body = opt.body ? JSON.parse(opt.body) : {}, res = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), json: async () => o });
  if (url.includes('/v2/orders') && opt.method === 'POST') return res({ id: 'a1', qty: body.qty });
  if (url.includes('/v2/orders/a1')) return res({ status: 'filled', filled_qty: '0.25', filled_avg_price: '100' });
  if (url.includes('/v2/positions')) return res(alpacaPositions);
  if (url.includes('/openPositions')) return res({ positions: [{ instrument: 'EUR_USD', long: { units: '1500' }, short: { units: '0' } }, { instrument: 'GBP_USD', long: { units: '0' }, short: { units: '-200' } }] });
  throw new Error('unexpected fetch ' + url);
};

const bot = require('./bot');
const alpaca = require('./broker-alpaca'), oanda = require('./broker-oanda');
let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ok  ' + m); };
const buy = (symbol, price = 100) => bot.signal({ symbol, side: 'buy', price, atr: 2, trendOk: true });
const stopsOf = () => calls.filter((c) => c.params && c.params.stopLossPrice);
const sells = () => calls.filter((c) => c.side === 'sell' && c.type === 'market');
const held = (s) => bot.portfolio().positions.some((p) => p.symbol === s);

(async () => {
  // 1) default = stops on
  let e = await buy('BINANCE:BTCUSDT');
  ok(e.side === 'buy' && stopsOf().length === 1 && e.note.includes('exchange stop placed'), 'no EXCHANGE_STOPS setting -> a stop order is placed on the exchange after every live crypto buy');

  // 2) one failed attempt is retried
  failStops = 1; const before = stopsOf().length;
  e = await buy('BINANCE:ETHUSDT');
  ok(held('BINANCE:ETHUSDT') && stopsOf().length === before + 1 && e.note.includes('exchange stop placed'), 'stop rejected once -> placed on the second try, position kept');

  // 3) both attempts fail -> sold right away
  await bot.closeAll('cleanup (keeps the crypto exposure cap out of the way)');
  failStops = 2; const s0 = sells().length;
  e = await buy('BINANCE:SOLUSDT');
  ok(!held('BINANCE:SOLUSDT') && sells().length === s0 + 1 && e.note.includes('no protective stop'), 'stop fails twice -> the position is sold immediately instead of being left without a stop');

  // 4) exchange cannot hold a stop -> never buys
  const c0 = calls.filter((c) => c.side).length;
  e = await buy('OKX:ETHUSDT');
  ok(e.side === 'skip' && e.note.includes('no stop-loss order') && calls.filter((c) => c.side).length === c0, 'exchange without stop-order support -> entry refused BEFORE any money moves');

  // 5) emergency sell itself fails -> stays flagged and is retried later
  await bot.closeAll('cleanup');
  failStops = 2; failSell = 1; const s1 = sells().length;
  e = await buy('BINANCE:BNBUSDT');
  ok(held('BINANCE:BNBUSDT') && sells().length === s1, 'stop fails twice and the emergency sell fails too -> position still tracked (not forgotten)');
  const realNow = Date.now; Date.now = () => realNow() + 31000;
  await bot.tick({ symbol: 'BINANCE:BNBUSDT', price: 100 });
  Date.now = realNow;
  ok(!held('BINANCE:BNBUSDT') && sells().length === s1 + 1, 'the next tick retries the emergency sell and closes it');

  // 6) startup check
  await bot.closeAll('cleanup'); bot.setHalt(false);
  let r = await bot.reconcile();
  ok(r.issues.length === 0 && !bot.portfolio().halted, 'startup check with no open positions: nothing to do, nothing halted');

  await buy('BINANCE:XRPUSDT'); bot.setHalt(false);
  r = await bot.reconcile();
  ok(r.checked === 1 && r.issues.length === 0 && !bot.portfolio().halted, 'startup check: balance and stop order match -> no issue, bot keeps trading');

  const xrpStop = stopsOf().pop(); orders[xrpStop.id].status = 'canceled'; const k0 = stopsOf().length;
  r = await bot.reconcile();
  ok(stopsOf().length === k0 + 1 && r.issues[0].includes('placed again') && bot.portfolio().halted, 'startup check: exchange stop had vanished -> a new one is placed and new entries are halted for a human look');
  bot.setHalt(false);

  const st = stopsOf().pop(); orders[st.id].status = 'closed'; orders[st.id].average = 96; orders[st.id].filled = st.amount; const s2 = sells().length;
  r = await bot.reconcile();
  ok(!held('BINANCE:XRPUSDT') && sells().length === s2 && r.issues[0].includes('filled while offline'), 'startup check: stop was filled while offline -> booked as closed, without sending a second sell');
  bot.setHalt(false);

  await buy('BINANCE:ADAUSDT'); bot.setHalt(false); totals.ADA = 0;
  const s3 = sells().length;
  r = await bot.reconcile();
  ok(r.issues[0].includes('ADAUSDT') && bot.portfolio().halted, 'startup check: nothing behind the tracked position at the exchange -> flagged and new entries halted');
  const ev = await bot.tick({ symbol: 'BINANCE:ADAUSDT', price: 101 });
  ok(!held('BINANCE:ADAUSDT') && ev && ev.note.includes('تخمینی') && sells().length === s3, 'such a position is booked as an ESTIMATE at the next price, with no order sent');
  totals.ADA = 5; bot.setHalt(false);

  // 7) stocks / forex through the broker modules
  ok(JSON.stringify(await oanda.positions()) === JSON.stringify({ EUR_USD: 1500, GBP_USD: 0 }), 'oanda.positions(): long units per instrument (short-only counts as 0)');
  alpacaPositions = [{ symbol: 'AAPL', qty: '0.25' }];
  ok(JSON.stringify(await alpaca.positions()) === JSON.stringify({ AAPL: 0.25 }), 'alpaca.positions(): quantity per ticker');
  e = await buy('NASDAQ:AAPL'); bot.setHalt(false);
  r = await bot.reconcile();
  ok(held('NASDAQ:AAPL') && r.issues.length === 0, 'startup check: stock position present at the broker -> fine');
  alpacaPositions = [];
  r = await bot.reconcile();
  ok(r.issues.some((x) => x.includes('NASDAQ:AAPL')) && bot.portfolio().halted, 'startup check: stock position missing at the broker -> flagged and halted');

  // 8) when the check itself cannot run
  bot.setHalt(false);
  const realFetch = global.fetch; global.fetch = async () => { throw new Error('network down'); };
  r = await bot.reconcile();
  global.fetch = realFetch;
  ok(r.issues.some((x) => x.includes('could not verify')) && bot.portfolio().halted, 'startup check cannot reach the broker -> new entries halted (exits still work), not silently ignored');

  // 9) the dashboard switch
  const overrides = require('./config-overrides'), cfg = require('./config');
  const saved = () => JSON.parse(fs.readFileSync(process.env.CONFIG_OVERRIDES_FILE, 'utf8'));
  await bot.closeAll('cleanup'); bot.setHalt(false);
  ok(cfg.live.exchangeStops === true, 'switch defaults to ON');
  let sw = bot.setExchangeStops(false);
  ok(sw.enabled === false && cfg.live.exchangeStops === false && saved().live.exchangeStops === false, 'switching OFF takes effect at once and is saved to disk');
  ok(overrides.isApplied() === false, 'a saved switch alone does not show up as "custom strategy settings are active"');
  const k1 = stopsOf().length;
  e = await buy('BINANCE:LINKUSDT');
  ok(e.side === 'buy' && stopsOf().length === k1 && !e.note.includes('exchange stop'), 'switch OFF: buy goes through with no exchange stop (software stop only)');
  await bot.closeAll('cleanup (exposure cap)'); bot.setHalt(false);
  e = await buy('OKX:SOLUSDT');
  ok(e.side === 'buy', 'switch OFF: an exchange without stop-order support can be traded (the user accepted software-only stops)');
  overrides.reset();
  ok(saved().live.exchangeStops === false && cfg.live.exchangeStops === false, '"reset to defaults" (strategy settings) leaves the live switch alone');
  await bot.closeAll('cleanup'); bot.setHalt(false);
  sw = bot.setExchangeStops(true);
  e = await buy('BINANCE:DOGEUSDT');
  ok(sw.enabled && saved().live.exchangeStops === true && stopsOf().length === k1 + 1 && e.note.includes('exchange stop placed'), 'switching back ON: the next buy gets its exchange stop again');

  // precedence: saved dashboard choice > EXCHANGE_STOPS in .env > ON (checked in fresh processes, config is read at start)
  const { execFileSync } = require('child_process');
  const probe = (envStops, file) => {
    const f = path.join(tmp, 'probe-' + Math.random().toString(36).slice(2) + '.json');
    if (file !== undefined) fs.writeFileSync(f, JSON.stringify(file));
    const env = { ...process.env, CONFIG_OVERRIDES_FILE: f }; delete env.EXCHANGE_STOPS; if (envStops !== null) env.EXCHANGE_STOPS = envStops;
    return execFileSync(process.execPath, ['-e', "console.log(require('./config').live.exchangeStops)"], { env, cwd: __dirname }).toString().trim();
  };
  ok(probe(null) === 'true', 'nothing set anywhere -> ON');
  ok(probe('NO') === 'false', 'old way: EXCHANGE_STOPS=NO in .env -> OFF');
  ok(probe('NO', { live: { exchangeStops: true } }) === 'true', 'a choice saved from the dashboard beats .env');
  ok(probe(null, { live: { exchangeStops: false } }) === 'false', 'a saved OFF survives a restart');

  console.log(`\n${n} live-safety checks passed (fake exchange + fake broker)`);
})().catch((err) => { console.error('\nFAILED:', err.message); process.exit(1); });
