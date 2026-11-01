// The ML lab's idle-time auto-runner: while the computer is idle (a time window you set, and the CPU below a limit you set) it works through
// combinations by itself — strategy x direction x (timeframe, market) group of candle archives — runs the same meta-labeling test as the manual
// button, and keeps a leaderboard in a file. It never trades and never touches the bot: it only reads candle archives and writes ml-auto.json.
//
// Honesty rules built in (a search over many combinations always finds something that looks good by luck):
//   * SEALED data: the search only ever sees candles older than `sealedFrom`. Everything newer (and every candle the bot archives from now on)
//     is kept back for ONE final check per candidate (train before the date, test after it). The date cannot be moved after a final check was run.
//   * MULTIPLE TESTING: every p-value in the leaderboard is also shown multiplied by the number of combinations tried (Bonferroni), and the summary
//     says how many "significant" results pure luck would produce.
//   * every run is also written to the research ledger (trials.js), like a manual run.
//   * a manual run always wins: the background job is stopped (ml-lock.js) and simply tried again later.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { atomicWrite } = require('./fsutil');
const lock = require('./ml-lock');
const ml = require('./ml');
const { symbolOf } = require('./ml-pooled');
const { group } = require('./symbols');

const DAY = 86400, MAX_CANDLES = 60000, JOB_TIMEOUT_MS = 20 * 60 * 1000, MAX_ROWS = 3000, SUMMARY_TTL_MS = 60 * 1000;
const hash = (x) => crypto.createHash('sha1').update(String(x)).digest('hex').slice(0, 12);
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

const DEFAULTS = {
  enabled: false,
  startHour: 1, endHour: 7,      // the "idle" window, hours of this computer's clock; equal numbers = any time of the day
  maxCpu: 50,                    // start a job only while the whole computer uses less than this % of its CPU
  pauseSec: 30,                  // rest between two jobs
  strategies: [],                // [] = every built-in strategy and setup (your own / combined ones only with includeCustom)
  includeCustom: false,          // more combinations tested = more chance that one looks good by luck, so this is off by default
  dirs: ['long'],                // 'long' = buy signals (the bot only goes long), 'short' = sell signals
  kinds: ['crypto', 'mt5'],      // which archives to group: crypto (exchange archives), mt5 (MetaTrader), stock, forex (TradingView forex archives)
  tfs: [],                       // [] = every timeframe that has enough archives
  minArchives: 3, maxArchives: 12, minCandles: 3000,
  retestGrowthPct: 5,            // test a combination again when the candles it used grew by more than this %
  mode: 'loso',
  sealedFrom: null,              // seconds; candles at or after it are never used by the search (set when you first switch it on: 90 days ago)
  sealedDays: 90,
  keepTop: 15,
  base: { model: 'logistic', horizon: 20, slAtr: 1.5, rr: 1.5, costMode: 'real', costMult: 1, folds: 5, features: ['time', 'htf'] },
};

