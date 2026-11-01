// Offline checks for the pooled ML lab (ml-pooled.js + /api/ml/run-pooled): one model, several symbols, tested on time AND on a symbol it
// never saw. Most important: pure noise is NOT sold as an edge, a planted pattern IS found on a symbol held out of training, and a symbol
// WITHOUT the pattern does not borrow credit from the others. Run: node test-ml-pooled.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mlpool-'));
process.env.CANDLE_DIR = path.join(tmp, 'candles'); process.env.TRIALS_FILE = path.join(tmp, 'trials.json'); process.env.DATA_DIR = tmp;
const ml = require('./ml');
const mp = require('./ml-pooled');
let passed = 0;
const ok = (c, m) => { assert(c, m); passed++; console.log('  ok  ' + m); };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
function makeBars(n, seed, revert = 0, common = null, step = 3600) {
  const r = rng(seed), bars = []; let c = 100, ema = 100;
  for (let i = 0; i < n; i++) {
    const o = c, pull = -revert * (c - ema) / c, ret = pull + 0.004 * gauss(r) + (common ? 0.002 * common[i] : 0);
    c = o * Math.exp(ret); ema += (c - ema) * 2 / 21;
    const hi = Math.max(o, c) * (1 + Math.abs(gauss(r)) * 0.0015), lo = Math.min(o, c) * (1 - Math.abs(gauss(r)) * 0.0015);
    bars.push({ time: 1700000000 + i * step, open: o, max: hi, min: lo, close: c, volume: 1000 + Math.floor(r() * 500) });
  }
  return bars;
}
const N = 7000, rc = rng(5), common = Array.from({ length: N }, () => gauss(rc));
const mk = (revs, base = 200) => revs.map((rv, k) => ({ name: 'S' + k, bars: makeBars(N, base + k, rv, common) }));
const fast = { folds: 4, features: [] };

