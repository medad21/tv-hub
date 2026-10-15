// Forward-evidence report + candle archive, offline (synthetic candles, trades written to a temp journal). Run: npm test
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-evi-'));
Object.assign(process.env, { DATA_DIR: tmp, TRADE_LOG: path.join(tmp, 'trades.jsonl'), CONFIG_OVERRIDES_FILE: path.join(tmp, 'c.json'), TRIALS_FILE: path.join(tmp, 't.json'), MODE: 'signal' });
const cfg = require('./config'), bt = require('./backtest'), ev = require('./evidence'), store = require('./candle-store');
let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ok  ' + m); };

// ---- candle archive ----
{
  const bars = (t0, k) => Array.from({ length: k }, (_, i) => ({ time: t0 + i * 900, open: 1, max: 2, min: 0.5, close: 1.5, volume: 10 }));
  ok(store.merge('BINANCE:BTCUSDT', '15', bars(1000, 5)) === 5, 'archive: first candles are written');
  ok(store.merge('BINANCE:BTCUSDT', '15', bars(1000, 5)) === 0, 'archive: the same candles again add nothing (safe to call on every price update)');
  ok(store.merge('BINANCE:BTCUSDT', '15', bars(1000, 8)) === 3, 'archive: only the newer candles are appended');
  store._reset(); // pretend the program restarted: the archive must resume from what is on disk
  ok(store.merge('BINANCE:BTCUSDT', '15', bars(1000, 8)) === 0 && store.read('BINANCE:BTCUSDT', '15').length === 8, 'archive: survives a restart without duplicating anything');
  ok(store.merge('BINANCE:BTCUSDT', '15', [{ time: 99999, open: NaN, max: 1, min: 1, close: 1 }]) === 0, 'archive: a broken candle is never stored');
  const old = bars(1000, 8), fresh = bars(1000 + 6 * 900, 6); // fresh overlaps the last 2 archived candles
  const c = store.combine('BINANCE:BTCUSDT', '15', fresh, 0);
  ok(c.length === 12 && c.every((b, i) => i === 0 || b.time > c[i - 1].time), 'archive: older archived candles + a download combine into one ordered series with no duplicates');
  ok(store.combine('BINANCE:BTCUSDT', '15', fresh, 5).length === 5, 'archive: combine honours the requested number of candles');
  ok(store.summary().some((s) => s.file === 'BINANCE_BTCUSDT_15' && s.candles === 8), 'archive: summary lists what is stored');
}

// ---- pieces ----
{
  const row = (sym, entry, exit, pnl, extra = {}) => ({ symbol: sym, entryTime: entry * 1000, time: exit * 1000, entry: 100, qty: 1, pnl, ...extra });
  const g = ev.groupForward([row('A', 1000, 2000, 3, { reason: 'partial take-profit' }), row('A', 1000, 3000, 2), row('B', 1500, 2500, -1)]);
  ok(g.length === 2 && g[0].pnl === 5 && Math.abs(g[0].pct - 2.5) < 1e-9, 'a partial take-profit and the final exit of one entry count as ONE trade');
  const m = ev.match([{ symbol: 'A', entrySec: 1000 }, { symbol: 'B', entrySec: 5000 }], [{ symbol: 'A', entrySec: 1400 }, { symbol: 'B', entrySec: 9000 }, { symbol: 'C', entrySec: 1 }], 900);
  ok(m.matched === 1 && m.onlyForward === 1 && m.onlyBacktest === 2, 'matching: same symbol within 1.5 candles pairs up; the rest are "only bot" / "only backtest"');
  ok(ev.verdictOf({ nF: 2, nB: 3, agree: 0, fwdPct: [] }).id === 'too_early', 'verdict: almost no trades -> too early');
  ok(ev.verdictOf({ nF: 6, nB: 9, agree: 0.3, fwdPct: [] }).id === 'divergent', 'verdict: the bot does not do what the backtest does -> divergent');
  ok(ev.verdictOf({ nF: 12, nB: 12, agree: 0.9, fwdPct: new Array(12).fill(1) }).id === 'too_early', 'verdict: consistent but under 30 trades -> still "too early" for profit');
  const pos = Array.from({ length: 40 }, (_, i) => 1 + (i % 3) * 0.2), neg = pos.map((x) => -x), mixed = pos.map((x, i) => (i % 2 ? x : -x));
  ok(ev.verdictOf({ nF: 40, nB: 40, agree: 1, fwdPct: pos }).id === 'positive', 'verdict: 40 trades clearly above zero -> positive');
  ok(ev.verdictOf({ nF: 40, nB: 40, agree: 1, fwdPct: neg }).id === 'negative', 'verdict: 40 trades clearly below zero -> negative');
  ok(ev.verdictOf({ nF: 40, nB: 40, agree: 1, fwdPct: mixed }).id === 'inconclusive', 'verdict: 40 trades around zero -> inconclusive');
  ok(ev.everyDays('off') === null && ev.everyDays('') === 7 && ev.everyDays('14') === 14 && ev.everyDays('0') === 7, 'schedule setting: off / default 7 / custom days / nonsense -> default');
  const now = Date.now(); fs.rmSync(path.join(tmp, 'evidence-state.json'), { force: true });
  ok(ev.due(now, 7) === false && fs.existsSync(path.join(tmp, 'evidence-state.json')), 'schedule: the very first time only starts the clock, no report on day one');
  ok(ev.due(now + 3 * 86400000, 7) === false && ev.due(now + 8 * 86400000, 7) === true, 'schedule: due after 7 days, not before');
}

