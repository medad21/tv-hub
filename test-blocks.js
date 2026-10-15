// Offline checks for the BLOCK bootstrap: trades that happened in the same few days are ONE piece of evidence, not several.
// Run: node test-blocks.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-blk-'));
Object.assign(process.env, { CONFIG_OVERRIDES_FILE: path.join(tmp, 'config.local.json'), BT_CACHE: path.join(tmp, 'cache'), TRADE_LOG: path.join(tmp, 't.jsonl'), EVENT_LOG: path.join(tmp, 'e.log'), STATE_FILE: path.join(tmp, 's.json'), DATA_DIR: tmp, MODE: 'signal' });
delete process.env.BLOCK_DAYS;
const sig = require('./significance');
const bt = require('./backtest');
const evidence = require('./evidence');
let passed = 0;
const ok = (c, m) => { assert(c, m); passed++; console.log('  ok  ' + m); };

const DAY = 86400, T0 = 6558 * 3 * 86400; // a start that sits exactly on a 3-day block boundary (blocks are aligned to the calendar)
function seeded(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const gauss = (r) => (r() + r() + r() + r() + r() + r() - 3) * Math.SQRT2;
const width = (ci) => ci.hi - ci.lo;

// 3 symbols trade on each of 40 days and all three get (almost) the same result that day: a strong "day effect".
function clustered(days, perDay, dayMean, dayShockSd, seed) {
  const r = seeded(seed), out = [];
  for (let d = 0; d < days; d++) {
    const shock = dayMean + dayShockSd * gauss(r);
    for (let k = 0; k < perDay; k++) { const x = shock + 0.05 * gauss(r); out.push({ r: x, pnl: x * 10, entryTime: T0 + d * DAY + k * 600, symbol: 'S' + k }); }
  }
  return out;
}

// ---- 1) the building blocks ----
const times = [T0, T0 + 3600, T0 + 2 * DAY, T0 + 2 * DAY + 5, T0 + 9 * DAY, NaN];
const b3 = sig.blocksOf(times, 3);
ok(b3.length === 3 && b3[0].length === 4 && b3[1].length === 1 && b3[2].length === 1, 'blocksOf: values within the same 3-day block are grouped; one with no usable time stands alone (and everything is covered once)');
ok(sig.blocksOf(times, 1).length >= 4 && sig.blocksOf(times, 30).length <= 3, 'blocksOf: a shorter block gives more groups, a longer one fewer');
ok(sig.blockDays() === 3, 'blockDays: default is 3 days');
process.env.BLOCK_DAYS = '7'; ok(sig.blockDays() === 7, 'blockDays: BLOCK_DAYS in .env overrides it'); delete process.env.BLOCK_DAYS;

// ---- 2) with no blocks given, nothing changed: every trade is its own block ----
const plain = clustered(40, 1, 0.3, 1, 5).map((t) => t.r);
const singles = plain.map((_, i) => [i]);
ok(JSON.stringify(sig.bootstrapCI(plain)) === JSON.stringify(sig.bootstrapCI(plain, 2000, singles)), 'bootstrapCI: no blocks == every trade its own block (the old numbers are reproduced exactly)');
ok(sig.pValueMean(plain) === sig.pValueMean(plain, 4000, singles) && sig.pfLowerBound(plain.map((x) => x * 10)) === sig.pfLowerBound(plain.map((x) => x * 10), 1500, singles), 'pValueMean / pfLowerBound: same exactness without blocks');

// ---- 3) the point: correlated trades must give a WIDER interval and a LARGER p-value ----
const cl = clustered(40, 3, 0.25, 1, 7), rs = cl.map((t) => t.r), pn = cl.map((t) => t.pnl);
const blocks = sig.blocksOf(cl.map((t) => t.entryTime), 1);
ok(blocks.length === 40 && blocks.every((b) => b.length === 3), 'setup: 120 trades = 40 days x 3 symbols');
const iid = sig.bootstrapCI(rs), blk = sig.bootstrapCI(rs, 2000, blocks);
ok(width(blk) > 1.4 * width(iid), `bootstrapCI: three same-day trades are one piece of evidence -> the interval is much wider (${width(iid).toFixed(2)} -> ${width(blk).toFixed(2)})`);
ok(Math.abs(blk.mean - iid.mean) < 1e-12, 'bootstrapCI: the observed average itself does not change, only the uncertainty around it');
const pIid = sig.pValueMean(rs), pBlk = sig.pValueMean(rs, 4000, blocks);
ok(pBlk > pIid, `pValueMean: the same trades look less impressive once same-day trades count as one (p ${pIid.toFixed(4)} -> ${pBlk.toFixed(4)})`);
ok(sig.pfLowerBound(pn, 1500, blocks) <= sig.pfLowerBound(pn) + 1e-9, 'pfLowerBound: the bad-luck Profit Factor is not better with blocks');
ok(JSON.stringify(sig.bootstrapCI(rs, 2000, blocks)) === JSON.stringify(sig.bootstrapCI(rs, 2000, blocks)) && sig.pValueMean(rs, 4000, blocks) === sig.pValueMean(rs, 4000, blocks), 'deterministic: the same trades and blocks always give the same numbers');

// ---- 4) with independent days (no day effect) the block method does not punish anything ----
const indep = clustered(120, 1, 0.3, 1, 11), irs = indep.map((t) => t.r);
const w1 = width(sig.bootstrapCI(irs)), w2 = width(sig.bootstrapCI(irs, 2000, sig.blocksOf(indep.map((t) => t.entryTime), 1)));
ok(Math.abs(w1 - w2) / w1 < 0.15, `bootstrapCI: one trade per day (nothing is shared) -> about the same interval (${w1.toFixed(2)} vs ${w2.toFixed(2)})`);

// ---- 5) tradeStats ----
const ts = sig.tradeStats(cl, 5);
ok(ts.blocks > 0 && ts.blockDays === 3 && ts.fewBlocks === false && ts.pAdj >= ts.p, 'tradeStats: trades with entry times are grouped into 3-day blocks and the result says so');
const tsDay = sig.tradeStats(cl, 5, { blockDays: 1 });
ok(tsDay.blocks === 40 && tsDay.blockDays === 1 && ts.blocks < tsDay.blocks, 'tradeStats: opts.blockDays changes the block length (fewer, longer blocks)');
// when neighbouring days resemble each other (a trending stretch), longer blocks are the more cautious choice
function trending(days, seed) { const r = seeded(seed), out = []; let shock = 0; for (let d = 0; d < days; d++) { shock = 0.85 * shock + 0.5 * gauss(r); out.push({ r: 0.1 + shock, pnl: (0.1 + shock) * 10, entryTime: T0 + d * DAY + 60 }); } return out; }
const tr = trending(90, 21);
ok(width(sig.tradeStats(tr, 1, { blockDays: 7 }).ci) > width(sig.tradeStats(tr, 1, { blockDays: 1 }).ci), 'tradeStats: when neighbouring days resemble each other, a longer block gives the wider (more honest) interval');
const notime = sig.tradeStats(cl.map(({ r, pnl }) => ({ r, pnl })), 5);
ok(notime.blocks === 120 && notime.blockDays === 0 && notime.fewBlocks === false, 'tradeStats: trades without entry times keep the old behaviour (each trade alone)');
// a great-looking result that all happened inside two days
const two = Array.from({ length: 24 }, (_, i) => ({ r: 1 + 0.01 * (i % 3), pnl: 10, entryTime: T0 + (i < 12 ? 0 : DAY) + i * 60 }));
const t2 = sig.tradeStats(two, 1);
ok(t2.fewBlocks === true && t2.blocks === 1, 'tradeStats: 24 winning trades inside two days are flagged as too few independent blocks');
ok(t2.pAdj === 1 && t2.ci && t2.p !== null, 'tradeStats: ...and the adjusted chance of luck is forced to 100% (the raw numbers are still shown)');

// ---- 6) the verdict of a comparison cell ----
const summary = { n: 46, ret: 6.8, pf: 2.33, avgR: 0.47, maxDD: 2.2, buyHold: 10 }, wf = { folds: 5, profitableFolds: 4 }, mc = { probLoss: 1 };
const few = bt.judge(summary, wf, mc, bt.RELIABILITY, { stat: t2, bench: { ret: 10, maxDD: 5, beatsRaw: false, beatsRiskAdj: false }, regime: { id: 'mild' } });
ok(few.verdict === 'suspect' && few.reasons.some((x) => /بازه‌ی زمانی/.test(x) && /شاهد مستقل/.test(x)), 'judge: everything else passes but the trades sit in too few time blocks -> "suspect", with the reason in plain words');
const fine = bt.judge(summary, wf, mc, bt.RELIABILITY, { stat: { ...ts, pAdj: 0.01, fewBlocks: false }, bench: { ret: 10, maxDD: 5, beatsRaw: false, beatsRiskAdj: false }, regime: { id: 'mild' } });
ok(fine.verdict === 'reliable', 'judge: enough blocks and a small adjusted p -> still "reliable" (nothing else became stricter)');

// ---- 7) forward evidence uses blocks too, and still works without times ----
const pct = clustered(30, 3, 0.2, 1, 13);
const vNo = evidence.verdictOf({ nF: 90, nB: 90, agree: 0.95, fwdPct: pct.map((t) => t.r) });
const vBl = evidence.verdictOf({ nF: 90, nB: 90, agree: 0.95, fwdPct: pct.map((t) => t.r), fwdTimes: pct.map((t) => Math.round(t.entryTime)) });
ok(vNo.id && vBl.id, 'evidence.verdictOf: works with and without entry times');
const ciNo = /(-?\d+\.\d) تا (-?\d+\.\d)/.exec(vNo.text), ciBl = /(-?\d+\.\d) تا (-?\d+\.\d)/.exec(vBl.text);
ok(!ciNo || !ciBl || (Number(ciBl[2]) - Number(ciBl[1])) >= (Number(ciNo[2]) - Number(ciNo[1])), 'evidence.verdictOf: the interval with blocks is not narrower than without');

console.log(`\n${passed} block-bootstrap checks passed`);
process.exit(0);
