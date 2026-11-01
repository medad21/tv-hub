// Offline checks for the ML lab's idle auto-runner (ml-auto.js): when it may run (window / CPU / lab busy), that it NEVER shows the search a
// candle from the sealed period, that a manual run stops it, the multiple-testing correction in the leaderboard, the one-time sealed final check,
// persistence, the candle counts — and one real end-to-end run on synthetic archives. Run: node test-ml-auto.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mlauto-'));
process.env.CANDLE_DIR = path.join(tmp, 'candles'); process.env.TRIALS_FILE = path.join(tmp, 'trials.json'); process.env.DATA_DIR = tmp;
const candleStore = require('./candle-store');
const trials = require('./trials');
const lock = require('./ml-lock');
const cfg = require('./config');
const { STRATEGIES } = require('./strategy');
const A = require('./ml-auto');
let passed = 0;
const ok = (c, m) => { assert(c, m); passed++; console.log('  ok  ' + m); };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
function makeBars(n, seed, drift = 0, step = 3600, t0 = 1700000000) {
  const r = rng(seed), bars = []; let c = 100;
  for (let i = 0; i < n; i++) {
    const time = t0 + i * step, hr = Math.floor(time / 3600) % 24, o = c;
    c = o * Math.exp((hr < 12 ? drift : -drift) + 0.004 * gauss(r));
    bars.push({ time, open: o, max: Math.max(o, c) * (1 + Math.abs(gauss(r)) * 0.0015), min: Math.min(o, c) * (1 - Math.abs(gauss(r)) * 0.0015), close: c, volume: 1000 + Math.floor(r() * 500) });
  }
  return bars;
}
const T0 = 1700000000, N = 9000, SEALED = T0 + 7000 * 3600; // the last 2000 candles of every archive are sealed
const NAMES = ['TSTA', 'TSTB', 'TSTC', 'TSTD'];
const seed = (drift) => NAMES.forEach((n, k) => candleStore.merge(`BINANCE:${n}USDT`, '60', makeBars(N, 100 + k, drift)));
const fresh = (file) => path.join(tmp, file);
let T = new Date(2026, 9, 23, 3, 0, 0).getTime();
const make = (over = {}) => A.create({ candleStore, cfg, trials, STRATEGIES, file: fresh(over.file || 'auto.json'), now: () => T, cpuSampler: over.cpu || (async () => 10), runJob: over.runJob, tickMs: 1e9 });
const fakeRes = (o = {}) => ({ ok: true, ms: 5, candles: 36000, from: 1, to: 2, auc: { long: o.auc ?? 0.52, short: o.auc ?? 0.52 }, foldsProfitable: 3, foldsWithTrades: 5, cost: { avgAtr: 0.5 },
  meta: { signals: 1000, selected: { trades: o.trades ?? 120, meanR: o.sel ?? 0.1, winRate: 0.45, totalR: 12 }, takeAll: { trades: 600, meanR: o.all ?? -0.05, winRate: 0.4, totalR: -30 }, gainR: (o.sel ?? 0.1) - (o.all ?? -0.05) },
  stats: { aucCI: { long: [0.5, 0.54] }, aucPerm: { p: o.pAuc ?? 0.1 }, tradePerm: { p: o.pTrade ?? 0.2 }, effectiveN: 500 }, verdict: { level: 'weak', text: 'x' } });
function scripted(handler) {
  const calls = [];
  const runJob = (data) => { calls.push(data); const out = handler(data, calls.length); let resolve; const promise = new Promise((res) => { resolve = res; if (out !== 'hang') res({ ok: true, res: out }); }); return { promise, cancel: () => resolve({ preempted: true }) }; };
  return { runJob, calls };
}