(async () => {
  // 1. noise: several seeds and both modes — never "promising", and the permutation test does not call it significant
  for (const [mode, base] of [['loso', 300], ['walk', 400]]) {
    const r = mp.runPooled(mk([0, 0, 0], base), { ...fast, mode });
    ok(r.ok && r.pooled && r.mode === mode && r.perSymbol.length === 3, `${mode}: complete report for 3 noise symbols`);
    ok(r.verdict.level !== 'promising', `${mode}: pure noise is not called promising (level ${r.verdict.level}, AUC ${Math.max(r.auc.long, r.auc.short).toFixed(3)})`);
    ok(r.stats.aucPerm && r.stats.aucPerm.p > 0.02, `${mode}: permutation test does not call noise significant (p ${r.stats.aucPerm.p.toFixed(3)})`);
  }
  // 2. a planted pattern shared by all symbols is found on symbols the model never trained on
  {
    const r = mp.runPooled(mk([0.06, 0.06, 0.06]), { ...fast, mode: 'loso' });
    ok(Math.max(r.auc.long, r.auc.short) > 0.55, `loso: planted pattern found on held-out symbols (AUC ${Math.max(r.auc.long, r.auc.short).toFixed(3)})`);
    ok(r.stats.aucPerm.p < 0.05 && r.stats.aucCI[r.auc.long >= r.auc.short ? 'long' : 'short'][0] > 0.5, 'loso: permutation test and the AUC interval both agree it is real');
    ok(r.perSymbol.every((x) => Math.max(x.aucLong, x.aucShort) > 0.54), 'loso: every symbol, tested without itself in training, shows the pattern');
  }
  // 3. leakage audit: held-out symbol never in training; every training label finished before its test block began
  {
    const r = mp.runPooled(mk([0.06, 0, 0.06]), { ...fast, mode: 'loso' });
    ok(r.audit.heldOutInTrain === false && r.audit.maxTrainEndBeforeTest === true, 'audit: the tested symbol is never in training and training labels end before the test block');
    ok(r.folds.length >= 3 && r.folds.every((f, i) => i === 0 || f.from >= r.folds[i - 1].to), 'folds: calendar blocks follow each other without overlap');
    // 4. the symbol WITHOUT the pattern gets no credit from the others
    const q = r.perSymbol, plain = q[1], planted = [q[0], q[2]];
    ok(planted.every((x) => Math.max(x.aucLong, x.aucShort) > 0.54), 'per symbol: symbols with the pattern are recognised');
    ok(Math.max(plain.aucLong, plain.aucShort) < 0.54, `per symbol: the symbol WITHOUT the pattern is not (AUC ${Math.max(plain.aucLong, plain.aucShort).toFixed(3)}) — nothing is borrowed from the others`);
  }
  // 5. refusals
  {
    const bad = (f, re, m) => { let msg = null; try { f(); } catch (e) { msg = e.message; } ok(msg && re.test(msg), m); };
    bad(() => mp.runPooled([{ name: 'a', bars: makeBars(3000, 1) }], {}), /۲ تا ۱۲/, 'one symbol -> refused with a clear message');
    bad(() => mp.runPooled([{ name: 'a', bars: makeBars(3000, 1) }, { name: 'b', bars: makeBars(3000, 2, 0, null, 1800) }], {}), /تایم‌فریم/, 'different timeframes -> refused');
    bad(() => mp.runPooled([{ name: 'a', bars: makeBars(3000, 1) }, { name: 'b', bars: makeBars(300, 2) }], {}), /کندل کافی نیست/, 'too few candles in one symbol -> says which one');
  }
  // 6. feature groups: time + htf work pooled, structure is dropped (too slow) and not reported as used
  {
    const r = mp.runPooled(mk([0, 0, 0], 500), { folds: 3, features: ['time', 'htf', 'structure'], mode: 'walk' });
    ok(r.features.groups.includes('time') && r.features.groups.includes('htf') && !r.features.groups.includes('structure'), 'features: time + htf used, structure left out and not claimed');
  }
  // 7. cost sweep: one report with a table, costs ascending, zero cost never worse than the main run
  {
    const r = mp.runPooledSweep(mk([0.06, 0.06, 0.06]), { ...fast, mode: 'walk', costAtr: 0.1 });
    ok(r.costSweep.length >= 3 && r.costSweep.every((c, i) => i === 0 || c.costAtr > r.costSweep[i - 1].costAtr), 'sweep: table with ascending costs');
    ok(r.costSweep[0].meanR >= r.costSweep[r.costSweep.length - 1].meanR, 'sweep: a higher cost never gives a better result');
  }
  // 8. the HTTP route (real express app, real archives on disk)
  {
    const express = require('express'), candleStore = require('./candle-store'), router = require('./ml-routes');
    const app = express(); app.use('/api/ml', router());
    const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/ml`;
    const post = async (body) => { const r = await fetch(base + '/run-pooled', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
    ['TST_A', 'TST_B', 'TST_C'].forEach((nm, k) => candleStore.merge(nm, '60', makeBars(N, 700 + k, 0.06, common)));
    candleStore.merge('TST_D', '30', makeBars(N, 9, 0, null, 1800));
    ok((await post({ files: ['TST_A_60'] })).status === 400, 'route: one archive -> 400');
    ok((await post({ files: ['TST_A_60', 'NOPE_60'] })).status === 400, 'route: unknown archive -> 400');
    ok((await post({ files: ['TST_A_60', 'TST_D_30'] })).status === 400, 'route: mixed timeframes -> 400');
    const r = await post({ files: ['TST_A_60', 'TST_B_60', 'TST_C_60'], folds: 4, mode: 'loso', costAtr: 0.05 });
    ok(r.status === 200 && r.json.source === 'pooled' && r.json.pooled && r.json.perSymbol.length === 3 && r.json.trial && r.json.trial.trials >= 1, 'route: 200 with the pooled report and the research ledger updated');
    ok(Math.max(r.json.auc.long, r.json.auc.short) > 0.55, 'route: the planted pattern is found through the whole stack (worker thread included)');
    server.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
