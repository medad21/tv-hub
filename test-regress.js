// Regression tests for three live-trading bugs. No network, no real money. Run: npm test
//  1. staged exit + restart: the remainder's "no fixed target" (tp) was saved as null, and `price >= null`
//     closed it on the very next tick after a restart
//  2./3. signal-engine.js: a signal is a change between the last two CLOSED candles — judged from the data,
//     not from RAM — plus the persisted "last candle handled" marker and the cold-start staleness guard
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-regress-'));
Object.assign(process.env, {
  MODE: 'paper', STATE_FILE: path.join(tmp, 's.json'), EVENT_LOG: path.join(tmp, 'e.log'),
  DATA_DIR: tmp, CONFIG_OVERRIDES_FILE: path.join(tmp, 'config.local.json'),
});
delete process.env.TELEGRAM_TOKEN;

const cfg = require('./config');
cfg.risk.fillMode = 'close'; // these tests pin the ORIGINAL engine's numbers (fill at the signal candle's close); the realistic next-open mode has its own tests in test-reliability.js
let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ok  ' + m); };
const freshBot = () => { delete require.cache[require.resolve('./bot')]; return require('./bot'); }; // = a process restart
const SYM = 'BINANCE:BTCUSDT';

(async () => {
  // ---- 1. staged exit survives a restart ----
  cfg.risk.partialExit.enabled = true; // 50% at 1R, remainder rides the trailing stop
  let bot = freshBot();
  let e = await bot.signal({ symbol: SYM, side: 'buy', price: 100, atr: 2, trendOk: true });
  ok(e && e.side === 'buy', 'staged exit: position opened (SL 96, first milestone 104)');
  e = await bot.tick({ symbol: SYM, price: 104.5 });
  ok(e && e.note.startsWith('partial take-profit'), 'staged exit: half is banked at the milestone');
  const saved = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8')).positions[SYM];
  ok(saved && saved.partialDone === true && saved.tp === null, 'staged exit: saved state says "no fixed target" explicitly (tp = null)');

  bot = freshBot(); // restart
  e = await bot.tick({ symbol: SYM, price: 106 });
  ok(e === null && bot.portfolio().positions.length === 1, 'after restart: the remainder is NOT closed as a bogus "take-profit" (old bug: price >= null)');
  const pos = bot.portfolio().positions[0];
  ok(pos.tp === null && pos.partialDone === true, 'after restart: remainder still has no fixed target');
  let txt; try { txt = require('./telegram').status(bot.portfolio()); } catch (err) { txt = 'THROWS ' + err.message; }
  ok(txt.includes(SYM) && txt.includes('TP —'), 'telegram /status works for a position with no fixed target (old code: TypeError on null.toPrecision)');
  e = await bot.tick({ symbol: SYM, price: 100 });
  ok(e && e.note.startsWith('trailing stop'), 'after restart: the remainder still exits through its trailing stop');

  // ---- 2./3. signal detection on closed candles ----
  const { detect, isStale } = require('./signal-engine');
  const TF = 15 * 60;
  const mk = (closes, vols = {}) => closes.map((c, i) => ({ time: 1.7e9 + i * TF, close: c, max: c * 1.002, min: c * 0.998, volume: vols[i] ?? 1000 }));
  const wave = (len) => Array.from({ length: len }, (_, i) => 100 + 2 * Math.sin(i / 5)); // RSI stays mid-range
  // a wave length where the last two candles are both "hold" — so a crash right after is a clean transition
  let len = 200;
  while (len < 260 && !(detect(mk(wave(len)), cfg).sig === 'hold' && detect(mk(wave(len)), cfg).prevSig === 'hold')) len++;
  ok(len < 260, 'setup: found a quiet stretch (hold -> hold)');

  const crash = detect(mk([...wave(len), 50]), cfg);
  ok(crash.sig === 'buy' && crash.prevSig === 'hold' && crash.fresh === true, 'a drop that closes below the RSI threshold is a FRESH buy, derived purely from the candles (no remembered state needed -> survives restart)');
  const stays = detect(mk([...wave(len), 50, 50]), cfg);
  ok(stays.sig === 'buy' && stays.prevSig === 'buy' && stays.fresh === false, 'the next candle, still oversold, is not a second signal');
  const calm = detect(mk(wave(len)), cfg);
  ok(calm.fresh === false, 'no change between the last two closed candles -> nothing fresh');
  ok(crash.barTime === 1.7e9 + len * TF, 'barTime is the last CLOSED candle (what the bot persists as "already handled")');

  const nowMs = 1.7e9 * 1000;
  ok(isStale(1.7e9 - 20 * 60, '15', nowMs) === false, 'cold start: a candle that closed minutes ago is acted on');
  ok(isStale(1.7e9 - 2 * 86400, '15', nowMs) === true, 'cold start: a two-day-old transition in the downloaded history is NOT acted on');
  ok(isStale(1.7e9 - 2 * 86400, 'D', nowMs) === false, 'daily timeframe: never treated as stale');

  // the "already handled" marker survives a restart
  bot = freshBot();
  ok(bot.getLastBar('X:Y') === undefined, 'marker: unknown symbol -> undefined (cold start)');
  bot.setLastBar('X:Y', 1234);
  bot = freshBot();
  ok(bot.getLastBar('X:Y') === 1234, 'marker: persisted in state.json, still there after a restart');

  // ---- symbols from .env + the picker catalog ----
  const { parseSymbols, buildCatalog } = require('./symbols');
  const ps = parseSymbols(' binance:btcusdt, OANDA:XAUUSD;nasdaq:aapl\nBINANCE:BTCUSDT  junk  BINANCE:BTCUSDT.P ');
  ok(ps.symbols.join() === 'BINANCE:BTCUSDT,OANDA:XAUUSD,NASDAQ:AAPL,BINANCE:BTCUSDT.P', 'SYMBOLS parsing: comma / semicolon / space / newline separated, upper-cased, de-duplicated, futures (.P) accepted');
  ok(ps.rejected.join() === 'JUNK', 'SYMBOLS parsing: entries that are not EXCHANGE:TICKER are rejected, not silently kept');
  ok(parseSymbols('').symbols.length === 0 && parseSymbols(undefined).symbols.length === 0, 'SYMBOLS parsing: empty / unset -> nothing (config falls back to the default list)');
  const cat = buildCatalog(['OANDA:XAUUSD', 'BINANCE:BTCUSDT.P', 'NASDAQ:AAPL']);
  const flat = Object.values(cat).flat();
  ok(new Set(flat).size === flat.length && cat.forex[0] === 'OANDA:XAUUSD' && cat.stock[0] === 'NASDAQ:AAPL', 'catalog: no duplicates, watched symbols come first in their group');
  ok(cat.other.includes('BINANCE:BTCUSDT.P') && cat.crypto.length >= 10 && cat.forex.length >= 10, 'catalog: unclassifiable symbols go to "other", the common markets are all offered');
  const { execFileSync } = require('child_process');
  const cfgOf = (env) => JSON.parse(execFileSync(process.execPath, ['-e', "const c=require('./config');console.log(JSON.stringify({s:c.symbols,t:c.timeframe}))"], { cwd: __dirname, env: { ...process.env, CONFIG_OVERRIDES_FILE: path.join(tmp, 'none.json'), SYMBOLS: '', TIMEFRAME: '', ...env }, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  let c = cfgOf({ SYMBOLS: 'BINANCE:BTCUSDT,OANDA:XAUUSD', TIMEFRAME: '60' });
  ok(c.s.join() === 'BINANCE:BTCUSDT,OANDA:XAUUSD' && c.t === '60', 'config: SYMBOLS and TIMEFRAME from .env override the defaults');
  c = cfgOf({});
  ok(c.s.length === 25 && c.t === '15', 'config: nothing set -> the default 25 symbols and 15m');
  c = cfgOf({ SYMBOLS: 'garbage', TIMEFRAME: '7' });
  ok(c.s.length === 25 && c.t === '15', 'config: only invalid values -> safe defaults, never an empty watch list');

  console.log(`\n${n} regression checks passed`);
})().catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
