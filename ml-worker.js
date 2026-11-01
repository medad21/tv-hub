// Runs one ML-lab job on its own thread (a few seconds of number crunching must never freeze the live bot).
const { parentPort, workerData } = require('worker_threads');
const ml = require('./ml');
try {
  let res;
  if (workerData.meta) { // meta-labeling: a strategy gives the signals, the model only takes/skips them (ml-pooled.js)
    require('./custom-strategies').load(); // this thread has its own strategy list: read your own strategies / combinations too
    const mp = require('./ml-pooled');
    const o = { ...workerData.opts, mode: workerData.mode, strategy: workerData.strategy, dir: workerData.dir, rsi: workerData.rsi, risk: workerData.risk, costTable: workerData.costTable };
    res = workerData.sweep ? mp.runMetaSweep(workerData.sets, o) : mp.runMeta(workerData.sets, o, { cutoff: workerData.cutoff || undefined });
  } else if (workerData.pooled) { // several symbols, one model (ml-pooled.js)
    const mp = require('./ml-pooled');
    res = (workerData.sweep ? mp.runPooledSweep : mp.runPooled)(workerData.sets, { ...workerData.opts, mode: workerData.mode, costTable: workerData.costTable });
  } else res = (workerData.sweep ? ml.runSweep : ml.run)(workerData.bars, workerData.opts, { refBars: workerData.refBars });
  parentPort.postMessage({ ok: true, res });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e instanceof ml.MLError ? e.message : `خطای داخلی: ${e.message}` });
}
