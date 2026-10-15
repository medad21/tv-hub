// Runs backtests on a separate thread, so crunching thousands of candles never freezes the live bot
// (price ticks, stop-loss checks, dashboard updates all stay on the main thread).
const { parentPort } = require('worker_threads');
const { runBacktest, runSweep, runMatrix } = require('./backtest');
const custom = require('./custom-strategies');
const RUN = { sweep: runSweep, matrix: runMatrix };

parentPort.on('message', async ({ id, kind, opts }) => {
  const onProgress = (p) => parentPort.postMessage({ id, type: 'progress', data: p });
  try {
    custom.load(); // this thread has its own copy of the strategy list: re-read your strategies / combinations before every job
    const res = await (RUN[kind] || runBacktest)({ ...opts, onProgress });
    parentPort.postMessage({ id, type: 'done', res });
  } catch (e) {
    parentPort.postMessage({ id, type: 'done', res: { error: e.message } });
  }
});