// ---- the whole check, against synthetic candles ----
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
function walk(seed, len, t0) { const r = rng(seed); let p = 100; const out = []; for (let i = 0; i < len; i++) { const o = p, c = o * (1 + 0.006 * gauss(r)); out.push({ time: t0 + i * 3600, open: o, max: Math.max(o, c) * 1.002, min: Math.min(o, c) * 0.998, close: c, volume: 1000 }); p = c; } return out; }
(async () => {
  const symbols = ['A:X1', 'A:X2', 'A:X3'], t0 = 1700000000, LEN = 6000;
  const data = Object.fromEntries(symbols.map((s, j) => [s, walk(11 + j, LEN, t0)]));
  const loader = async () => ({ data, stamps: {} });
  const lastT = t0 + (LEN - 1) * 3600, nowMs = (lastT + 1) * 1000, days = 120;
  const base = { risk: cfg.risk, rsi: cfg.rsi, confluence: cfg.confluence, strategy: { id: 'breakout' } };
  const common = { symbols, tf: '60', now: nowMs, days, loader, base, mode: 'signal' };

  const empty = await ev.check(common);
  ok(empty.backtest.trades >= 5 && empty.forward.trades === 0 && empty.verdict.id === 'divergent', `the bot made no trades while the backtest made ${empty.backtest.trades} -> divergent (e.g. program was off)`);

  // write the journal exactly as the backtest's own trades -> a perfectly faithful bot
  const prep = bt.buildPrep({ data, stamps: {} }, { symbols, tf: '60', candles: 3000 }, base).prep;
  const since = Math.floor(nowMs / 1000) - days * 86400;
  const res = bt.run(prep, ev.fractionFor(prep, since), 1, {}, base).trades.filter((t) => t.entryTime >= since);
  fs.writeFileSync(process.env.TRADE_LOG, res.map((t) => JSON.stringify({ time: t.exitTime * 1000, entryTime: t.entryTime * 1000, symbol: t.symbol, mode: 'signal', entry: t.entry, exit: t.exit, qty: t.qty, pnl: t.pnl, reason: t.reason })).join('\n') + '\n');
  const same = await ev.check(common);
  ok(same.match.agree === 1 && same.forward.trades === same.backtest.trades && Math.abs(same.forward.netPct - same.backtest.netPct) < 1e-6, `a bot that does exactly what the backtest does -> 100% matching entries and the same result (${same.forward.trades} trades)`);
  ok(typeof same.text === 'string' && same.text.includes('بک‌تست'), 'the report has a readable text for Telegram');

  // forward trades outside the window and in another mode are ignored
  fs.appendFileSync(process.env.TRADE_LOG, JSON.stringify({ time: (since - 5 * 86400) * 1000, entryTime: (since - 6 * 86400) * 1000, symbol: 'A:X1', mode: 'signal', entry: 1, qty: 1, pnl: 999 }) + '\n' + JSON.stringify({ time: nowMs - 1000, entryTime: nowMs - 5000, symbol: 'A:X1', mode: 'paper', entry: 1, qty: 1, pnl: 999 }) + '\n');
  const filtered = await ev.check(common);
  ok(filtered.forward.trades === same.forward.trades, 'trades older than the window, or from another mode, are not counted');

  const bad = await ev.check({ ...common, loader: async () => ({ data: {}, stamps: {} }) });
  ok(typeof bad.error === 'string', 'no candle data -> a clear error, not a made-up report');

  const saved = await ev.run(common);
  ok(ev.latest() && ev.latest().time === saved.time && fs.readFileSync(path.join(tmp, 'evidence-log.jsonl'), 'utf8').trim().split('\n').length === 1, 'a finished run is stored (latest report + one log line)');
  console.log(`\n${n} evidence/archive checks passed`);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