function sanitize(inp, cur, strategyIds) {
  const o = inp || {}, c = cur || DEFAULTS, out = { ...c, base: { ...c.base } };
  if ('enabled' in o) out.enabled = !!o.enabled;
  if ('startHour' in o) out.startHour = Math.round(num(o.startHour, 0, 23, c.startHour));
  if ('endHour' in o) out.endHour = Math.round(num(o.endHour, 0, 23, c.endHour));
  if ('maxCpu' in o) out.maxCpu = Math.round(num(o.maxCpu, 5, 100, c.maxCpu));
  if ('pauseSec' in o) out.pauseSec = Math.round(num(o.pauseSec, 0, 3600, c.pauseSec));
  if ('includeCustom' in o) out.includeCustom = !!o.includeCustom;
  if ('strategies' in o) out.strategies = (Array.isArray(o.strategies) ? o.strategies : []).map(String).filter((x) => !strategyIds || strategyIds.includes(x));
  if ('dirs' in o) { const d = (Array.isArray(o.dirs) ? o.dirs : []).filter((x) => x === 'long' || x === 'short'); out.dirs = d.length ? [...new Set(d)] : c.dirs; }
  if ('kinds' in o) { const k = (Array.isArray(o.kinds) ? o.kinds : []).filter((x) => ['crypto', 'mt5', 'stock', 'forex'].includes(x)); out.kinds = k.length ? [...new Set(k)] : c.kinds; }
  if ('tfs' in o) out.tfs = (Array.isArray(o.tfs) ? o.tfs : []).map(String).filter((x) => /^(\d{1,4}|D|W)$/.test(x));
  if ('minArchives' in o) out.minArchives = Math.round(num(o.minArchives, 2, 12, c.minArchives));
  if ('maxArchives' in o) out.maxArchives = Math.round(num(o.maxArchives, 2, 12, c.maxArchives));
  if (out.maxArchives < out.minArchives) out.maxArchives = out.minArchives;
  if ('minCandles' in o) out.minCandles = Math.round(num(o.minCandles, 1000, 60000, c.minCandles));
  if ('retestGrowthPct' in o) out.retestGrowthPct = num(o.retestGrowthPct, 1, 100, c.retestGrowthPct);
  if ('mode' in o) out.mode = o.mode === 'walk' ? 'walk' : 'loso';
  if ('keepTop' in o) out.keepTop = Math.round(num(o.keepTop, 3, 50, c.keepTop));
  if ('sealedDays' in o) out.sealedDays = Math.round(num(o.sealedDays, 7, 1500, c.sealedDays));
  if (o.sealedFrom !== undefined && o.sealedFrom !== null) out.sealedFrom = Math.round(num(o.sealedFrom, 0, 4e9, c.sealedFrom));
  if (o.base && typeof o.base === 'object') { // the same lab parameters as the manual form; normalised by ml.js
    const n = ml.normalize(o.base);
    out.base = { model: n.model, horizon: n.horizon, slAtr: n.slAtr, rr: n.rr, costMode: n.costMode, costMult: n.costMult, folds: n.folds, features: n.features.filter((g) => g !== 'structure') };
  }
  return out;
}

function inWindow(ms, s) {
  if (s.startHour === s.endHour) return true;
  const h = new Date(ms).getHours();
  return s.startHour < s.endHour ? h >= s.startHour && h < s.endHour : h >= s.startHour || h < s.endHour;
}

const cpuSnap = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });
async function sampleCpu(ms = 1000) { // whole-computer CPU use in %, measured over `ms`
  const a = cpuSnap(); await new Promise((r) => setTimeout(r, ms)); const b = cpuSnap(), dt = b.total - a.total;
  return dt > 0 ? Math.max(0, Math.min(100, 100 * (1 - (b.idle - a.idle) / dt))) : 0;
}

function spawnJob(workerData, timeoutMs) {
  const w = new Worker(path.join(__dirname, 'ml-worker.js'), { workerData });
  let settled = false, timer;
  const promise = new Promise((resolve) => {
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
    timer = setTimeout(() => { w.terminate(); done({ ok: false, error: 'زمان آزمون (۲۰ دقیقه) تمام شد' }); }, timeoutMs);
    w.once('message', (m) => done(m));
    w.once('error', (e) => done({ ok: false, error: `خطای داخلی: ${e.message}` }));
    w.once('exit', () => done({ preempted: true })); // stopped from outside (a manual run needed the lab)
  });
  return { promise, cancel: () => { w.terminate(); } };
}

const pick = (t) => ({ trades: t.trades, meanR: t.meanR, winRate: t.winRate, totalR: t.totalR });
const kindOf = (file) => (/^MT5_/.test(file) ? 'mt5' : group(symbolOf(file)) || 'other');
const tfOf = (file) => file.slice(file.lastIndexOf('_') + 1);
const tfMin = (tf) => (tf === 'D' ? 1440 : tf === 'W' ? 10080 : Number(tf) || 0);

