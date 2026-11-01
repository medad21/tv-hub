// /api/ml/* — the ML lab: which candle archives exist, and one walk-forward experiment at a time (on a worker thread).
// Read-only with respect to the bot: it only reads the candle archive and writes one line to the research ledger.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Worker } = require('worker_threads');
const candleStore = require('./candle-store');
const trials = require('./trials');
const ml = require('./ml');
const lock = require('./ml-lock');
const cfg = require('./config');
const { STRATEGIES } = require('./strategy');
const trialsMod = trials;

const MAX_CANDLES = 60000, TIMEOUT_MS = 5 * 60 * 1000, POOLED_TIMEOUT_MS = 20 * 60 * 1000;
// the bot's own per-market costs (config.js risk.costs), read live from the main thread (a worker thread has its own, default copy of the config)
const costTable = () => ({ feePct: cfg.risk.feePct, slippagePct: cfg.risk.slippagePct, costs: cfg.risk.costs });
const hash = (x) => crypto.createHash('sha1').update(String(x)).digest('hex').slice(0, 12);

module.exports = function mlRouter() {
  const r = express.Router();
  r.use(express.json());

  // TradingView and MetaTrader candles live in the same folder; MetaTrader ones are named MT5_<symbol>_<tf> (mt5-import.js, "MT5:" + symbol).
  // The label only says where the candles came from; the lab uses exactly the archive you pick and never mixes the two.
  const sourceOf = (file) => (/^MT5_/.test(file) ? 'mt5' : 'tv');
  r.get('/archives', (req, res) => res.set('Cache-Control', 'no-store').json({ archives: candleStore.summary().filter((a) => a.candles >= 500).map((a) => ({ ...a, source: sourceOf(a.file) })).sort((a, b) => b.candles - a.candles), defaults: ml.DEFAULTS, features: ml.FEATURES.map(([id, name]) => ({ id, name })) }));

  r.post('/run', (req, res) => {
    const b = req.body || {};
    const arc = candleStore.summary().find((a) => a.file === b.file);
    if (!arc) return res.status(400).json({ error: 'این آرشیو پیدا نشد؛ فهرست را تازه کن.' });
    if (!lock.canTake('manual')) return res.status(429).json({ error: 'یک آزمون ML در حال اجراست؛ صبر کن تمام شود.' });
    const cut = arc.file.lastIndexOf('_'), symbol = arc.file.slice(0, cut), tf = arc.file.slice(cut + 1);
    const opts = ml.normalize(b);
    const bars = candleStore.read(symbol, tf).slice(-MAX_CANDLES);
    // optional second symbol (DXY for gold, BTC for an altcoin ...): any other archive; its latest CLOSED candle is joined to each candle
    let refBars = null, refFile = null;
    if (b.refFile) {
      const rf = candleStore.summary().find((a) => a.file === b.refFile);
      if (!rf || rf.file === arc.file) return res.status(400).json({ error: 'آرشیو نماد وابسته پیدا نشد یا همان آرشیو اصلی است.' });
      const c2 = rf.file.lastIndexOf('_');
      refBars = candleStore.read(rf.file.slice(0, c2), rf.file.slice(c2 + 1)).slice(-MAX_CANDLES); refFile = rf.file;
    }
    const tok = lock.acquire('manual'); // (a running background job of the auto-lab is stopped to make room)
    let done = false;
    const finish = (code, body) => { if (done) return; done = true; lock.release(tok); clearTimeout(timer); res.status(code).json(body); };
    const w = new Worker(path.join(__dirname, 'ml-worker.js'), { workerData: { bars, opts, refBars, sweep: !!b.costSweep } });
    const timer = setTimeout(() => { w.terminate(); finish(504, { error: 'آزمون بیش از ۵ دقیقه طول کشید و متوقف شد؛ تعداد کندل یا تعداد بازه‌ها را کمتر کن.' }); }, TIMEOUT_MS);
    w.once('message', (m) => {
      if (!m.ok) return finish(422, { error: m.error });
      try { // one more idea tried on this symbol: the statistics elsewhere in the app are corrected for the real number of tries
        const costs = m.res.costSweep ? m.res.costSweep.map((x) => x.costAtr) : [opts.costAtr];
        trials.record(arc.file, costs.map((c) => ({ s: hash(`ml|${arc.file}|${opts.model}|${opts.horizon}|${opts.slAtr}|${opts.rr}|${opts.features.join('+')}|${refFile || ''}`), p: hash(`${c}|${opts.margin}|${opts.folds}|${opts.trainFrac}`) })));
      } catch (e) { console.error('ml ledger:', e.message); }
      finish(200, { ...m.res, refFile, file: arc.file, source: sourceOf(arc.file), trial: trials.summary(arc.file) });
    });
    w.once('error', (e) => { console.error('ml worker:', e.message); finish(500, { error: 'خطای داخلی در اجرای آزمون' }); });
  });

  // One model learning from several archives at once (ml-pooled.js). Same timeframe for all; each archive is read as it is.
  // mode "loso": the tested symbol is never in the training data; mode "walk": all symbols train on the past and are tested on the next block.
  r.post('/run-pooled', (req, res) => {
    const b = req.body || {}, all = candleStore.summary();
    const files = [...new Set(Array.isArray(b.files) ? b.files.map(String) : [])];
    if (files.length < 2 || files.length > 12) return res.status(400).json({ error: 'برای آزمون چندنمادی ۲ تا ۱۲ آرشیو انتخاب کن.' });
    const arcs = files.map((f) => all.find((a) => a.file === f));
    if (arcs.some((a) => !a)) return res.status(400).json({ error: 'یکی از آرشیوها پیدا نشد؛ فهرست را تازه کن.' });
    const tfOf = (f) => f.slice(f.lastIndexOf('_') + 1);
    if (new Set(files.map(tfOf)).size > 1) return res.status(400).json({ error: 'همه‌ی آرشیوها باید یک تایم‌فریم داشته باشند (مثلاً همه _60).' });
    if (!lock.canTake('manual')) return res.status(429).json({ error: 'یک آزمون ML در حال اجراست؛ صبر کن تمام شود.' });
    const opts = ml.normalize(b), mode = b.mode === 'walk' ? 'walk' : 'loso';
    const sets = arcs.map((a) => { const cut = a.file.lastIndexOf('_'); return { name: a.file, bars: candleStore.read(a.file.slice(0, cut), a.file.slice(cut + 1)).slice(-MAX_CANDLES) }; });
    const tok = lock.acquire('manual'); // (a running background job of the auto-lab is stopped to make room)
    let done = false;
    const finish = (code, body) => { if (done) return; done = true; lock.release(tok); clearTimeout(timer); res.status(code).json(body); };
    const w = new Worker(path.join(__dirname, 'ml-worker.js'), { workerData: { pooled: true, sets, opts, mode, costTable: costTable(), sweep: !!b.costSweep } });
    const timer = setTimeout(() => { w.terminate(); finish(504, { error: 'آزمون چندنمادی بیش از ۲۰ دقیقه طول کشید و متوقف شد؛ نمادها یا کندل‌ها یا تعداد بازه‌ها را کمتر کن.' }); }, POOLED_TIMEOUT_MS);
    w.once('message', (m) => {
      if (!m.ok) return finish(422, { error: m.error });
      const key = `POOL_${hash(files.slice().sort().join('|'))}`;
      try { // one more idea tried: recorded under the pooled set AND under every symbol in it (the model looked at all of them)
        const costs = m.res.costSweep ? m.res.costSweep.map((x) => x.costAtr) : [opts.costAtr];
        const feats = m.res.features.groups.join('+');
        for (const k of [key, ...files]) trials.record(k, costs.map((c) => ({ s: hash(`mlpool|${k === key ? 'all' : files.slice().sort().join('|')}|${mode}|${opts.model}|${opts.horizon}|${opts.slAtr}|${opts.rr}|${feats}`), p: hash(`${c}|${opts.margin}|${opts.folds}|${opts.trainFrac}`) })));
      } catch (e) { console.error('ml ledger:', e.message); }
      finish(200, { ...m.res, files, source: 'pooled', sourceCandles: { archived: arcs.reduce((a, x) => a + x.candles, 0), used: sets.reduce((a, x) => a + x.bars.length, 0) }, trial: trials.summary(key) });
    });
    w.once('error', (e) => { console.error('ml worker:', e.message); finish(500, { error: 'خطای داخلی در اجرای آزمون' }); });
  });

  // The strategies a meta-labeling test can use (the built-in ones, setups and your own); the list is read live so new strategies appear at once.
  r.get('/strategies', (req, res) => res.set('Cache-Control', 'no-store').json({ strategies: Object.entries(STRATEGIES).map(([id, s]) => ({ id, name: s.name, custom: !!s.custom })), active: cfg.strategy.id }));

  // Meta-labeling: a strategy from strategy.js produces the signals (same edge-detected buy/sell the backtest and the bot use, with the bot's
  // CURRENT rsi / atr / trend settings), the model only decides take or skip. 1 to 12 archives of one timeframe; several = pooled as in /run-pooled.
  r.post('/run-meta', (req, res) => {
    const b = req.body || {}, all = candleStore.summary();
    const files = [...new Set(Array.isArray(b.files) ? b.files.map(String) : [])];
    if (files.length < 1 || files.length > 12) return res.status(400).json({ error: 'برای متالیبلینگ ۱ تا ۱۲ آرشیو انتخاب کن.' });
    if (!STRATEGIES[b.strategy]) return res.status(400).json({ error: 'استراتژی پیدا نشد؛ صفحه را تازه کن.' });
    const arcs = files.map((f) => all.find((a) => a.file === f));
    if (arcs.some((a) => !a)) return res.status(400).json({ error: 'یکی از آرشیوها پیدا نشد؛ فهرست را تازه کن.' });
    const tfOf = (f) => f.slice(f.lastIndexOf('_') + 1);
    if (new Set(files.map(tfOf)).size > 1) return res.status(400).json({ error: 'همه‌ی آرشیوها باید یک تایم‌فریم داشته باشند (مثلاً همه _60).' });
    if (!lock.canTake('manual')) return res.status(429).json({ error: 'یک آزمون ML در حال اجراست؛ صبر کن تمام شود.' });
    const opts = ml.normalize(b), mode = b.mode === 'walk' ? 'walk' : 'loso', dir = b.dir === 'short' ? 'short' : 'long';
    const sets = arcs.map((a) => { const cut = a.file.lastIndexOf('_'); return { name: a.file, bars: candleStore.read(a.file.slice(0, cut), a.file.slice(cut + 1)).slice(-MAX_CANDLES) }; });
    const rsi = { period: cfg.rsi.period, buy: cfg.rsi.buy, sell: cfg.rsi.sell }, risk = { atrPeriod: cfg.risk.atrPeriod, trendEma: cfg.risk.trendEma };
    const tok = lock.acquire('manual'); // (a running background job of the auto-lab is stopped to make room)
    let done = false;
    const finish = (code, body) => { if (done) return; done = true; lock.release(tok); clearTimeout(timer); res.status(code).json(body); };
    const w = new Worker(path.join(__dirname, 'ml-worker.js'), { workerData: { meta: true, sets, opts, mode, strategy: b.strategy, dir, rsi, risk, costTable: costTable(), sweep: !!b.costSweep } });
    const timer = setTimeout(() => { w.terminate(); finish(504, { error: 'آزمون بیش از ۲۰ دقیقه طول کشید و متوقف شد؛ نمادها یا کندل‌ها را کمتر کن.' }); }, POOLED_TIMEOUT_MS);
    w.once('message', (m) => {
      if (!m.ok) return finish(422, { error: m.error });
      const key = files.length > 1 ? `POOL_${hash(files.slice().sort().join('|'))}` : files[0];
      try { // one more idea tried: recorded under the set AND under every archive in it
        const costs = m.res.costSweep ? m.res.costSweep.map((x) => x.costAtr) : [opts.costAtr];
        const feats = m.res.features.groups.join('+'), sorted = files.slice().sort().join('|');
        for (const k of new Set([key, ...files])) trials.record(k, costs.map((c) => ({ s: hash(`mlmeta|${k === key ? 'all' : sorted}|${b.strategy}|${dir}|${mode}|${opts.model}|${opts.horizon}|${opts.slAtr}|${opts.rr}|${feats}`), p: hash(`${c}|${opts.margin}|${opts.folds}|${opts.trainFrac}`) })));
      } catch (e) { console.error('ml ledger:', e.message); }
      finish(200, { ...m.res, files, source: 'meta', strategyName: STRATEGIES[b.strategy].name, sourceCandles: { archived: arcs.reduce((a, x) => a + x.candles, 0), used: sets.reduce((a, x) => a + x.bars.length, 0) }, trial: trials.summary(key) });
    });
    w.once('error', (e) => { console.error('ml worker:', e.message); finish(500, { error: 'خطای داخلی در اجرای آزمون' }); });
  });

  // ---- the idle-time auto-runner (ml-auto.js): settings, status/leaderboard, one run now, the sealed final check, reset ---------------------------------
  const auto = require('./ml-auto').create({ candleStore, cfg, trials: trialsMod, STRATEGIES });
  if (!process.env.ML_AUTO_DISABLE) auto.start();
  const wrap = (fn) => async (req, res) => { try { res.set('Cache-Control', 'no-store').json(await fn(req.body || {})); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } };
  r.get('/auto/status', wrap(async () => auto.status()));
  r.post('/auto/settings', wrap(async (b) => auto.setSettings(b)));
  r.post('/auto/run-now', wrap(async () => ({ result: await auto.runNext({ force: true }), status: auto.status() })));
  r.post('/auto/forward', wrap(async (b) => ({ result: await auto.runForward(String(b.id || '')), status: auto.status() })));
  r.post('/auto/reset', wrap(async (b) => { if (b.confirm !== true) { const e = new Error('برای پاک‌کردن باید تأیید بفرستی.'); e.status = 400; throw e; } return auto.reset(); }));
  r.auto = auto;
  return r;
};
