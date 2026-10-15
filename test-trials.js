// Offline checks for the two honesty tools of the comparison: the RESEARCH LEDGER (how many ideas were really tried on a symbol,
// counted across runs, Sweeps and saved strategies) and the HOLD-OUT (the last part of the data that no selection decision may see).
// Run: node test-trials.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), vm = require('vm');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-trials-'));
for (const k of Object.keys(process.env)) if (/^TRIAL/.test(k)) delete process.env[k];
Object.assign(process.env, {
  CONFIG_OVERRIDES_FILE: path.join(tmp, 'config.local.json'), BT_CACHE: path.join(tmp, 'cache'), TRADE_LOG: path.join(tmp, 't.jsonl'),
  EVENT_LOG: path.join(tmp, 'e.log'), STATE_FILE: path.join(tmp, 's.json'), DATA_DIR: tmp, MODE: 'signal', TRIALS_FILE: path.join(tmp, 'trials.json'),
  CUSTOM_RULES_FILE: path.join(tmp, 'rules.json'), CUSTOM_COMBOS_FILE: path.join(tmp, 'combos.json'), CUSTOM_STRATEGIES_FILE: path.join(tmp, 'none.js'),
});
const cfg = require('./config');
const T = require('./trials');
const bt = require('./backtest');
const S = require('./strategy');
const custom = require('./custom-strategies');
let passed = 0;
const ok = (c, m) => { assert(c, m); passed++; console.log('  ok  ' + m); };
const L = (left, op, right) => ({ left, op, right });
const DAY = 86400, NOW = 1_800_000_000;
const base0 = () => ({ risk: { ...cfg.risk }, rsi: { ...cfg.rsi }, confluence: { ...cfg.confluence }, strategy: { id: 'trend_ma' } });