function create(deps) {
  const { candleStore, cfg, trials, STRATEGIES } = deps;
  const now = deps.now || Date.now, spawn = deps.runJob || spawnJob, sample = deps.cpuSampler || sampleCpu, tickMs = deps.tickMs || 60000;
  const stateFile = deps.file || process.env.ML_AUTO_FILE || path.join(process.env.DATA_DIR || __dirname, 'ml-auto.json');
  const strategyIds = () => Object.keys(STRATEGIES);

  let state = { version: 1, settings: { ...DEFAULTS, base: { ...DEFAULTS.base } }, rows: [], forwardCount: 0, lastTotals: null, lastChange: null, lastFinished: null };
  try { const j = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (j && j.version === 1) state = { ...state, ...j, settings: sanitize(j.settings, DEFAULTS, null) }; } catch { /* first start */ }
  const save = () => { try { atomicWrite(stateFile, JSON.stringify(state)); } catch (e) { console.error('ml-auto save:', e.message); } };

  let current = null, jobPromise = null, timer = null, ticking = false, lastTick = { at: 0, reason: 'idle', cpu: null }, summaryCache = null, splitCache = new Map();

  // ---- archives and candle counts -------------------------------------------------------------------------------
  const archives = (fresh) => {
    if (!fresh && summaryCache && now() - summaryCache.at < SUMMARY_TTL_MS) return summaryCache.list;
    const list = candleStore.summary(); summaryCache = { at: now(), list }; return list;
  };
  const readAll = (file) => { const i = file.lastIndexOf('_'); return candleStore.read(file.slice(0, i), file.slice(i + 1)); };
  const split = (a) => { // candles the search may use (before sealedFrom) and sealed ones, cached until the archive changes
    const sf = state.settings.sealedFrom, key = `${a.file}|${a.candles}|${a.to}|${sf}`;
    if (!splitCache.has(key)) {
      if (splitCache.size > 400) splitCache.clear();
      const bars = readAll(a.file); let search = 0; for (const b of bars) if (sf == null || b.time < sf) search++;
      splitCache.set(key, { search, sealed: bars.length - search });
    }
    return splitCache.get(key);
  };
  function universes(list = archives()) {
    const s = state.settings, byKey = new Map();
    for (const a of list) {
      if (a.candles < s.minCandles) continue;
      const kind = kindOf(a.file), tf = tfOf(a.file);
      if (!s.kinds.includes(kind) || (s.tfs.length && !s.tfs.includes(tf))) continue;
      const k = `${tf}|${kind}`; if (!byKey.has(k)) byKey.set(k, { key: k, tf, kind, archives: [] }); byKey.get(k).archives.push(a);
    }
    return [...byKey.values()].map((u) => ({ key: u.key, tf: u.tf, kind: u.kind, archives: u.archives.sort((x, y) => y.candles - x.candles || x.file.localeCompare(y.file)).slice(0, s.maxArchives) }))
      .filter((u) => u.archives.length >= s.minArchives).sort((a, b) => tfMin(a.tf) - tfMin(b.tf) || a.kind.localeCompare(b.kind));
  }

  // ---- what to test --------------------------------------------------------------------------------------------
  const paramsOf = () => { const s = state.settings; return { ...s.base, mode: s.mode, rsi: cfg.rsi && { period: cfg.rsi.period, buy: cfg.rsi.buy, sell: cfg.rsi.sell }, atrPeriod: cfg.risk && cfg.risk.atrPeriod, trendEma: cfg.risk && cfg.risk.trendEma }; };
  const paramsHash = () => hash(JSON.stringify(paramsOf()));
  const expId = (strategy, dir, u) => hash(`${strategy}|${dir}|${u.tf}|${u.kind}|${paramsHash()}|${state.settings.sealedFrom}`);
  const strategyList = () => { const s = state.settings; const all = Object.entries(STRATEGIES).filter(([, d]) => s.includeCustom || !d.custom).map(([id]) => id); return s.strategies.length ? all.filter((id) => s.strategies.includes(id)) : all; };
  function queue() {
    const s = state.settings, out = [];
    if (s.sealedFrom == null) return out;
    for (const u of universes()) {
      const files = u.archives.map((a) => a.file), fp = Object.fromEntries(u.archives.map((a) => [a.file, split(a).search]));
      for (const strategy of strategyList()) for (const dir of s.dirs) {
        const id = expId(strategy, dir, u), row = state.rows.find((r) => r.id === id);
        let why = null;
        if (!row) why = 'new';
        else if (row.files.join() !== files.join()) why = 'files changed';
        else if (files.some((f) => (fp[f] || 0) > (row.fp[f] || 0) * (1 + s.retestGrowthPct / 100) + 1)) why = 'grown';
        if (why) out.push({ id, strategy, dir, universe: u, files, fp, why });
      }
    }
    return out.sort((a, b) => (a.why === 'new' ? 0 : 1) - (b.why === 'new' ? 0 : 1));
  }

  // ---- running one job ------------------------------------------------------------------------------------------
  const bars = (file, cut) => { let b = readAll(file); if (cut) b = b.filter((x) => x.time < state.settings.sealedFrom); return b.slice(-MAX_CANDLES); };
  const workerData = (exp, extra = {}) => {
    const s = state.settings;
    return { meta: true, sets: exp.files.map((f) => ({ name: f, bars: bars(f, !extra.cutoff) })), opts: { ...s.base }, mode: s.mode, strategy: exp.strategy, dir: exp.dir,
      rsi: { period: cfg.rsi.period, buy: cfg.rsi.buy, sell: cfg.rsi.sell }, risk: { atrPeriod: cfg.risk.atrPeriod, trendEma: cfg.risk.trendEma },
      costTable: { feePct: cfg.risk.feePct, slippagePct: cfg.risk.slippagePct, costs: cfg.risk.costs }, sweep: false, cutoff: extra.cutoff || null };
  };
  const ledger = (exp, tag) => {
    try {
      const b = state.settings.base, key = `POOL_${hash(exp.files.slice().sort().join('|'))}`, sorted = exp.files.slice().sort().join('|');
      for (const k of new Set([key, ...exp.files])) trials.record(k, [{ s: hash(`mlmeta|${k === key ? 'all' : sorted}|${exp.strategy}|${exp.dir}|${state.settings.mode}|${b.model}|${b.horizon}|${b.slAtr}|${b.rr}|${b.features.join('+')}|${tag}`), p: hash(`${b.costMode}|${b.costMult}|${b.folds}`) }]);
    } catch (e) { console.error('ml-auto ledger:', e.message); }
  };
  const summarise = (exp, res) => ({
    id: exp.id, strategy: exp.strategy, strategyName: (STRATEGIES[exp.strategy] || {}).name || exp.strategy, dir: exp.dir, tf: exp.universe.tf, kind: exp.universe.kind, files: exp.files, fp: exp.fp,
    paramsHash: paramsHash(), params: { ...state.settings.base, mode: state.settings.mode }, ranAt: Math.floor(now() / 1000), ms: res.ms,
    signals: res.meta.signals, selected: pick(res.meta.selected), takeAll: pick(res.meta.takeAll), gainR: res.meta.gainR,
    auc: res.auc.long, aucCI: res.stats && res.stats.aucCI ? res.stats.aucCI.long : null, pAuc: res.stats && res.stats.aucPerm ? res.stats.aucPerm.p : null, pTrade: res.stats && res.stats.tradePerm ? res.stats.tradePerm.p : null,
    effN: res.stats ? res.stats.effectiveN : null, foldsGood: res.foldsProfitable, foldsN: res.foldsWithTrades, candlesUsed: res.candles, costAtr: res.cost ? res.cost.avgAtr : null, level: res.verdict.level, from: res.from, to: res.to,
  });

  async function execute(exp, kind) { // kind: 'search' | 'forward'
    const forward = kind === 'forward', token = lock.acquire('auto', () => { if (job) job.cancel(); });
    if (!token) return { started: false, reason: 'lab_busy' };
    let job = null, data;
    try { data = workerData(exp, forward ? { cutoff: state.settings.sealedFrom } : {}); } catch (e) { lock.release(token); return { started: false, reason: 'error', error: e.message }; }
    job = spawn(data, JOB_TIMEOUT_MS);
    current = { id: exp.id, kind, strategy: exp.strategy, strategyName: (STRATEGIES[exp.strategy] || {}).name || exp.strategy, dir: exp.dir, tf: exp.universe ? exp.universe.tf : exp.tf, group: exp.universe ? exp.universe.kind : exp.kindName, files: exp.files.length, startedAt: Math.floor(now() / 1000) };
    jobPromise = (async () => {
      let out;
      try { out = await job.promise; } catch (e) { out = { ok: false, error: e.message }; }
      lock.release(token); current = null;
      if (out && out.preempted) { lastTick = { ...lastTick, reason: 'preempted' }; return; } // a manual run took the lab; this job is tried again later
      const at = Math.floor(now() / 1000);
      if (forward) {
        const row = state.rows.find((r) => r.id === exp.id); if (!row) return;
        if (out.ok) {
          const r = out.res, sel = pick(r.meta.selected), all = pick(r.meta.takeAll), pT = r.stats && r.stats.tradePerm ? r.stats.tradePerm.p : null;
          const passed = sel.trades >= 30 && sel.meanR > 0 && r.meta.gainR > 0 && pT !== null && pT < 0.05;
          row.forward = { at, ok: true, selected: sel, takeAll: all, gainR: r.meta.gainR, pTrade: pT, signals: r.meta.signals, from: r.from, to: r.to, passed, level: r.verdict.level, text: r.verdict.text };
          ledger(exp, 'forward');
        } else row.forward = { at, ok: false, error: out.error, passed: false };
        state.forwardCount += 1;
      } else {
        const old = state.rows.findIndex((r) => r.id === exp.id), prev = old >= 0 ? state.rows[old] : null;
        let row;
        if (out && out.ok) { row = summarise(exp, out.res); ledger(exp, 'search'); } else row = { id: exp.id, strategy: exp.strategy, dir: exp.dir, tf: exp.universe.tf, kind: exp.universe.kind, files: exp.files, fp: exp.fp, ranAt: at, error: (out && out.error) || 'خطا' };
        if (prev && prev.forward) row.forward = prev.forward;
        if (old >= 0) state.rows[old] = row; else state.rows.push(row);
        if (state.rows.length > MAX_ROWS) state.rows = state.rows.filter((r) => !r.error).slice(-MAX_ROWS);
      }
      state.lastFinished = { at, id: exp.id, kind, strategy: exp.strategy, ok: !!(out && out.ok), error: out && !out.ok ? out.error : null };
      save();
    })();
    return { started: true, id: exp.id };
  }

  // ---- the scheduler ---------------------------------------------------------------------------------------------
  async function runNext({ force = false } = {}) { // force = "run one now": ignores the window and the CPU limit (never the lab lock)
    const s = state.settings;
    if (!force && !s.enabled) return (lastTick = { at: now(), reason: 'disabled', cpu: null }, { started: false, reason: 'disabled' });
    if (current) return { started: false, reason: 'running' };
    if (s.sealedFrom == null) return { started: false, reason: 'no_sealed_date' };
    if (!force && !inWindow(now(), s)) return (lastTick = { at: now(), reason: 'outside_window', cpu: null }, { started: false, reason: 'outside_window' });
    if (!lock.canTake('auto')) return (lastTick = { at: now(), reason: 'lab_busy', cpu: null }, { started: false, reason: 'lab_busy' });
    let cpu = null;
    if (!force) { cpu = await sample(); if (cpu > s.maxCpu) return (lastTick = { at: now(), reason: 'cpu_busy', cpu }, { started: false, reason: 'cpu_busy', cpu }); }
    const next = queue()[0];
    if (!next) return (lastTick = { at: now(), reason: 'nothing_to_do', cpu }, { started: false, reason: 'nothing_to_do' });
    const r = await execute(next, 'search');
    lastTick = { at: now(), reason: r.started ? 'started' : r.reason, cpu };
    if (r.started) jobPromise.then(() => { if (timer && state.settings.enabled) setTimeout(() => { tick(); }, state.settings.pauseSec * 1000).unref(); });
    return r;
  }
  async function tick() { if (ticking) return; ticking = true; try { await runNext(); } catch (e) { console.error('ml-auto tick:', e.message); } finally { ticking = false; } }
  function start() { if (timer) return; timer = setInterval(tick, tickMs); timer.unref(); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  async function runForward(id) {
    const row = state.rows.find((r) => r.id === id), s = state.settings;
    if (!row || row.error) return { started: false, reason: 'not_found' };
    if (row.forward) return { started: false, reason: 'already_done' };
    if (current) return { started: false, reason: 'running' };
    if (!lock.canTake('auto')) return { started: false, reason: 'lab_busy' };
    // enough sealed candles to test on?
    let sealed = 0; try { const list = archives(true); sealed = row.files.reduce((a, f) => { const x = list.find((y) => y.file === f); return a + (x ? split(x).sealed : 0); }, 0); } catch { /* counted as 0 */ }
    if (sealed < 200 * row.files.length) return { started: false, reason: 'not_enough_sealed', sealed, need: 200 * row.files.length }; // fewer than ~200 candles per archive cannot hold enough signals
    const u = { tf: row.tf, kind: row.kind };
    return execute({ id: row.id, strategy: row.strategy, dir: row.dir, files: row.files, universe: u, kindName: row.kind }, 'forward');
  }

  // ---- what the dashboard shows ------------------------------------------------------------------------------------
  function leaderboard() {
    const ok = state.rows.filter((r) => !r.error), K = ok.length, s = state.settings;
    const scored = ok.map((r) => {
      const pAdj = r.pTrade == null ? 1 : Math.min(1, r.pTrade * K), eligible = r.selected.trades >= 50 && r.selected.meanR > 0 && r.gainR > 0;
      const status = r.forward ? (r.forward.passed ? 'forward_passed' : 'forward_failed') : pAdj < 0.05 ? 'candidate' : 'luck_likely';
      return { ...r, pAdj, eligible, status };
    });
    const top = scored.filter((r) => r.eligible).sort((a, b) => a.pAdj - b.pAdj || b.gainR - a.gainR).slice(0, s.keepTop);
    return { tested: K, eligible: scored.filter((r) => r.eligible).length, rawSignificant: ok.filter((r) => r.pTrade != null && r.pTrade < 0.05).length, adjSignificant: scored.filter((r) => r.pAdj < 0.05).length, expectedByLuck: Math.round(0.05 * K * 10) / 10, errors: state.rows.length - K, top };
  }
  function candleInfo() {
    const list = archives(), total = list.reduce((a, x) => a + x.candles, 0), us = universes(list);
    const files = [...new Set(us.flatMap((u) => u.archives.map((a) => a.file)))];
    let search = 0, sealed = 0; for (const f of files) { const a = list.find((x) => x.file === f); const sp = split(a); search += sp.search; sealed += sp.sealed; }
    const t = now();
    if (!state.lastTotals) { state.lastTotals = { total, at: t }; save(); }
    else if (state.lastTotals.total !== total) { state.lastChange = { at: t, delta: total - state.lastTotals.total, from: state.lastTotals.total, to: total }; state.lastTotals = { total, at: t }; save(); }
    return { archives: list.length, total, universes: us.map((u) => ({ key: u.key, tf: u.tf, kind: u.kind, files: u.archives.length, candles: u.archives.reduce((a, x) => a + x.candles, 0) })), usedFiles: files.length, search, sealed, lastChange: state.lastChange };
  }
  function status() {
    const s = state.settings, q = s.sealedFrom == null ? [] : queue();
    return { settings: s, now: Math.floor(now() / 1000), inWindow: inWindow(now(), s), reason: lastTick.reason, cpu: lastTick.cpu, lastTickAt: lastTick.at ? Math.floor(lastTick.at / 1000) : null, current, queueLeft: q.length, queueNew: q.filter((x) => x.why === 'new').length,
      lastFinished: state.lastFinished, board: leaderboard(), candles: candleInfo(), forwardCount: state.forwardCount, strategies: Object.entries(STRATEGIES).map(([id, d]) => ({ id, name: d.name, custom: !!d.custom })) };
  }
  function setSettings(patch) {
    const cur = state.settings, next = sanitize(patch, cur, strategyIds());
    if (patch && patch.sealedFrom !== undefined && patch.sealedFrom !== null && next.sealedFrom !== cur.sealedFrom) {
      if (state.forwardCount > 0) throw Object.assign(new Error('بعد از اجرای «بررسی نهایی» تاریخ کنارگذاری را نمی‌شود عوض کرد (دیدن نتیجه و بعد جابه‌جا کردن تاریخ آزمون را بی‌اعتبار می‌کند). فقط با «پاک‌کردن همه‌ی نتایج».'), { status: 400 });
    }
    if (next.enabled && next.sealedFrom == null) next.sealedFrom = Math.floor(now() / 1000) - next.sealedDays * DAY; // first switch-on: the last N days are sealed from now on
    state.settings = next; save();
    return status();
  }
  function reset() { if (current) throw Object.assign(new Error('یک کار در حال اجراست؛ بعد از تمام شدنش پاک کن.'), { status: 409 }); state.rows = []; state.forwardCount = 0; state.lastFinished = null; save(); return status(); }

  return { start, stop, tick, runNext, runForward, status, setSettings, reset, queue, universes, idle: () => jobPromise || Promise.resolve(), _state: () => state, _inWindow: inWindow };
}

module.exports = { create, sanitize, inWindow, DEFAULTS, spawnJob, sampleCpu };
