// Offline checks for custom strategies: your own JavaScript file, combinations built in the dashboard, the API, and
// "the engine really uses them" (backtest + worker thread). Run: node test-custom.js  (also part of npm test)
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), vm = require('vm');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-custom-'));
const MINE = path.join(tmp, 'mine.js'), COMBOS = path.join(tmp, 'combos.json');
Object.assign(process.env, {
  CONFIG_OVERRIDES_FILE: path.join(tmp, 'config.local.json'), BT_CACHE: path.join(tmp, 'cache'), TRADE_LOG: path.join(tmp, 'trades.jsonl'),
  EVENT_LOG: path.join(tmp, 'events.log'), STATE_FILE: path.join(tmp, 'state.json'), DATA_DIR: tmp, MODE: 'signal',
  CUSTOM_STRATEGIES_FILE: MINE, CUSTOM_COMBOS_FILE: COMBOS,
});

const cfg = require('./config');
const bt = require('./backtest');
const S = require('./strategy');
const custom = require('./custom-strategies');
const { STRATEGIES, STRATEGY_READS, strategySignal, evalStrategy, makeCtx, runCustomFn, customErrors, resetCustomErrors } = S;
let passed = 0;
const ok = (c, m) => { assert(c, m); passed++; console.log('  ok  ' + m); };
const throwsMsg = (fn) => { try { fn(); } catch (e) { return e.message; } return null; };

