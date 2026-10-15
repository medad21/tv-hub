// Main-thread side of the backtest worker: run('backtest'|'sweep', opts, onProgress) -> Promise(result).
// One worker is kept alive between runs, so already-prepared candle data is reused (repeat runs are fast).
const path = require('path');
const { Worker } = require('worker_threads');
const cfg = require('./config'); // this file runs on the MAIN thread, so this is always the live, current settings

const TIMEOUT_MS = 15 * 60 * 1000; // a stuck download must never block the backtest tab forever
let worker = null, seq = 0;
const pending = new Map();

function failAll(message) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ error: message }); }
  pending.clear();
}

function ensure() {
  if (worker) return worker;
  const w = new Worker(path.join(__dirname, 'backtest-worker.js'));
  w.unref();
  w.on('message', (m) => {
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') { if (p.onProgress) p.onProgress(m.data); return; }
    clearTimeout(p.timer); pending.delete(m.id); p.resolve(m.res);
  });
  const drop = (msg) => { if (worker === w) worker = null; failAll(msg); };
  w.on('error', (e) => drop(`backtest worker error: ${e.message}`));
  w.on('exit', () => drop('backtest worker stopped'));
  worker = w;
  return w;
}

function run(kind, opts, onProgress) {
  return new Promise((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id); resolve({ error: 'بک‌تست بیش از ۱۵ دقیقه طول کشید و متوقف شد' });
      if (worker) { const w = worker; worker = null; w.terminate(); failAll('backtest worker restarted'); }
    }, TIMEOUT_MS);
    pending.set(id, { resolve, onProgress, timer });
    // The worker thread has its own separate copy of config.js and stays alive between runs, so a setting
    // applied via config-overrides.js (mutated here, on the main thread) needs to be handed over explicitly —
    // otherwise the worker would keep using whatever it saw when it first started.
    const liveCfg = { risk: { ...cfg.risk }, rsi: { ...cfg.rsi }, confluence: { ...cfg.confluence }, strategy: { ...cfg.strategy } };
    ensure().postMessage({ id, kind, opts: { ...opts, liveCfg } });
  });
}

module.exports = { run };
