// The research ledger: how many different ideas have really been tried on each symbol.
//
// Why: "this combination is only 3% likely to be luck" means nothing if 200 other combinations were tried first and this is the
// best of them. The comparison used to count only the cells of ONE run; a Sweep, yesterday's run, or ten ideas typed into the AI
// box were forgotten, so the more you experimented the easier it became to fool yourself. Every backtest, sweep and comparison
// now records what it looked at (on disk, so it survives restarts), and the statistics are corrected for the real number.
//
// What counts as ONE trial: a (symbol, timeframe, strategy) STRUCTURE — a strategy is identified by what it DOES (its rules / its
// parts / its code), not by its name, so renaming it or saving it again does not inflate anything, while changing one threshold
// does. Different SETTINGS of the same structure (the results of a Sweep: stop distance, take-profit, trailing, filters...) are
// closely related to each other, so they are not counted as independent: V variants of one structure count as 1 + log2(V).
// (300 sweep points ~ 9 tests, not 300. This is a deliberate rule of thumb: between "1" and "V".)
//
// Only recent work counts (default 90 days, TRIAL_WINDOW_DAYS): markets change, and a ledger that only ever grows would end up
// rejecting everything. Running the same thing again never adds to the count; it just keeps it "recent".
//
// The same file also remembers how many candidates have looked at the HOLD-OUT part of the data (the last stretch that selection
// is not allowed to see): the more candidates look at it, the less "unseen" it is.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWrite } = require('./fsutil');
const { STRATEGIES } = require('./strategy');

const file = () => process.env.TRIALS_FILE || path.join(process.env.DATA_DIR || __dirname, 'trials.json');
const windowDays = () => Math.max(7, Number(process.env.TRIAL_WINDOW_DAYS) || 90);
const MAX_STRUCTS = 5000;
const nowSec = () => Math.floor(Date.now() / 1000);
const hash = (x) => crypto.createHash('sha1').update(String(x)).digest('hex').slice(0, 12);

function readAll() {
  try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; }
}

// what the strategy DOES, as text (never its display name)
function strategyFingerprint(id) {
  const d = STRATEGIES[id];
  if (!d) return `unknown:${id}`;
  if (!d.custom) return `builtin:${id}`;
  if (d.rules) return `rules:${JSON.stringify(d.rules)}`;
  if (d.components) return `combo:${JSON.stringify([d.components, d.entryVotes, d.exitVotes, d.rsiBuy, d.rsiSell])}`;
  if (d.fn) return `script:${String(d.fn)}`;
  return `custom:${id}`;
}

// the settings that change what a strategy does (not the ones that only scale money)
function paramsFingerprint(base, id) {
  const d = STRATEGIES[id] || {}, r = base.risk || {}, pe = r.partialExit || {};
  const usesRsi = d.usesRsiThreshold || (d.components && d.components.includes('rsi_dip') && d.rsiBuy == null);
  return JSON.stringify({
    atrMult: r.atrMult, takeProfitRR: r.takeProfitRR, trailing: r.trailing, trendFilter: r.trendFilter, trendEma: r.trendFilter ? r.trendEma : undefined, fillMode: r.fillMode,
    pe: pe.enabled ? [pe.atR, pe.closePct, pe.moveStopToBreakeven] : 0,
    rsi: usesRsi ? [base.rsi && base.rsi.buy, base.rsi && base.rsi.sell] : 0,
    conf: base.confluence && base.confluence.enabled ? [base.confluence.minConfirm, base.confluence.useMacd, base.confluence.useVolume] : 0,
  });
}

// one trial = { s: structure hash, p: settings hash }
const trialKey = (symbol, tf, strategyId, base) => ({ s: hash(`${symbol}|${tf}|${strategyFingerprint(strategyId)}`), p: hash(paramsFingerprint(base, strategyId)) });

function prune(entry, now) {
  const keep = now - 2 * windowDays() * 86400;
  for (const [sk, st] of Object.entries(entry.s || {})) {
    for (const [pk, t] of Object.entries(st.v)) if (t < keep) delete st.v[pk];
    if (!Object.keys(st.v).length) delete entry.s[sk];
  }
  const over = Object.keys(entry.s).length - MAX_STRUCTS;
  if (over > 0) Object.entries(entry.s).sort((a, b) => Math.max(...Object.values(a[1].v)) - Math.max(...Object.values(b[1].v))).slice(0, over).forEach(([k]) => delete entry.s[k]);
  for (const [k, t] of Object.entries(entry.p || {})) if (t < keep) delete entry.p[k];
}

// keys: [{ s, p }]. Idempotent: the same trial recorded twice is still one trial (only its "last seen" moves).
function record(symbol, keys, now = nowSec()) {
  if (!symbol || !keys || !keys.length) return;
  const all = readAll();
  const e = all[symbol] || (all[symbol] = { s: {}, p: {} });
  e.s = e.s || {}; e.p = e.p || {};
  for (const k of keys) { const st = e.s[k.s] || (e.s[k.s] = { v: {} }); st.v[k.p] = now; }
  prune(e, now);
  atomicWrite(file(), JSON.stringify(all));
}

// distinct hold-out peeks (by trial) in the window
function recordPeek(symbol, keys, now = nowSec()) {
  if (!symbol || !keys || !keys.length) return;
  const all = readAll();
  const e = all[symbol] || (all[symbol] = { s: {}, p: {} });
  e.s = e.s || {}; e.p = e.p || {};
  for (const k of keys) e.p[`${k.s}.${k.p}`] = now;
  prune(e, now);
  atomicWrite(file(), JSON.stringify(all));
}

function summary(symbol, now = nowSec()) {
  const e = readAll()[symbol] || { s: {}, p: {} }, since = now - windowDays() * 86400;
  let structures = 0, variants = 0, eff = 0;
  for (const st of Object.values(e.s || {})) {
    const v = Object.values(st.v).filter((t) => t >= since).length;
    if (v) { structures++; variants += v; eff += 1 + Math.log2(v); }
  }
  const peeks = Object.values(e.p || {}).filter((t) => t >= since).length;
  return { trials: Math.max(1, Math.ceil(eff - 1e-9)), structures, variants, peeks, windowDays: windowDays() };
}

function reset(symbol) {
  const all = readAll();
  if (!all[symbol]) return false;
  delete all[symbol];
  atomicWrite(file(), JSON.stringify(all));
  return true;
}

module.exports = { trialKey, record, recordPeek, summary, reset, strategyFingerprint, paramsFingerprint, windowDays };
