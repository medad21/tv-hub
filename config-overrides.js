// Applies risk/rsi/confluence settings (e.g. chosen from the Backtest tab's "بهترین تنظیمات" sweep result)
// to the running app immediately, and saves them to disk so a restart keeps the change.
// cfg.risk/cfg.rsi/cfg.confluence are mutated IN PLACE (never replaced) so every module that already
// holds a reference to them (bot.js, backtest.js, server.js) sees the update without a restart.
const fs = require('fs');
const cfg = require('./config');
const { atomicWrite } = require('./fsutil');

function persist(patch) {
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(cfg.__overridesFile, 'utf8')); } catch {}
  const merged = {
    risk: { ...(existing.risk || {}), ...(patch.risk || {}) },
    rsi: { ...(existing.rsi || {}), ...(patch.rsi || {}) },
    confluence: { ...(existing.confluence || {}), ...(patch.confluence || {}) },
    strategy: { ...(existing.strategy || {}), ...(patch.strategy || {}) },
    live: { ...(existing.live || {}), ...(patch.live || {}) }, // live-trading switches (not strategy settings): "reset to defaults" leaves these alone
  };
  const tf = patch.timeframe || existing.timeframe; // the bot's timeframe: also not a strategy setting
  if (tf) merged.timeframe = tf;
  atomicWrite(cfg.__overridesFile, JSON.stringify(merged, null, 2));
}

function apply(settings) {
  const out = {};
  if (settings.risk) { Object.assign(cfg.risk, settings.risk); out.risk = settings.risk; }
  if (settings.rsi) { Object.assign(cfg.rsi, settings.rsi); out.rsi = settings.rsi; }
  if (settings.confluence) { Object.assign(cfg.confluence, settings.confluence); out.confluence = settings.confluence; }
  if (settings.strategy) { Object.assign(cfg.strategy, settings.strategy); out.strategy = settings.strategy; }
  if (Object.keys(out).length) persist(out);
  return out;
}

// The timeframe the bot trades on (candle size). Saved, and used from now on; the caller restarts the feed.
function setTimeframe(tf) {
  const t = String(tf || '').toUpperCase();
  if (!cfg.TIMEFRAMES.includes(t)) return { ok: false, error: `تایم‌فریم باید یکی از ${cfg.TIMEFRAMES.join('، ')} باشد` };
  cfg.timeframe = t;
  persist({ timeframe: t });
  return { ok: true, timeframe: t };
}

// A live-trading switch (currently only exchangeStops). Takes effect immediately and survives restarts.
function setLive(patch) {
  const out = {};
  if (typeof patch.exchangeStops === 'boolean') { cfg.live.exchangeStops = patch.exchangeStops; out.exchangeStops = patch.exchangeStops; }
  if (Object.keys(out).length) persist({ live: out });
  return out;
}

function reset() {
  Object.assign(cfg.risk, cfg.__codeDefaults.risk);
  Object.assign(cfg.rsi, cfg.__codeDefaults.rsi);
  Object.assign(cfg.confluence, cfg.__codeDefaults.confluence);
  Object.assign(cfg.strategy, cfg.__codeDefaults.strategy);
  let live = {}, timeframe = null;
  try { const o = JSON.parse(fs.readFileSync(cfg.__overridesFile, 'utf8')); live = o.live || {}; timeframe = o.timeframe || null; } catch {}
  if (Object.keys(live).length || timeframe) atomicWrite(cfg.__overridesFile, JSON.stringify({ ...(Object.keys(live).length ? { live } : {}), ...(timeframe ? { timeframe } : {}) }, null, 2)); // keep the live switches and the bot's timeframe
  else { try { fs.unlinkSync(cfg.__overridesFile); } catch {} }
}

// "custom strategy settings are active" — a saved live switch alone does not count (it is not a strategy setting)
const isApplied = () => {
  try {
    const o = JSON.parse(fs.readFileSync(cfg.__overridesFile, 'utf8'));
    return ['risk', 'rsi', 'confluence', 'strategy'].some((k) => o[k] && Object.keys(o[k]).length);
  } catch { return false; }
};

module.exports = { apply, reset, isApplied, setLive, setTimeframe };