(async () => {
  // 1. the idle window
  {
    const at = (h) => new Date(2026, 9, 23, h, 30, 0).getTime();
    const w = { startHour: 1, endHour: 7 }, x = { startHour: 22, endHour: 6 }, e = { startHour: 5, endHour: 5 };
    ok(!A.inWindow(at(0), w) && A.inWindow(at(1), w) && A.inWindow(at(6), w) && !A.inWindow(at(7), w), 'window 1-7: inside from 01:00 to 06:59 only');
    ok(A.inWindow(at(23), x) && A.inWindow(at(3), x) && !A.inWindow(at(12), x) && !A.inWindow(at(6), x), 'window 22-6 crosses midnight correctly');
    ok(A.inWindow(at(0), e) && A.inWindow(at(13), e), 'equal hours = any time of the day');
  }
  // 2. settings are sanitised
  {
    const s = A.sanitize({ maxCpu: 500, startHour: 99, dirs: ['bogus'], strategies: ['rsi_dip', 'nope'], kinds: ['x'], minArchives: 1, tfs: ['60', 'zz', 'D'], base: { horizon: 9999, costMode: 'real', features: ['time', 'structure'] } }, A.DEFAULTS, Object.keys(STRATEGIES));
    ok(s.maxCpu === 100 && s.startHour === 23 && s.dirs.join() === 'long' && s.strategies.join() === 'rsi_dip' && s.kinds.join() === 'crypto,mt5' && s.minArchives === 2 && s.tfs.join() === '60,D', 'out-of-range or unknown values are clamped / dropped');
    ok(s.base.horizon === 100 && s.base.costMode === 'real' && !s.base.features.includes('structure'), 'lab parameters go through the lab\'s own normaliser; the slow structure features are dropped');
  }
  // 3. what would be tested
  seed(0.0012);
  candleStore.merge('BINANCE:TSTEUSDT', '30', makeBars(5000, 9, 0, 1800)); candleStore.merge('BINANCE:TSTFUSDT', '30', makeBars(5000, 10, 0, 1800)); // only 2 archives of 30m: not enough for a group
  candleStore.merge('BINANCE:TSTGUSDT', '60', makeBars(800, 11)); // far too short
  {
    const a = make();
    const us = a.universes();
    ok(us.length === 1 && us[0].tf === '60' && us[0].kind === 'crypto' && us[0].archives.length === 4, 'groups archives by timeframe + market; a 2-archive group and a too-short archive are left out');
    a.setSettings({ enabled: true, sealedFrom: SEALED });
    const q = a.queue(), builtin = Object.entries(STRATEGIES).filter(([, d]) => !d.custom).length;
    ok(q.length === builtin && q.every((x) => x.why === 'new') && builtin >= 7, `queue: ${builtin} strategies x 1 direction x 1 group, all new`);
    ok(a.setSettings({ dirs: ['long', 'short'] }) && a.queue().length === builtin * 2, 'both directions double the queue');
    a.setSettings({ dirs: ['long'] });
  }
  // 4. when it may run + the sealed period is never shown to the search + one job at a time
  {
    const sc = scripted(() => fakeRes());
    let cpu = 10;
    const a = make({ file: 'a4.json', runJob: sc.runJob, cpu: async () => cpu });
    ok((await a.runNext()).reason === 'disabled', 'disabled -> does nothing');
    a.setSettings({ enabled: true, sealedFrom: SEALED, startHour: 1, endHour: 7 });
    T = new Date(2026, 9, 23, 12, 0, 0).getTime();
    ok((await a.runNext()).reason === 'outside_window', 'outside the window -> waits');
    T = new Date(2026, 9, 23, 3, 0, 0).getTime();
    cpu = 90; ok((await a.runNext()).reason === 'cpu_busy', 'CPU above the limit -> waits');
    cpu = 10; const mt = lock.acquire('manual');
    ok((await a.runNext()).reason === 'lab_busy', 'a manual run holds the lab -> waits'); lock.release(mt);
    const r1 = await a.runNext();
    ok(r1.started && sc.calls.length === 1, 'idle, inside the window, CPU low -> starts one job');
    await a.idle();
    const d = sc.calls[0];
    ok(d.meta && d.sets.length === 4 && d.sets.every((s) => s.bars.length > 1000 && s.bars.every((b) => b.time < SEALED)), 'SEALED: not one candle at or after the sealed date reaches the search');
    ok(d.cutoff === null && d.opts.costMode === 'real' && d.costTable && d.costTable.costs, 'job carries the bot\'s cost table and no cutoff');
    ok(a.status().board.tested === 1 && a._state().rows[0].selected.trades === 120, 'the result is stored as a compact row');
    while ((await a.runNext()).started) await a.idle();
    const builtin = Object.entries(STRATEGIES).filter(([, x]) => !x.custom).length;
    ok(a.status().board.tested === builtin && (await a.runNext()).reason === 'nothing_to_do', 'works through every combination, then reports nothing left to do');
    // growth triggers a retest, no growth does not
    candleStore.merge('BINANCE:TSTAUSDT', '60', makeBars(N, 100, 0.0012, 3600, T0 + N * 3600)); // newer candles only: after the sealed date, so the search data does not change
    T += 120000; ok((await a.runNext()).reason === 'nothing_to_do', 'new candles in the sealed period do not make a combination stale');
  }
  // 5. a manual run stops the background job, which is simply tried again later
  {
    const sc = scripted((d, n) => (n === 1 ? 'hang' : fakeRes()));
    const a = make({ file: 'a5.json', runJob: sc.runJob });
    a.setSettings({ enabled: true, sealedFrom: SEALED, startHour: 5, endHour: 5, strategies: ['rsi_dip'] });
    ok((await a.runNext()).started && a.status().current && a.status().current.strategy === 'rsi_dip', 'a job is running (and shown as current)');
    ok((await a.runNext()).reason === 'running', 'only one job at a time (a second request while one runs is refused)');
    ok(!lock.canTake('auto') && lock.canTake('manual'), 'the lab is taken for the auto job, but a manual run may take it');
    const tok = lock.acquire('manual');
    ok(tok, 'manual run takes the lab (the background job is stopped)');
    await a.idle();
    ok(a.status().current === null && a.status().board.tested === 0, 'the stopped job left no result behind');
    lock.release(tok);
    ok((await a.runNext()).started && (await a.idle(), a.status().board.tested === 1), 'afterwards the same combination runs again and is recorded');
  }
  // 6. leaderboard: eligibility, ranking, multiple-testing correction
  {
    const plan = { rsi_dip: { pTrade: 0.001, trades: 150, sel: 0.2, all: -0.1 }, trend_ma: { pTrade: 0.03, trades: 150, sel: 0.15, all: 0.0 }, breakout: { pTrade: 0.002, trades: 20, sel: 0.5, all: 0 }, momentum_macd: { pTrade: 0.5, trades: 200, sel: 0.01, all: -0.02 }, setup_trend_dip: { pTrade: 0.1, trades: 200, sel: -0.05, all: -0.1 } };
    const sc = scripted((d) => fakeRes(plan[d.strategy] || { pTrade: 0.9, sel: -0.1, all: -0.1 }));
    const a = make({ file: 'a6.json', runJob: sc.runJob });
    a.setSettings({ enabled: true, sealedFrom: SEALED, startHour: 0, endHour: 0 });
    while ((await a.runNext()).started) await a.idle();
    const b = a.status().board, K = b.tested;
    ok(K >= 7 && b.top.map((r) => r.strategy).join() === 'rsi_dip,trend_ma,momentum_macd', `eligible = enough trades, positive, better than all signals; ranked by corrected p (${b.top.map((r) => r.strategy)})`);
    const byS = Object.fromEntries(b.top.map((r) => [r.strategy, r]));
    ok(Math.abs(byS.rsi_dip.pAdj - Math.min(1, 0.001 * K)) < 1e-9 && Math.abs(byS.trend_ma.pAdj - Math.min(1, 0.03 * K)) < 1e-9, `corrected p = p x number of combinations tried (${K})`);
    ok(byS.rsi_dip.status === 'candidate' && byS.trend_ma.status === 'luck_likely' && byS.momentum_macd.status === 'luck_likely', 'only a result that survives the correction is a "candidate"; the rest is labelled luck-likely');
    ok(b.expectedByLuck === Math.round(0.05 * K * 10) / 10 && b.rawSignificant === 3 && b.adjSignificant === 2, `summary: ${b.rawSignificant} look significant raw, ${b.adjSignificant} after correction, luck alone would give ~${b.expectedByLuck}`);
  }
  // 7. the sealed final check: once, only on the sealed period, and the date is then locked
  {
    let mode = 'search';
    const sc = scripted((d) => (d.cutoff ? fakeRes({ pTrade: 0.01, trades: 80, sel: 0.2, all: 0 }) : fakeRes({ pTrade: 0.0001, sel: 0.3, all: -0.1 })));
    const a = make({ file: 'a7.json', runJob: sc.runJob });
    a.setSettings({ enabled: true, sealedFrom: SEALED, startHour: 0, endHour: 0, strategies: ['rsi_dip'] });
    ok((await a.runForward('nope')).reason === 'not_found', 'final check of an unknown combination -> refused');
    await a.runNext(); await a.idle();
    const id = a.status().board.top[0].id;
    const early = make({ file: 'a7b.json', runJob: sc.runJob }); early.setSettings({ enabled: true, sealedFrom: T0 + 17900 * 3600, startHour: 0, endHour: 0, strategies: ['rsi_dip'] }); await early.runNext(); await early.idle();
    const r0 = await early.runForward(early.status().board.top[0].id);
    ok(r0.reason === 'not_enough_sealed', 'too few sealed candles -> says so instead of running a meaningless check');
    const r1 = await a.runForward(id); await a.idle();
    const d = sc.calls[sc.calls.length - 1];
    ok(r1.started && d.cutoff === SEALED && d.sets.every((s) => s.bars.some((b) => b.time >= SEALED) && s.bars.some((b) => b.time < SEALED)), 'final check: cutoff = sealed date; the job gets the older candles to learn from and the sealed ones to be tested on');
    const row = a.status().board.top[0];
    ok(row.forward && row.forward.passed === true && row.status === 'forward_passed' && a.status().forwardCount === 1, 'passed final check is stored on the row');
    ok((await a.runForward(id)).reason === 'already_done', 'the final check can be run only once per combination');
    let err = null; try { a.setSettings({ sealedFrom: SEALED - 86400 }); } catch (e) { err = e; }
    ok(err && err.status === 400 && /تاریخ کنارگذاری/.test(err.message), 'after a final check the sealed date cannot be moved');
    a.reset(); ok(a.status().board.tested === 0 && a.status().forwardCount === 0 && a.setSettings({ sealedFrom: SEALED - 86400 }).settings.sealedFrom === SEALED - 86400, 'reset clears the results and unlocks the date');
  }
  // 8. candle counts and "what changed"
  {
    const a = make({ file: 'a8.json', runJob: scripted(() => fakeRes()).runJob });
    a.setSettings({ enabled: true, sealedFrom: SEALED, startHour: 0, endHour: 0 });
    const c1 = a.status().candles;
    ok(c1.total > 0 && c1.search + c1.sealed > 0 && c1.sealed > 0 && c1.usedFiles === 4 && c1.universes[0].files === 4, `candles: total ${c1.total}, search ${c1.search}, sealed ${c1.sealed}, in ${c1.usedFiles} archives`);
    candleStore.merge('BINANCE:TSTBUSDT', '60', makeBars(300, 5, 0, 3600, T0 + (N + 5000) * 3600));
    T += 5 * 60 * 1000;
    const c2 = a.status().candles;
    ok(c2.lastChange && c2.lastChange.delta === 300 && c2.total === c1.total + 300, 'when the archive grows, the status says by how many candles and when');
  }
  // 9. persistence
  {
    const a = make({ file: 'a6.json' });
    ok(a.status().board.tested >= 7 && a.status().settings.sealedFrom === SEALED && a.status().settings.enabled === true, 'results and settings survive a restart (read back from the file)');
  }
  // 10. real end-to-end: real worker, real data with a hidden pattern, search then the sealed final check
  {
    const a = make({ file: 'a10.json' });
    a.setSettings({ enabled: true, sealedFrom: SEALED, startHour: 0, endHour: 0, strategies: ['trend_ma'], base: { horizon: 20, folds: 4, features: ['time'], costMode: 'fixed', costAtr: 0.1 } });
    const r = await a.runNext({ force: true }); await a.idle();
    const row = a.status().board.top[0];
    ok(r.started && row && row.strategy === 'trend_ma' && row.selected.meanR > row.takeAll.meanR + 0.1 && row.signals > 100, `real run: the filter beats taking every signal (${row && row.selected.meanR.toFixed(2)}R vs ${row && row.takeAll.meanR.toFixed(2)}R)`);
    ok(row.files.length === 4 && row.fp && Object.values(row.fp).every((n) => n > 5000 && n <= 7000), 'the row remembers which archives and how many search candles each had');
    const f = await a.runForward(row.id); await a.idle();
    const fr = a.status().board.top[0].forward;
    ok(f.started && fr && fr.ok && fr.selected.meanR > 0 && fr.gainR > 0, `real final check on the sealed period: positive and better than all signals (${fr && fr.selected.meanR.toFixed(2)}R vs ${fr && fr.takeAll.meanR.toFixed(2)}R)`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