function seeded(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
function makeBars(n, stepSec, endTime, seed = 7, drift = 0.0002) {
  const r = seeded(seed); let p = 100; const out = [];
  for (let i = 0; i < n; i++) {
    const open = p, wave = Math.sin(i / 40) * 0.004, ret = drift + wave + (r() - 0.5) * 0.02;
    const close = open * (1 + ret), max = Math.max(open, close) * (1 + r() * 0.006), min = Math.min(open, close) * (1 - r() * 0.006);
    out.push({ time: endTime - (n - 1 - i) * stepSec, open, close, max, min, volume: 1000 + r() * 1000 });
    p = close;
  }
  return out;
}

const MINE_SRC = `
module.exports = [
  { id: 'rsi_mid', name: 'RSI میانه', description: 'test', signal(ctx) { const r = ctx.rsi(14); if (r === null) return 'none'; if (r < 45) return 'buy'; if (r > 55) return 'sell'; return 'hold'; } },
  { id: 'boom', name: 'Boom', signal() { throw new Error('boom: my typo'); } },
  { id: 'spy', name: 'Spy', signal(ctx) { const w = ctx.bars; if (w[w.length - 1].time !== ctx.time || w.some((b) => b.time > ctx.time)) globalThis.__leak = true; globalThis.__calls = (globalThis.__calls || 0) + 1; return 'hold'; } },
  { id: 'async_one', name: 'Async', signal: async () => 'buy' },
  { id: 'off', enabled: false, name: 'Off', signal() { return 'buy'; } },
  { id: 'Bad-ID', name: 'Bad id', signal() { return 'buy'; } },
  { id: 'no_fn', name: 'No function' },
];`;

(async () => {
  // ---- 1) your own JavaScript file ----
  fs.writeFileSync(MINE, MINE_SRC);
  let st = custom.load();
  ok(st.script.exists && !st.script.error, 'script: the file is found and loads without error');
  ok(['js_rsi_mid', 'js_boom', 'js_spy', 'js_async_one'].every((id) => STRATEGIES[id] && STRATEGIES[id].custom && STRATEGIES[id].kind === 'script'), 'script: valid strategies are registered with the js_ prefix and flagged custom');
  ok(st.script.skipped.length === 3 && ['off', 'Bad-ID', 'no_fn'].every((id) => st.script.skipped.some((x) => x.id === id)), 'script: disabled / badly named / signal-less entries are skipped with a reason (not fatal)');
  ok(STRATEGY_READS.js_rsi_mid.custom === true && STRATEGY_READS.js_rsi_mid.fields.length === 0, 'script: it reads through ctx (no fixed fields)');
  ok(!Object.keys(STRATEGIES).filter((k) => !STRATEGIES[k].custom).some((k) => k.startsWith('js_')), 'script: built-in strategies are untouched');

  fs.writeFileSync(MINE, 'module.exports = [ { id: "x", name: "y", signal(ctx) { return ; ');
  st = custom.load();
  ok(st.script.error && st.script.loaded.length === 0 && !STRATEGIES.js_rsi_mid, 'script: a SYNTAX ERROR is reported, nothing half-loaded, no crash');
  fs.writeFileSync(MINE, 'module.exports = 42;');
  st = custom.load();
  ok(st.script.error && /آرایه/.test(st.script.error), 'script: exporting the wrong thing gives a clear message');
  fs.writeFileSync(MINE, MINE_SRC);
  custom.load();
  ok(!!STRATEGIES.js_rsi_mid, 'script: after fixing the file, "reload" brings the strategies back (no restart)');

  // ---- 2) the context handed to your code ----
  const end = 1_800_000_000, bars = makeBars(500, 3600, end, 9);
  const i = 420, ctx = makeCtx(bars, i);
  ok(ctx.bars.length === 300 && ctx.bars[299] === bars[i] && ctx.bar === bars[i] && ctx.close === bars[i].close, 'ctx: the window is the last 300 candles and the last one is THIS candle');
  ok(ctx.bars.every((b) => b.time <= ctx.time), 'ctx: no future candle is ever visible');
  ok(ctx.back(1).close === bars[i - 1].close && ctx.back(3).time === bars[i - 3].time && makeCtx(bars, 0).back(1) === null, 'ctx: back(k) gives the same view k candles earlier (null at the start)');
  const closes = bars.slice(i - 299, i + 1).map((b) => b.close);
  ok(ctx.ema(20) === S.ema(closes, 20) && ctx.rsi(14) === S.rsi(closes, 14), 'ctx: ema / rsi equal the engine\'s own indicators on the same window');
  ok(ctx.highest(20) === Math.max(...bars.slice(i - 20, i).map((b) => b.max)) && ctx.lowest(20) === Math.min(...bars.slice(i - 20, i).map((b) => b.min)), 'ctx: highest/lowest look at the 20 candles BEFORE this one');
  const bb = ctx.bollinger(20, 2); ok(bb && bb.lower < bb.mid && bb.mid < bb.upper, 'ctx: bollinger returns lower < mid < upper');
  ok(Math.abs(ctx.sma(5) - bars.slice(i - 4, i + 1).reduce((a, b) => a + b.close, 0) / 5) < 1e-9, 'ctx: sma is the plain average of the last N closes');
  ok(/period must be/.test(throwsMsg(() => ctx.ema(0)) || '') && /period must be/.test(throwsMsg(() => ctx.rsi(300)) || '') && /period must be/.test(throwsMsg(() => ctx.sma(2.5)) || ''), 'ctx: an impossible period (0, 300, 2.5) is a clear error');
  ok(makeCtx(bars, 5).ema(50) === null && makeCtx(bars, 5).highest(20) === null, 'ctx: not enough history -> null (not a made-up number)');

  // ---- 3) errors in your code never crash anything ----
  resetCustomErrors();
  ok(runCustomFn('js_boom', STRATEGIES.js_boom, ctx) === 'none' && customErrors('js_boom').count === 1 && /typo/.test(customErrors('js_boom').message), 'errors: a throwing strategy counts as "no signal" and the message is kept');
  ok(strategySignal('js_async_one', { ctx }, null, cfg.rsi) === 'none' && /async/.test(customErrors('js_async_one').message), 'errors: an async signal() is refused with an explanation');
  ok(runCustomFn('x', { fn: () => 1 }, ctx) === 'buy' && runCustomFn('x', { fn: () => -1 }, ctx) === 'sell' && runCustomFn('x', { fn: () => undefined }, ctx) === 'hold', 'errors: 1 / -1 / nothing map to buy / sell / hold');
  ok(strategySignal('does_not_exist', { rsi: 10 }, null, cfg.rsi) === 'none' && evalStrategy('does_not_exist', { rsi: 10 }, null, cfg.rsi) === 'none', 'unknown id: never silently trades as another strategy (was: fell back to RSI)');

  // ---- 4) combinations ----
  const bad = (o) => custom.cleanCombo(o).error;
  const good = { name: 'روند + شکست', components: ['trend_ma', 'breakout'], entryVotes: 2, exitVotes: 1 };
  ok(!bad(good), 'combo: a normal definition is accepted');
  ok(bad({ ...good, name: '  ' }) && bad({ ...good, components: ['trend_ma'] }) && bad({ ...good, components: ['trend_ma', 'nope'] }), 'combo: empty name / one part / unknown part are refused');
  ok(bad({ ...good, entryVotes: 3 }) && bad({ ...good, exitVotes: 0 }) && bad({ ...good, entryVotes: '' }), 'combo: votes must be between 1 and the number of parts');
  ok(bad({ ...good, rsiBuy: 0 }) && bad({ ...good, rsiBuy: 60, rsiSell: 50 }) && !bad({ ...good, rsiBuy: 40, rsiSell: 65 }), 'combo: RSI levels must be 1..99 and buy < sell');
  ok(bad({ ...good, components: ['setup_trend_dip', 'breakout'] }), 'combo: a combination cannot contain another combination');

  const added = custom.addCombo(good);
  ok(/^combo_[a-z0-9]+$/.test(added.id) && STRATEGIES[added.id] && STRATEGIES[added.id].kind === 'combo', 'combo: saved, given a combo_ id and registered');
  ok(JSON.parse(fs.readFileSync(COMBOS, 'utf8')).length === 1, 'combo: persisted to disk');
  ok(/ترکیب دلخواه/.test(STRATEGIES[added.id].description) && STRATEGY_READS[added.id].fields.includes('hh') && STRATEGY_READS[added.id].fields.includes('emaShort'), 'combo: description is generated and it reads what its parts read');
  ok(throwsMsg(() => custom.addCombo(good)) === 'ترکیبی با همین نام وجود دارد', 'combo: the same name twice is refused');
  const id1 = added.id;
  const cur = (o) => ({ emaShort: 11, emaLong: 10, close: 3, hh: 4, ll: 1, ...o });
  ok(strategySignal(id1, cur({}), null, cfg.rsi) === 'hold', 'combo vote: trend is up but price has not broken out (1 of 2 agree, 2 needed) -> hold');
  ok(strategySignal(id1, cur({ close: 5 }), null, cfg.rsi) === 'buy', 'combo vote: trend up AND breakout (2 of 2) -> buy');
  ok(strategySignal(id1, cur({ emaShort: 9 }), null, cfg.rsi) === 'sell', 'combo vote: one bearish part is enough to close when exitVotes = 1');
  const two = custom.addCombo({ name: 'اجماع نرم', components: ['trend_ma', 'breakout', 'momentum_macd'], entryVotes: 2, exitVotes: 2 });
  ok(strategySignal(two.id, { emaShort: 11, emaLong: 10, close: 5, hh: 4, ll: 1, hist: -1 }, null, cfg.rsi) === 'buy', 'combo vote: 2 of 3 bullish -> buy');
  ok(strategySignal(two.id, { emaShort: 9, emaLong: 10, close: 0.5, hh: 4, ll: 1, hist: 1 }, null, cfg.rsi) === 'sell' && strategySignal(two.id, { emaShort: 9, emaLong: 10, close: 2, hh: 4, ll: 1, hist: 1 }, null, cfg.rsi) === 'hold', 'combo vote: needs 2 bearish to sell; a single bearish part -> hold');
  const withJs = custom.addCombo({ name: 'RSI من + روند', components: ['js_rsi_mid', 'trend_ma'], entryVotes: 2, exitVotes: 1 });
  ok(STRATEGY_READS[withJs.id].custom === true && STRATEGY_READS[withJs.id].fields.includes('emaShort'), 'combo: a script strategy can be a part (it then reads ctx too)');
  const lowRsiBars = makeBars(400, 3600, end, 21, -0.004); // falling market -> low RSI
  const cx = makeCtx(lowRsiBars), rr = S.rsi(lowRsiBars.slice(-300).map((b) => b.close), 14);
  ok(rr < 45 && strategySignal('js_rsi_mid', { ctx: cx }, null, cfg.rsi) === 'buy', `script strategy reads ctx and votes (RSI ${rr.toFixed(0)} -> buy)`);
  const rsiCombo = custom.addCombo({ name: 'RSI سفارشی', components: ['rsi_dip', 'trend_ma'], entryVotes: 1, exitVotes: 2, rsiBuy: 40, rsiSell: 60 });
  ok(strategySignal(rsiCombo.id, { rsi: 35, emaShort: 9, emaLong: 10 }, null, { buy: 30, sell: 70 }) === 'buy' && STRATEGIES[rsiCombo.id].usesRsiThreshold === false, 'combo: its own RSI level (40) overrides the global 30 and Sweep will not vary it');
  ok(STRATEGIES[good.name] === undefined && custom.combosUsing('js_rsi_mid').includes('RSI من + روند'), 'combo: knows which combinations use a given part');
  ok(custom.removeCombo('combo_unknownid') === null && custom.removeCombo('rsi_dip') === null && custom.removeCombo(two.id) && !STRATEGIES[two.id], 'combo: delete works, unknown / built-in ids are refused');
  fs.writeFileSync(COMBOS, '{not json');
  ok(custom.load().combosError && throwsMsg(() => custom.addCombo({ ...good, name: 'x2' })), 'combo: a corrupt file is reported and never overwritten');
  fs.writeFileSync(COMBOS, JSON.stringify([{ id: 'combo_zz', ...good, name: 'ok one' }, { id: 'combo_yy', name: 'orphan', components: ['js_gone', 'trend_ma'], entryVotes: 1, exitVotes: 1 }]));
  st = custom.load();
  ok(st.combos.length === 2 && st.combos[0].valid && !st.combos[1].valid && /پیدا نشد/.test(st.combos[1].reason) && !STRATEGIES.combo_yy, 'combo: one whose part disappeared is shown as disabled with a reason, the rest still work');
  fs.writeFileSync(COMBOS, '[]');
  custom.load();

  // ---- 5) the shipped example file ----
  const exSrc = fs.readFileSync(path.join(__dirname, 'custom-strategies.example.js'), 'utf8');
  fs.writeFileSync(MINE, exSrc);
  st = custom.load();
  ok(!st.script.error && st.script.loaded.length === 0 && st.script.skipped.length >= 2, 'example: shipped switched OFF (nothing changes until you enable it)');
  fs.writeFileSync(MINE, exSrc.replace(/enabled:\s*false/g, 'enabled: true'));
  st = custom.load();
  ok(!st.script.error && st.script.loaded.length >= 2, `example: when enabled, ${st.script.loaded.length} strategies load`);
  resetCustomErrors();
  const exBars = makeBars(700, 3600, end, 33);
  const exSig = {};
  for (const { id } of st.script.loaded) {
    exSig[id] = new Set();
    for (let k = 320; k < exBars.length; k++) exSig[id].add(strategySignal(id, { ctx: makeCtx(exBars, k) }, null, cfg.rsi));
  }
  ok(Object.keys(exSig).every((id) => !customErrors(id)), 'example: every example strategy runs over 380 candles without an error');
  ok(Object.values(exSig).every((set) => set.has('hold') || set.has('buy') || set.has('sell')) && Object.values(exSig).some((set) => set.has('buy')), 'example: they produce real signals');
  fs.writeFileSync(MINE, MINE_SRC);
  custom.load();

  // ---- 6) the engine really uses them (offline candles from the cache folder) ----
  const SYM = 'BINANCE:BTCUSDT', dir = process.env.BT_CACHE;
  fs.mkdirSync(dir, { recursive: true });
  const put = (tf, b, n) => fs.writeFileSync(path.join(dir, `${SYM.replace(/[^A-Za-z0-9]/g, '_')}_${tf}_${n}.json`), JSON.stringify(b));
  put('60', makeBars(1200, 3600, end, 3), 1200);
  const comboForEngine = custom.addCombo({ name: 'ترکیب موتور', components: ['js_rsi_mid', 'trend_ma'], entryVotes: 1, exitVotes: 1 });
  // switch the extra filters off so the numbers below come from the strategy alone (restored right after)
  const saved = { c: cfg.confluence.enabled, t: cfg.risk.trendFilter, k: cfg.risk.cooldownMin };
  cfg.confluence.enabled = false; cfg.risk.trendFilter = false; cfg.risk.cooldownMin = 0;
  globalThis.__leak = false; globalThis.__calls = 0; resetCustomErrors();
  const m = await bt.runMatrix({ symbol: SYM, timeframes: ['60'], strategies: ['js_rsi_mid', 'js_boom', 'js_spy', comboForEngine.id, 'trend_ma'], days: 40, maxCandles: 1200 });
  const cell = (sid) => m.cells.find((c) => c.strategyId === sid);
  cfg.confluence.enabled = saved.c; cfg.risk.trendFilter = saved.t; cfg.risk.cooldownMin = saved.k;
  ok(cell('js_rsi_mid').summary && cell('js_rsi_mid').summary.n > 5, `engine: a script strategy really trades in the backtest (${cell('js_rsi_mid').summary && cell('js_rsi_mid').summary.n} trades)`);
  ok(cell(comboForEngine.id).summary && cell(comboForEngine.id).summary.n > 5 && cell(comboForEngine.id).strategyName === 'ترکیب موتور', 'engine: a combination (with a script part) trades too, under its own name');
  ok(cell('js_boom').error && cell('js_boom').verdict === 'insufficient' && /typo/.test(cell('js_boom').reasons[0]) && cell('js_boom').strategyError.count > 100, 'engine: a broken strategy is reported as BROKEN with the error message, not as a bad result');
  ok(globalThis.__calls > 300 && globalThis.__leak === false, `engine: ${globalThis.__calls} calls and the strategy never saw a candle after the one it was judging`);
  ok(cell('trend_ma').summary && !cell('trend_ma').strategyError, 'engine: built-in strategies in the same run are unaffected');
  const single = await bt.runBacktest({ symbols: [SYM], tf: '60', candles: 1200, strategyId: 'js_boom' });
  ok(single.strategyError && single.strategyError.count > 100 && /typo/.test(single.strategyError.message), 'engine: the single backtest report carries the strategy error too');
  const missing = await bt.runBacktest({ symbols: [SYM], tf: '60', candles: 1200, strategyId: 'js_deleted' });
  ok(missing.error === undefined, 'engine: an unknown strategyId passed explicitly is ignored by the dashboard route (falls back to the configured one)');
  const sw = await bt.runSweep({ symbols: [SYM], tf: '60', candles: 1200, strategyId: 'js_rsi_mid' });
  ok(sw && !sw.error && sw.total > 0, 'engine: Sweep works on a script strategy');

  // ---- 6b) the LIVE bot's signal detection uses them too (same function the backtest checks) ----
  const { detect } = require('./signal-engine');
  const liveCfg = { ...cfg, strategy: { id: 'js_rsi_mid' } };
  const falling = makeBars(400, 3600, end, 21, -0.004);
  const d1 = detect(falling.slice(0, 399), liveCfg), d2 = detect(falling, liveCfg);
  ok(['buy', 'hold', 'sell'].includes(d2.sig) && d2.prevSig === d1.sig && d2.fresh === ((d2.sig === 'buy' || d2.sig === 'sell') && d2.sig !== d1.sig), 'live: signal detection runs a script strategy and reports "fresh" only when the state just changed');
  const liveCombo = custom.addCombo({ name: 'ترکیب زنده', components: ['js_rsi_mid', 'trend_ma'], entryVotes: 1, exitVotes: 2 });
  const dc = detect(falling, { ...cfg, strategy: { id: liveCombo.id } });
  ok(['buy', 'hold', 'sell', 'none'].includes(dc.sig) && dc.sig === 'buy', 'live: a combination with a script part works in signal detection (falling market, RSI low -> buy)');
  ok(detect(falling, { ...cfg, strategy: { id: 'js_deleted' } }).sig === 'none', 'live: if the active strategy was deleted the bot gets "no signal" (it never trades as a different strategy)');

  // ---- 7) the worker thread picks up changes made after it started ----
  const runner = require('./backtest-runner');
  const late = custom.addCombo({ name: 'ساخته‌شده‌ی بعد از شروع', components: ['trend_ma', 'breakout'], entryVotes: 1, exitVotes: 1 });
  const viaWorker = await runner.run('matrix', { symbol: SYM, timeframes: ['60'], strategies: [late.id], days: 40, maxCandles: 1200 });
  ok(viaWorker.cells && viaWorker.cells[0].strategyName === 'ساخته‌شده‌ی بعد از شروع', 'worker: the backtest thread knows a combination created a moment ago (it re-reads before each job)');

  // ---- 8) the dashboard API ----
  const express = require('express');
  const app = express();
  app.use('/api/custom', require('./custom-routes')(cfg));
  const srv = http.createServer(app); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/api/custom`;
  const call = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  let r = await call('GET', '/');
  ok(r.status === 200 && Array.isArray(r.body.combos) && r.body.script && r.body.parts.some((p) => p.id === 'js_rsi_mid') && !r.body.parts.some((p) => STRATEGIES[p.id].components), 'api: GET lists combinations, script status and the parts a combination can use (never combinations)');
  r = await call('POST', '/combos', { name: 'از API', components: ['trend_ma', 'momentum_macd'], entryVotes: 2, exitVotes: 1 });
  ok(r.status === 200 && r.body.ok && r.body.combos.some((c) => c.name === 'از API' && c.valid), 'api: POST creates a combination');
  const apiId = r.body.id;
  r = await call('POST', '/combos', { name: 'bad', components: ['trend_ma'], entryVotes: 1, exitVotes: 1 });
  ok(r.status === 400 && /۲ تا ۶/.test(r.body.error), 'api: an invalid combination gets a 400 with a readable reason');
  cfg.strategy.id = apiId;
  r = await call('DELETE', '/combos/' + apiId);
  ok(r.status === 409, 'api: the combination the bot is currently using cannot be deleted');
  cfg.strategy.id = 'rsi_dip';
  r = await call('DELETE', '/combos/' + apiId);
  ok(r.status === 200 && !r.body.combos.some((c) => c.id === apiId), 'api: DELETE removes it');
  r = await call('DELETE', '/combos/combo_nothere');
  ok(r.status === 404, 'api: deleting something that does not exist is a 404');
  fs.writeFileSync(MINE, MINE_SRC.replace("id: 'rsi_mid'", "id: 'rsi_mid2'"));
  r = await call('POST', '/reload');
  ok(r.status === 200 && r.body.script.loaded.some((x) => x.id === 'js_rsi_mid2') && !STRATEGIES.js_rsi_mid, 'api: reload picks up an edited file immediately');
  srv.close();

  // ---- 9) the dashboard page ----
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/^<script>|<\/script>$/g, '');
  let compiled = true; try { new vm.Script(script); } catch { compiled = false; }
  ok(compiled && ['cbAdd', 'cbComps', 'cbList', 'jsStatus', 'jsReload'].every((x) => html.includes(`id="${x}"`)), 'page: the new section exists and the page script compiles');

  console.log(`\n${passed} custom-strategy checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
