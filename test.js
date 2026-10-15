// Offline self-test of strategy + risk logic (no network, no exchange). Run: npm test
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-'));
process.env.CONFIG_OVERRIDES_FILE = path.join(tmp, 'config.local.json'); // never touch the real project's saved settings
process.env.MODE = 'paper';
process.env.STATE_FILE = path.join(tmp, 'state.json');
process.env.EVENT_LOG = path.join(tmp, 'events.log');
process.env.TRADE_LOG = path.join(tmp, 'trades.jsonl');

const { rsi, ema, atr, signal, macd, avgVolume, checks, confluence, createRsiStream, createEmaStream, createAtrStream, createMacdStream, createVolumeStream } = require('./strategy');
const { sizePosition, groupBlockReason } = require('./risk');
const { group } = require('./symbols');
const cfg = require('./config');
let bot = require('./bot');
let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ok  ' + m); };
const buy = (symbol, price, a, trendOk = true) => bot.signal({ symbol, side: 'buy', price, atr: a, trendOk });

(async () => {
  const r1 = bot.route('KRAKEN:XBTUSD'), r2 = bot.route('OKX:ETHUSDC');
  ok(r1 && r1.id === 'kraken' && r1.pair === 'BTC/USD' && r2.pair === 'ETH/USDC', 'symbol routing: KRAKEN:XBTUSD -> BTC/USD, OKX:ETHUSDC -> ETH/USDC');
  ok(bot.route('BYBIT:BTCUSDT.P') === null && bot.route('NASDAQ:AAPL') === null && bot.route('OANDA:XAUUSD') === null, 'perps, stocks and forex have no live route');
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  ok(rsi(up) > 99 && rsi(up.slice().reverse()) < 1, 'RSI: straight rise ~100, straight fall ~0');
  ok(signal(20, { buy: 30, sell: 70 }) === 'buy' && signal(80, { buy: 30, sell: 70 }) === 'sell', 'signal thresholds');
  ok(Math.abs(atr(up.map((c) => ({ max: c + 1, min: c - 1, close: c }))) - 2) < 1e-9, 'ATR of constant 2-wide bars = 2');

  ok((await buy('X:A', 100, 2, false)).side === 'skip', 'trend filter blocks a buy below the trend EMA');
  ok((await buy('X:A', 100, 2)).side === 'buy', 'buy opens a position');
  let p = bot.portfolio().positions[0];
  ok(Math.abs(p.sl - 96) < 0.01 && Math.abs(p.tp - 108) < 0.01, 'stop = 2xATR below, target = 2R above');
  ok((await buy('X:A', 100, 2)).note.includes('already holding'), 'no double entry on the same symbol');

  await bot.tick({ symbol: 'X:A', price: 105 });
  ok(Math.abs(bot.portfolio().positions[0].sl - 101) < 1e-6, 'trailing: stop jumps above entry after +1R');
  let e = await bot.tick({ symbol: 'X:A', price: 100.5 });
  ok(e && e.note.startsWith('trailing stop'), 'trailing stop closes the position');
  ok((await buy('X:A', 100, 2)).note.includes('cooldown'), 'cooldown blocks immediate re-entry');

  await buy('X:T', 200, 4);
  e = await bot.tick({ symbol: 'X:T', price: 217 });
  ok(e && e.note.startsWith('take-profit') && bot.portfolio().realized > 0, 'take-profit closes with a gain');
  await buy('X:S', 100, 2);
  e = await bot.tick({ symbol: 'X:S', price: 95 });
  ok(e && e.note.startsWith('stop-loss'), 'stop-loss closes the position');

  // ---- staged (partial) exit: bank part of the position at a nearer milestone, let the rest ride ----
  cfg.risk.partialExit = { enabled: true, atR: 1, closePct: 50, moveStopToBreakeven: true };
  await buy('X:PE', 100, 2); // dist = atr(2) x atrMult(2) = 4 -> tp1 = 104, full tp = 108, sl = 96
  const qtyBefore = bot.portfolio().positions.find((x) => x.symbol === 'X:PE').qty;
  e = await bot.tick({ symbol: 'X:PE', price: 104 });
  ok(e && e.side === 'sell' && e.note.includes('partial take-profit') && e.pnl > 0, 'partial exit: fires at tp1 with a positive PnL, labelled as a partial');
  let pePos = bot.portfolio().positions.find((x) => x.symbol === 'X:PE');
  ok(pePos && Math.abs(pePos.qty - qtyBefore / 2) < 0.01, 'partial exit: a 50% split halves the open quantity; the position stays open');
  ok(pePos.partialDone === true && pePos.tp1 === null, 'partial exit: the dashboard no longer shows an upcoming milestone once it has fired');
  ok(pePos.sl >= 100, 'partial exit: stop moves to breakeven for the remainder');
  const lossesAfterPartial = bot.portfolio().losses;
  e = await bot.tick({ symbol: 'X:PE', price: 100 }); // back to the breakeven stop -> remainder closes near flat
  // Slippage on the sell fills a hair below the stop price, so a breakeven-stop exit is always a tiny loss,
  // never a win or an exact wash — same cost modelling as every other exit in this bot.
  ok(e && e.note.startsWith('trailing stop') && Math.abs(e.pnlPct) < 1, 'partial exit: remainder closes near break-even (within slippage) when price falls back to the protected stop');
  ok(!bot.portfolio().positions.some((x) => x.symbol === 'X:PE') && bot.portfolio().losses === lossesAfterPartial + 1, 'partial exit: remainder fully closes the position and books its own win/loss (a breakeven stop still costs a hair of slippage, so it is a tiny loss here)');

  cfg.risk.partialExit = { enabled: true, atR: 1, closePct: 100, moveStopToBreakeven: true };
  await buy('X:PF', 100, 2);
  e = await bot.tick({ symbol: 'X:PF', price: 104 });
  ok(e && e.note.startsWith('take-profit (partial = 100%)') && !bot.portfolio().positions.some((x) => x.symbol === 'X:PF'), 'partial exit: closePct 100 closes the whole position at tp1 in one go, not a split');

  cfg.risk.partialExit = { enabled: true, atR: 1, closePct: 0, moveStopToBreakeven: true };
  await buy('X:PZ', 100, 2);
  e = await bot.tick({ symbol: 'X:PZ', price: 104 });
  ok(e === null, 'partial exit: closePct 0 does nothing at tp1 — the position just keeps running');
  e = await bot.tick({ symbol: 'X:PZ', price: 108 });
  ok(e && e.note.startsWith('take-profit') && !e.note.includes('partial'), 'partial exit: with closePct 0, the position still reaches and closes at its normal full target later');
  cfg.risk.partialExit = { enabled: false }; // restore the default for the rest of the suite (closeAll/restart tests below expect exactly 2 open positions)

  // ---- "signal only" mode: no simulated position, but the note should still say what to actually do ----
  const prevMode = cfg.mode;
  cfg.mode = 'signal';
  let sigE = await bot.signal({ symbol: 'X:SIG', side: 'buy', price: 100, atr: 2, trendOk: true, strategyName: 'دنبال‌کردن روند' });
  ok(sigE.note.includes('استراتژی: دنبال‌کردن روند'), 'signal mode: the note names which strategy produced the signal');
  ok(sigE.note.includes('ورود پیشنهادی: 100') && sigE.note.includes('حد ضرر: 96') && sigE.note.includes('حد سود: 108'), 'signal mode: a buy signal states the suggested entry, stop-loss and take-profit prices');
  ok(!sigE.note.includes('پلکانی'), 'signal mode: no partial-exit hint when partialExit is off');
  cfg.risk.partialExit = { enabled: true, atR: 1, closePct: 50, moveStopToBreakeven: true };
  sigE = await bot.signal({ symbol: 'X:SIG2', side: 'buy', price: 100, atr: 2, trendOk: true });
  ok(sigE.note.includes('خروج پلکانی: 50٪ پوزیشن در 104'), 'signal mode: a buy signal also states the partial-exit price when that is enabled');
  cfg.risk.partialExit = { enabled: false };
  sigE = await bot.signal({ symbol: 'X:SIG3', side: 'buy', price: 100, atr: 2, trendOk: false });
  ok(sigE.note.includes('زیر خط روند') && sigE.note.includes('رد می‌کرد'), 'signal mode: warns when the trend filter would have rejected this exact signal in paper/live mode');
  cfg.risk.trendFilter = false;
  sigE = await bot.signal({ symbol: 'X:SIG5', side: 'buy', price: 100, atr: 2, trendOk: false });
  ok(!sigE.note.includes('رد می‌کرد'), 'signal mode: no false trend-filter warning when the trend filter is actually turned off');
  cfg.risk.trendFilter = true;
  sigE = await bot.signal({ symbol: 'X:SIG6', side: 'sell', price: 100, atr: 2, trendOk: true });
  ok(sigE.note.includes('قیمت پیشنهادی خروج: 100'), 'signal mode: a sell signal states the suggested exit price, not just the word "sell"');
  ok(!bot.portfolio().positions.length, 'signal mode: never opens or tracks an actual position, whatever the signals say');
  cfg.mode = prevMode;

  // ---- paper/live close reason names the strategy too, not a hardcoded "RSI" label ----
  await buy('X:SR', 100, 2);
  e = await bot.signal({ symbol: 'X:SR', side: 'sell', price: 101, strategyName: 'شکست سطح' });
  ok(e && e.note.startsWith('سیگنال فروش (شکست سطح)'), 'paper mode: closing on a sell signal names whichever strategy produced it, not a hardcoded RSI label');

  await buy('X:P', 50, 1);
  delete require.cache[require.resolve('./bot')]; bot = require('./bot');
  ok(bot.portfolio().positions.some((x) => x.symbol === 'X:P'), 'open positions survive a restart');

  await buy('X:Q', 60, 1);
  const closed = await bot.closeAll();
  ok(closed.length === 2 && bot.portfolio().positions.length === 0, 'panic closeAll closes every position');

  bot.setHalt(true);
  ok((await buy('X:H', 100, 2)).note.includes('paused'), 'manual halt blocks new entries');
  bot.setHalt(false);

  for (let i = 0; i < 8; i++) { await buy('X:L' + i, 100, 0.5); await bot.tick({ symbol: 'X:L' + i, price: 90 }); }
  const pf = bot.portfolio();
  ok(pf.halted && pf.haltReason.startsWith('daily'), 'daily loss limit halts new entries');
  ok((await buy('X:Z', 100, 2)).note.includes('halted'), 'entries stay blocked while halted');
  bot.setHalt(false);
  ok(!bot.portfolio().halted, 'resume clears the halt');

  await new Promise((r) => setTimeout(r, 100));
  ok(fs.readFileSync(process.env.EVENT_LOG, 'utf8').trim().split('\n').length > 10, 'events are written to the audit log');

  // ---- confluence filter (indicator agreement) ----
  const CF = { enabled: true, minConfirm: 2, useMacd: true, useVolume: true, volumeMult: 1.2 };
  const rising = { macdHist: -0.2, macdPrevHist: -0.5 }, falling = { macdHist: -0.5, macdPrevHist: -0.2 }; // histogram rising / falling (both below zero, like a real oversold dip)
  ok(confluence('buy', {}, CF) === 'buy', 'confluence: no MACD/volume data yet -> falls back to the raw RSI signal');
  ok(confluence('buy', { ...rising, volume: 200, avgVol: 100 }, CF) === 'buy', 'confluence: MACD turning up and volume both agree -> confirmed');
  ok(confluence('buy', { ...falling, volume: 200, avgVol: 100 }, CF) === 'hold', 'confluence: only 1 of 2 checks agrees (need 2) -> held back');
  ok(confluence('buy', { ...rising, volume: 50, avgVol: 100 }, { ...CF, minConfirm: 1 }) === 'buy', 'confluence: minConfirm 1 -> a single agreeing check is enough');
  ok(confluence('buy', { macdHist: -0.2, macdPrevHist: -0.5 }, { ...CF, useVolume: false, minConfirm: 1 }) === 'buy', 'confluence: a negative but rising MACD histogram confirms a dip buy (oversold is always below zero)');
  ok(confluence('sell', { macdHist: 0.2, macdPrevHist: 0.5, volume: 50, avgVol: 100 }, { ...CF, minConfirm: 1 }) === 'sell', 'confluence: a falling MACD histogram confirms a sell');
  ok(confluence('hold', {}, CF) === 'hold', 'confluence: only ever filters buy/sell, passes hold/none through untouched');
  ok(confluence('buy', { ...falling, volume: 50, avgVol: 100 }, { ...CF, enabled: false }) === 'buy', 'confluence: disabled -> always the raw RSI signal');
  ok(checks('buy', { ...rising, volume: 200, avgVol: 100 }).macd === true && checks('buy', {}).macd === null, 'checks(): each check is true/false, or null when there is no data yet');

  const flatThenUp = Array.from({ length: 50 }, () => 100).concat(Array.from({ length: 30 }, (_, i) => 100 + i * 1.5));
  const flatThenDown = Array.from({ length: 50 }, () => 100).concat(Array.from({ length: 30 }, (_, i) => 100 - i * 1.5));
  ok(macd(flatThenUp).hist > 0, 'MACD: momentum turning up -> positive histogram');
  ok(macd(flatThenDown).hist < 0, 'MACD: momentum turning down -> negative histogram');
  ok(macd([1, 2, 3]) === null, 'MACD: not enough candles yet -> null (no false signal)');
  const flatVolBars = Array.from({ length: 25 }, () => ({ volume: 10 }));
  ok(avgVolume(flatVolBars, 20) === 10, 'avgVolume: constant volume averages to itself');
  ok(avgVolume(flatVolBars.slice(0, 5), 20) === null, 'avgVolume: not enough bars yet -> null');

  // ---- volatility-adaptive sizing ----
  const cfgAll = require('./config');
  const calm = sizePosition({ equity: 10000, cash: 10000, price: 100, atrVal: 2, R: cfgAll.risk }); // ATR% = 2, below the 5% threshold
  ok(!calm.volAdapted && calm.riskPct === cfgAll.risk.riskPerTradePct, 'sizePosition: normal volatility -> full risk % per trade');
  const wild = sizePosition({ equity: 10000, cash: 10000, price: 100, atrVal: 8, R: cfgAll.risk }); // ATR% = 8, above threshold
  ok(wild.volAdapted && Math.abs(wild.riskPct - cfgAll.risk.riskPerTradePct * cfgAll.risk.volAdaptiveFactor) < 1e-9, 'sizePosition: unusually high ATR% -> risk % scaled down');

  // ---- correlation-group exposure cap ----
  ok(group('BINANCE:BTCUSDT') === 'crypto' && group('NASDAQ:AAPL') === 'stock' && group('OANDA:EURUSD') === 'forex' && group('X:A') === null,
    'group(): classifies crypto/stock/forex symbols, leaves unknown prefixes ungrouped');
  const openPos = { 'BINANCE:BTCUSDT': { qty: 1, entry: 100 } }, openPx = { 'BINANCE:BTCUSDT': 100 }, capR = { groupExposure: { crypto: 15 } };
  ok(groupBlockReason(openPos, openPx, 'BINANCE:ETHUSDT', 1000, 40, capR) === null, 'groupBlockReason: staying within the group cap is allowed');
  ok(groupBlockReason(openPos, openPx, 'BINANCE:ETHUSDT', 1000, 100, capR) !== null, 'groupBlockReason: exceeding the group cap is blocked');
  ok(groupBlockReason(openPos, openPx, 'NASDAQ:AAPL', 1000, 900, capR) === null, 'groupBlockReason: a different group (stock) is unaffected by the crypto cap');

  // ---- streaming indicators used by the backtester must match the batch math exactly ----
  const closesX = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 7) * 6 + i * 0.05);
  const barsX = closesX.map((c, i) => ({ close: c, max: c + 1, min: c - 1, volume: 50 + (i % 13) * 4 }));
  const rsiS = createRsiStream(14); let rsiLast; closesX.forEach((c) => { rsiLast = rsiS(c); });
  ok(Math.abs(rsiLast - rsi(closesX, 14)) < 1e-9, 'streaming RSI matches the batch RSI over the same series');
  const emaS = createEmaStream(20); let emaLast; closesX.forEach((c) => { emaLast = emaS(c); });
  ok(Math.abs(emaLast - ema(closesX, 20)) < 1e-9, 'streaming EMA matches the batch EMA over the same series');
  const atrS = createAtrStream(14); let atrLast; barsX.forEach((b) => { atrLast = atrS(b); });
  ok(Math.abs(atrLast - atr(barsX, 14)) < 1e-9, 'streaming ATR matches the batch ATR over the same series');
  const macdS = createMacdStream(); let macdLast; closesX.forEach((c) => { macdLast = macdS(c); });
  ok(Math.abs(macdLast.hist - macd(closesX).hist) < 1e-9, 'streaming MACD matches the batch MACD over the same series');
  const volS = createVolumeStream(20); let volLast; barsX.forEach((b) => { volLast = volS(b.volume); });
  ok(Math.abs(volLast - avgVolume(barsX, 20)) < 1e-9, 'streaming avgVolume matches the batch avgVolume over the same series');

  console.log(`\n${n} checks passed`);
})().catch((err) => { console.error('\nFAILED:', err.message); process.exit(1); });
