// End-to-end check of server.js's live feed with a FAKE TradingView (no network): signals come from CLOSED
// candles only, once per candle, and a restart-style cold start does not lose a fresh signal nor act on a stale one.
// Run: npm test
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-feed-'));
Object.assign(process.env, {
  MODE: 'signal', PORT: '39173', STATE_FILE: path.join(tmp, 's.json'), EVENT_LOG: path.join(tmp, 'e.log'),
  DATA_DIR: tmp, CONFIG_OVERRIDES_FILE: path.join(tmp, 'config.local.json'),
});
delete process.env.TELEGRAM_TOKEN; delete process.env.DASH_PASSWORD;

const charts = [];
class FakeChart {
  constructor() { this.periods = []; charts.push(this); }
  setMarket(symbol, opts) { this.symbol = symbol; this.opts = opts; }
  onError() {} onUpdate(fn) { this.cb = fn; } delete() {}
}
class FakeClient { constructor() { this.Session = { Chart: FakeChart }; } end() {} }
const load = Module._load;
Module._load = function (req, ...a) { return req === '@mathieuc/tradingview' ? { Client: FakeClient } : load.call(this, req, ...a); };

const cfg = require('./config');
require('./server');
const bot = require('./bot');
const got = [];
bot.subscribe((e) => got.push(e));

let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ok  ' + m); };
const TF = Number(cfg.timeframe) * 60;
const nowSec = Math.floor(Date.now() / 1000);
const formingStart = Math.floor(nowSec / TF) * TF;
const L = 220; // wave length; the crash candle is candle number L, the next one (L+1) is the one forming when it closes
const base = formingStart - (L + 1) * TF; // candle i always has the same open time, whatever the array length
const wave = (len) => Array.from({ length: len }, (_, i) => 100 + 2 * Math.sin(i / 5)); // RSI stays mid-range
// closes (oldest->newest, the LAST one is the still-forming candle); `age` shifts everything into the past
function feed(chart, closes, vols = {}, age = 0) {
  const bars = closes.map((c, i) => ({ time: base - age + i * TF, close: c, max: c * 1.002, min: c * 0.998, volume: vols[i] ?? 1000 }));
  chart.periods = bars.slice().reverse(); // TradingView sends newest first
  chart.cb();
}
const signalsFor = (symbol) => got.filter((e) => e.symbol === symbol && (e.side === 'buy' || e.side === 'sell'));

(async () => {
  ok(charts.length === cfg.symbols.length && charts.every((c) => c.opts.range === 301), 'every symbol asks for 301 candles = the backtest\'s 300-candle window + the forming one');
  const [A, B, C] = charts;

  // --- A: the forming candle must not trigger anything, the same crash once it has CLOSED must, exactly once ---
  feed(A, [...wave(L), 100]);                                   // quiet market, forming candle normal
  feed(A, [...wave(L), 50]);                                    // forming candle crashes to 50 (RSI would be < 30 if it counted)
  ok(signalsFor(A.symbol).length === 0, 'a crash inside the still-forming candle fires nothing (no repainting)');
  feed(A, [...wave(L), 50], {}, 0);                             // another tick of the same forming candle
  ok(signalsFor(A.symbol).length === 0, 'still nothing on further ticks of that forming candle');
  feed(A, [...wave(L), 50, 50], { [L]: 8000 });                 // candle closed (big volume), next one is forming
  ok(signalsFor(A.symbol).length === 1 && signalsFor(A.symbol)[0].side === 'buy', 'once the crash candle has CLOSED, the buy fires');
  feed(A, [...wave(L), 50, 49], { [L]: 8000 });                 // more ticks of the next forming candle
  feed(A, [...wave(L), 50, 49], { [L]: 8000 });
  ok(signalsFor(A.symbol).length === 1, 'and only once per closed candle (no duplicates on later ticks)');
  ok(bot.getLastBar(A.symbol) === base + L * TF, 'the handled candle is remembered in state.json');

  // --- B: cold start (nothing remembered) with a fresh transition on the last closed candle: must NOT be lost ---
  feed(B, [...wave(L), 50, 50], { [L]: 8000 });
  ok(signalsFor(B.symbol).length === 1 && signalsFor(B.symbol)[0].side === 'buy', 'cold start: a fresh signal on the latest closed candle is acted on (old bug: first signal after restart was lost)');

  // --- C: cold start where that transition is old history (a long-closed market, or a long downtime): ignored ---
  feed(C, [...wave(L), 50, 50], { [L]: 8000 }, 3 * 86400);
  ok(signalsFor(C.symbol).length === 0, 'cold start: a transition from days ago is not traded on');

  console.log(`\n${n} feed checks passed`);
  process.exit(0);
})().catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