(async () => {
  // ================= 1) the ledger =================
  const k = (sym, tf, id, b = base0()) => T.trialKey(sym, tf, id, b);
  T.record('X', [k('X', '60', 'rsi_dip'), k('X', '60', 'trend_ma'), k('X', '240', 'trend_ma')], NOW);
  let s = T.summary('X', NOW);
  ok(s.trials === 3 && s.structures === 3 && s.variants === 3, 'ledger: three different (timeframe x strategy) ideas count as 3 trials');
  T.record('X', [k('X', '60', 'rsi_dip'), k('X', '60', 'trend_ma')], NOW + 5);
  ok(T.summary('X', NOW + 5).trials === 3, 'ledger: looking at the same idea again never adds to the count (idempotent)');
  const variants = (n) => Array.from({ length: n }, (_, i) => k('Y', '60', 'trend_ma', { ...base0(), risk: { ...cfg.risk, atrMult: 1 + i * 0.25 } }));
  T.record('Y', variants(8), NOW);
  ok(T.summary('Y', NOW).trials === 4 && T.summary('Y', NOW).variants === 8, 'ledger: 8 setting-variants of ONE idea count as 1 + log2(8) = 4 (related, not independent)');
  T.record('Y', variants(300).slice(0, 300), NOW);
  ok(T.summary('Y', NOW).trials === Math.ceil(1 + Math.log2(300)) && T.summary('Y', NOW).trials < 12, `ledger: 300 sweep points are ~${T.summary('Y', NOW).trials} tests, not 300 (and not just 1)`);
  ok(T.summary('X', NOW).trials === 3 && T.summary('nothing', NOW).trials === 1, 'ledger: symbols are separate; a symbol never tried reports 1 (the minimum)');
  // time window
  T.record('W', [k('W', '60', 'trend_ma')], NOW - 100 * DAY);
  ok(T.summary('W', NOW).structures === 0 && T.summary('W', NOW - 95 * DAY).structures === 1, 'ledger: work older than the window (90 days) stops counting');
  T.record('W', [k('W', '60', 'trend_ma')], NOW - 10 * DAY);
  ok(T.summary('W', NOW).structures === 1, 'ledger: running it again keeps it recent');
  T.record('W', [k('W', '60', 'breakout')], NOW + 300 * DAY);
  ok(!JSON.parse(fs.readFileSync(process.env.TRIALS_FILE, 'utf8')).W.s[k('W', '60', 'trend_ma').s], 'ledger: very old entries are dropped from the file (it cannot grow forever)');
  // fingerprints: identity is what a strategy DOES
  S.registerStrategy('t_a', { name: 'اسم اول', custom: true, kind: 'rules', fn: () => 'hold', rules: { entry: L({ ind: 'rsi' }, '<', 30) } });
  S.registerStrategy('t_b', { name: 'اسم دوم', custom: true, kind: 'rules', fn: () => 'hold', rules: { entry: L({ ind: 'rsi' }, '<', 30) } });
  S.registerStrategy('t_c', { name: 'اسم اول', custom: true, kind: 'rules', fn: () => 'hold', rules: { entry: L({ ind: 'rsi' }, '<', 31) } });
  ok(k('Z', '60', 't_a').s === k('Z', '60', 't_b').s && k('Z', '60', 't_a').s !== k('Z', '60', 't_c').s, 'fingerprint: renaming / re-saving the same rules is the same trial, changing one threshold is a new one');
  S.registerStrategy('t_s1', { name: 's', custom: true, kind: 'script', fn: (c) => (c.close > 1 ? 'buy' : 'hold') });
  S.registerStrategy('t_s2', { name: 's', custom: true, kind: 'script', fn: (c) => (c.close > 2 ? 'buy' : 'hold') });
  ok(k('Z', '60', 't_s1').s !== k('Z', '60', 't_s2').s && k('Z', '60', 'trend_ma').s !== k('Z', '240', 'trend_ma').s && k('Z', '60', 'trend_ma').s !== k('Q', '60', 'trend_ma').s, 'fingerprint: a script is identified by its code; timeframe and symbol are part of the identity');
  const pk = (id, mut) => k('Z', '60', id, mut(base0())).p;
  ok(pk('trend_ma', (b) => b) !== pk('trend_ma', (b) => ({ ...b, risk: { ...b.risk, atrMult: 3 } })) && pk('trend_ma', (b) => b) === pk('trend_ma', (b) => ({ ...b, risk: { ...b.risk, maxDrawdownPct: 99 } })), 'fingerprint: stop distance changes the trial, a money-only setting (max drawdown) does not');
  ok(pk('trend_ma', (b) => b) === pk('trend_ma', (b) => ({ ...b, rsi: { ...b.rsi, buy: 20 } })) && pk('rsi_dip', (b) => b) !== pk('rsi_dip', (b) => ({ ...b, rsi: { ...b.rsi, buy: 20 } })), 'fingerprint: the RSI level only matters for strategies that use it (no phantom trials)');
  T.record('P', [], NOW); T.recordPeek('P', variants(7), NOW);
  ok(T.summary('P', NOW).peeks === 7 && (T.recordPeek('P', variants(7), NOW + 1), T.summary('P', NOW + 1).peeks === 7) && T.summary('P', NOW + 200 * DAY).peeks === 0, 'ledger: hold-out peeks are counted per candidate (idempotent) and expire like trials');
  ok(T.reset('X') === true && T.summary('X', NOW).structures === 0 && T.summary('Y', NOW).structures === 1 && T.reset('X') === false, 'ledger: starting a fresh period wipes one symbol only');
  fs.writeFileSync(process.env.TRIALS_FILE, '{not json');
  T.record('R', [k('R', '60', 'trend_ma')], NOW);
  ok(T.summary('R', NOW).trials === 1 && JSON.parse(fs.readFileSync(process.env.TRIALS_FILE, 'utf8')).R, 'ledger: a corrupt file never crashes a run (it starts over and writes a valid file)');
  fs.rmSync(process.env.TRIALS_FILE);

  // ================= 2) the ledger inside a comparison =================
  function rnd(seed) { let x = seed; return () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }; }
  function noisy(n, end, seed) {
    const r = rnd(seed); let p = 100; const out = [];
    for (let i = 0; i < n; i++) { const open = p, close = open * (1 + 0.0004 + Math.sin(i / 40) * 0.004 + (r() - 0.5) * 0.02); out.push({ time: end - (n - 1 - i) * 3600, open, close, max: Math.max(open, close) * (1 + r() * 0.006), min: Math.min(open, close) * (1 - r() * 0.006), volume: 1000 + r() * 1000 }); p = close; }
    return out;
  }
  const end = NOW, dir = process.env.BT_CACHE; fs.mkdirSync(dir, { recursive: true });
  const put = (sym, bars, n = 1200) => fs.writeFileSync(path.join(dir, `${sym.replace(/[^A-Za-z0-9]/g, '_')}_60_${n}.json`), JSON.stringify(bars));
  const SYM = 'BINANCE:BTCUSDT';
  put(SYM, noisy(1200, end, 3));
  const args = { symbol: SYM, timeframes: ['60'], strategies: ['trend_ma', 'breakout'], days: 40, maxCandles: 1200, minTrades: 10 };
  const m1 = await bt.runMatrix(args);
  ok(m1.trials.trials === 2 && m1.cells.filter((c) => c.stat).every((c) => c.stat.tests === 2), 'comparison: a fresh symbol counts exactly the 2 cells it tested');
  const m2 = await bt.runMatrix(args);
  ok(m2.trials.trials === 2 && JSON.stringify(m2.cells.map((c) => c.stat)) === JSON.stringify(m1.cells.map((c) => c.stat)), 'comparison: running it again changes nothing (same count, same statistics)');
  const sweepBase = { risk: cfg.risk, rsi: cfg.rsi, confluence: cfg.confluence, strategy: { id: 'trend_ma' } };
  const grid = bt.sweepGrid(sweepBase);
  const eff = (o) => ({ ...sweepBase, risk: { ...sweepBase.risk, ...o.risk }, rsi: { ...sweepBase.rsi, ...o.rsi }, confluence: { ...sweepBase.confluence, ...o.confluence } });
  const fps = new Set([...grid.map((o) => T.paramsFingerprint(eff(o), 'trend_ma')), T.paramsFingerprint(sweepBase, 'trend_ma')]);
  const sw = await bt.runSweep({ symbols: [SYM], tf: '60', candles: 1200, strategyId: 'trend_ma' });
  ok(!sw.error && T.summary(SYM).variants >= fps.size, `sweep: all ${fps.size} distinct settings it tried were written to the ledger`);
  const expected = Math.ceil(1 + Math.log2(fps.size) - 1e-9) + 1; // trend_ma structure with its variants + breakout
  const m3 = await bt.runMatrix(args);
  ok(m3.trials.trials === expected && m3.trials.trials > 2 && m3.cells.filter((c) => c.stat).every((c) => c.stat.tests === expected), `comparison: after a Sweep the same table is corrected for ${expected} ideas instead of 2`);
  const c1 = m1.cells.find((c) => c.stat), c3 = m3.cells.find((c) => c.strategyId === c1.strategyId);
  ok(c3.stat.pAdj >= c1.stat.pAdj && c3.stat.p === c1.stat.p, 'comparison: the raw chance of luck is unchanged, the adjusted one can only get stricter');
  ok(/آزمایش‌های ثبت‌شده برای این نماد/.test(m3.text) && new RegExp(`معادل ${expected} آزمایش`).test(m3.text), 'report: the text says how many ideas were counted and where they came from');

  // ================= 3) hold-out =================
  const hv = bt.holdoutVerdict;
  ok(hv({ n: 9, ret: 50, pf: 3, avgR: 1, buyHold: 0 }).status === 'inconclusive' && hv({ n: 10, ret: 5, pf: 1.5, avgR: 0.2, buyHold: 0 }).status === 'confirmed' && hv({ n: 20, ret: -1, pf: 0.9, avgR: -0.1, buyHold: 0 }).status === 'failed' && hv({ n: 20, ret: 3, pf: 1.1, avgR: -0.01, buyHold: 0 }).status === 'failed' && hv({ n: 20, ret: 4, pf: Infinity, avgR: 1, buyHold: 0 }).status === 'confirmed', 'hold-out: under 10 trades proves nothing; positive return, PF >= 1 and positive average R confirm; anything else fails');
  const rel = { verdict: 'reliable', reasons: ['ok'], notes: ['n1'] };
  ok(bt.applyHoldout(rel, { status: 'failed', reason: 'r' }).verdict === 'suspect' && bt.applyHoldout(rel, { status: 'confirmed', reason: '' }).verdict === 'reliable' && bt.applyHoldout(rel, { status: 'inconclusive', reason: 'x' }).verdict === 'reliable' && bt.applyHoldout(rel, { status: 'inconclusive', reason: 'x' }).notes.length === 2, 'hold-out: failing the unseen part demotes "reliable" to "suspect"; inconclusive keeps it but adds a note');
  ok(bt.applyHoldout({ verdict: 'suspect', reasons: ['a'] }, { status: 'failed', reason: 'r' }).verdict === 'suspect' && bt.applyHoldout({ verdict: 'negative', reasons: ['a'] }, { status: 'confirmed', reason: '' }).verdict === 'negative', 'hold-out: it can only demote, never promote');

  // synthetic markets: a clean oscillation, optionally followed (after 70% of the window) by a tiny whipsaw that kills the idea
  const sine = (n, flipAt, whip) => { const out = []; let prev = 100; for (let i = 0; i < n; i++) { let c = 100 + 5 * Math.sin((2 * Math.PI * i) / 20); if (whip && i >= flipAt) c = 100 + 0.15 * [0, 1, 0, -1][i % 4]; out.push({ time: end - (n - 1 - i) * 3600, open: prev, close: c, max: Math.max(prev, c) * 1.002, min: Math.min(prev, c) * 0.998, volume: 1000 }); prev = c; } return out; };
  const saved = { c: cfg.confluence.enabled, t: cfg.risk.trendFilter, k: cfg.risk.cooldownMin };
  cfg.confluence.enabled = false; cfg.risk.trendFilter = false; cfg.risk.cooldownMin = 0;
  const idea = custom.addRules({ name: 'عبور از SMA', rules: { entry: L({ ind: 'close' }, 'crosses_above', { ind: 'sma', period: 10 }), exit: L({ ind: 'close' }, 'crosses_below', { ind: 'sma', period: 10 }) } });
  const dud = custom.addRules({ name: 'هیچ‌وقت نمی‌خرد', rules: { entry: L({ ind: 'close' }, '>', 1e8) } });
  const SYM2 = 'OANDA:XAUUSD';
  const mArgs = { symbol: SYM2, timeframes: ['60'], strategies: [idea.id, dud.id], days: 90, maxCandles: 2400, minTrades: 10 }; // 100 days of data: trades are resampled in 3-day blocks, so a short window has too few independent blocks to call anything reliable
  put(SYM2, sine(2400, 1770, false), 2400);
  const noHold = await bt.runMatrix({ ...mArgs, holdout: 0 });
  const same = await bt.runMatrix({ ...mArgs, holdout: 0.3 });
  const cell = (m, id) => m.cells.find((c) => c.strategyId === id);
  ok(noHold.holdout === null && cell(noHold, idea.id).holdout === null && cell(noHold, idea.id).verdict === 'reliable', 'hold-out off: nothing changes (the old behaviour is still available)');
  ok(cell(same, idea.id).verdict === 'reliable' && cell(same, idea.id).holdout.status === 'confirmed' && cell(same, idea.id).holdout.n >= 10, `hold-out: a rule that keeps working on unseen data is confirmed (${cell(same, idea.id).holdout.n} trades there)`);
  ok(cell(same, idea.id).summary.n < cell(noHold, idea.id).summary.n && cell(same, idea.id).window.candles < cell(noHold, idea.id).window.candles && same.holdout.fraction === 0.3 && same.holdout.from > same.window.from && same.holdout.to === same.window.to, 'hold-out: judging uses only the earlier 70% (fewer candles, fewer trades) and the kept-out part is the last 30% of the same window');
  ok(cell(same, dud.id).holdout === null && same.holdout.peeks === 1, 'hold-out: only the shortlisted candidate looked at the unseen part (a strategy that never trades did not)');
  const again = await bt.runMatrix({ ...mArgs, holdout: 0.3 });
  ok(again.holdout.peeks === 1, 'hold-out: asking again does not count as another look at the same candidate');
  put(SYM2, sine(2400, 1770, true), 2400);
  const whip = await bt.runMatrix({ ...mArgs, holdout: 0.3 }), whipOff = await bt.runMatrix({ ...mArgs, holdout: 0 });
  ok(cell(whipOff, idea.id).verdict === 'reliable', 'whipsaw market WITHOUT hold-out: the idea still looks reliable (the weakness the hold-out exists to catch)');
  const wc = cell(whip, idea.id);
  ok(wc.verdict === 'suspect' && wc.holdout.status === 'failed' && /دیده نشده/.test(wc.reasons[0]) && whip.best === null, 'whipsaw market WITH hold-out: the same idea fails on the unseen part, is demoted to "suspect", and no best combination is named');
  const sc = cell(same, idea.id);
  ok(['n', 'ret', 'pf', 'avgR', 'maxDD', 'winRate'].every((f) => sc.summary[f] === wc.summary[f]) && sc.wf.profitableFolds === wc.wf.profitableFolds && JSON.stringify(sc.stat.ci) === JSON.stringify(wc.stat.ci), 'NO LEAKAGE: with different data in the kept-out part, every number used for selection (trades, return, PF, folds, confidence interval) is identical');
  put(SYM2, sine(2400, 1770, false), 2400);
  const few = await bt.runMatrix({ ...mArgs, holdout: 0.05 });
  ok(cell(few, idea.id).holdout.status === 'inconclusive' && cell(few, idea.id).verdict === 'reliable' && cell(few, idea.id).notes.some((x) => /قطعی نداد/.test(x)), 'hold-out: a kept-out part with too few trades is "inconclusive" (and says so) instead of pretending');
  ok(/تقسیم داده: انتخاب و داوری فقط روی/.test(same.text) && /آزمون نهایی روی داده‌ی دیده‌نشده: ✅ تأیید شد/.test(same.text) && /❌ رد شد/.test(whip.text) && !/تقسیم داده/.test(noHold.text), 'report: the text explains the split and shows each shortlisted candidate\'s verdict on the unseen part');
  // too many looks make the unseen part less unseen
  const SYM3 = 'BINANCE:ETHUSDT'; put(SYM3, sine(2400, 1770, false), 2400);
  T.recordPeek(SYM3, variants(9));
  const worn = await bt.runMatrix({ ...mArgs, symbol: SYM3, holdout: 0.3 });
  ok(worn.holdout.peekWarn === true && cell(worn, idea.id).notes.some((x) => /دیده‌نشده» نیست/.test(x)) && /قبلاً برای بررسی \d+ ترکیب/.test(worn.text), 'hold-out: when many candidates have already looked at it, the report warns that it is no longer truly unseen');
  Object.assign(cfg.risk, { trendFilter: saved.t, cooldownMin: saved.k }); cfg.confluence.enabled = saved.c;

  // ================= 4) the API =================
  const express = require('express');
  const app = express(); app.use('/api/trials', require('./trials-routes')());
  const srv = http.createServer(app); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${srv.address().port}/api/trials`;
  let r = await (await fetch(`${api}/${encodeURIComponent(SYM)}`)).json();
  ok(r.trials >= 3 && r.windowDays === 90, 'api: GET shows the ledger summary of a symbol (the colon in the symbol name is handled)');
  r = await (await fetch(`${api}/${encodeURIComponent(SYM)}`, { method: 'DELETE' })).json();
  ok(r.ok && r.wiped === true && r.structures === 0 && (await (await fetch(`${api}/${encodeURIComponent(SYM2)}`)).json()).structures >= 1, 'api: DELETE starts a fresh period for that symbol only');
  r = await (await fetch(`${api}/${encodeURIComponent(SYM)}`, { method: 'DELETE' })).json();
  ok(r.wiped === false, 'api: wiping an empty symbol is harmless');
  srv.close();

  // ================= 5) the page =================
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/^<script>|<\/script>$/g, '');
  ok(html.includes('id="mxHoldout"') && /type="checkbox" checked/.test(html.slice(html.indexOf('id="mxHoldout"') - 20, html.indexOf('id="mxHoldout"') + 80)) && script.includes("holdout: $('mxHoldout').checked ? 0.25 : 0"), 'page: the hold-out switch exists, is ON by default and is sent with the request');
  ok(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').includes('holdout: Math.min(0.5, Math.max(0, Number(body.holdout) || 0))') && fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').includes("'/api/trials'"), 'server: passes the hold-out (clamped to 0..50%) to the comparison and mounts the ledger API');
  const els = {}; const sb = { $: (id) => (els[id] = els[id] || { style: {}, addEventListener() {} }), esc: (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), tfLabel: (x) => x, URL, Blob, confirm: () => true, fetch: async () => ({}), document: { createElement: () => ({}) } };
  vm.createContext(sb);
  vm.runInContext((html.match(/^const (pct|fx|pfx) = .*$/gm) || []).join('\n') + '\n' + script.slice(script.indexOf('const MX_BADGE'), script.indexOf('async function runMatrixCompare')) + ';this.renderMxResults = renderMxResults;', sb);
  const payload = (hold) => JSON.parse(JSON.stringify({
    symbol: 'X', window: { from: 1, to: 86400 * 100, days: 100 }, assumptions: { fillMode: 'next_open', costs: { feePct: 0, slippagePct: 0.03 } }, cellsTested: 1, best: null, text: 't',
    trials: { trials: 7, windowDays: 90 }, holdout: hold ? { fraction: 0.25, from: 86400 * 70, to: 86400 * 100, days: 25, trainDays: 75, peeks: 9, peekWarn: true } : null,
    cells: [{ tf: '240', strategyId: 'a', strategyName: 'روند', verdict: 'suspect', reasons: ['x'], summary: { n: 46, ret: 6.8, pf: 2.33, avgR: 0.47, maxDD: 2.2, buyHold: 4 }, wf: { folds: 5, profitableFolds: 4 }, holdout: hold ? { status: 'failed', n: 14, ret: -3.2, reason: '14 معامله' } : null }],
  }));
  sb.renderMxResults(payload(true));
  const out = els.mxResults.innerHTML;
  ok(/آزمون نهایی: ✗ رد \(14 معامله/.test(out) && /معادل <b>7<\/b>/.test(out) && /شروع دوره‌ی تازه/.test(out) && /داوری فقط روی/.test(out) && /قبلاً برای بررسی 9 ترکیب/.test(out), 'page: shows the split, the ledger count with a "fresh period" button, the per-cell hold-out result and the "no longer unseen" warning');
  let threw = null; try { sb.renderMxResults(payload(false)); } catch (e) { threw = e; }
  ok(!threw && !/آزمون نهایی:/.test(els.mxResults.innerHTML) && !/داوری فقط روی/.test(els.mxResults.innerHTML), 'page: with hold-out off nothing about it is shown and nothing breaks');

  console.log(`\n${passed} ledger / hold-out checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
