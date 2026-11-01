// The ML lab, pooled: ONE model learns from SEVERAL symbols at once, and is tested on data it has never seen in two ways at the same time.
//
// Why: on a single symbol a few thousand candles are only a few dozen independent samples (labels overlap), so almost nothing can be
// told apart from luck. Every feature in ml.js is already measured in ATR units, so candles of different symbols are comparable and can
// share one model: several times more samples, and a much harder question — "did it learn something about MARKETS, not about one chart?"
//
// The test is strict on both axes:
//   * TIME   — the training part only contains labels that were completely finished before the test block began (the same gap as ml.js);
//              the blocks are calendar blocks shared by all symbols, so BTC's 2024 is never used to predict ETH's 2024.
//   * SYMBOL — mode "loso" (leave one symbol out, the default): the symbol being tested is NOT in the training data at all, in any period.
//              mode "walk": all symbols are in training (earlier periods only) and all are tested in the next block (more test data,
//              but it only proves "forward in time", not "other symbol").
// Symbols are correlated (BTC and ETH mostly move together), so the statistics keep that: the permutation test shifts the labels of ALL
// symbols by the SAME amount of time, and the AUC interval resamples the same calendar blocks for every symbol.
// META-LABELING (runMeta, same file): instead of asking the model "up or down?" on EVERY candle, a strategy from strategy.js produces the
// signals (the same edge-detected buy/sell signals the backtest and the live bot act on) and the model only decides "take this one or skip
// it". The questions that matter are then: is the filtered result better than taking every signal, and is the filter's choice better than
// a random choice of the same size? Everything else (time + symbol hold-out, correlation-aware statistics, audit) is the same as above.
// Report only; it never trades and never touches the bot.
'use strict';
const ml = require('./ml');
const { group } = require('./symbols');
const { MLError } = ml;

// Archive name -> TradingView-style symbol (BINANCE_BTCUSDT_60 -> BINANCE:BTCUSDT, MT5_OANDA_XAUUSD_60 -> OANDA:XAUUSD), so the bot's own per-market
// cost table (config.js risk.costs) applies. Round-trip cost = two sides of (fee + slippage), as a fraction of price.
function symbolOf(file) { return String(file).replace(/_[^_]+$/, '').replace(/^MT5_/, '').replace('_', ':'); }
function costPctFor(file, table) {
  const t = table || {}, g = group(symbolOf(file)), c = g && t.costs && t.costs[g];
  const fee = c && c.feePct != null ? c.feePct : (t.feePct != null ? t.feePct : 0.1), slip = c && c.slippagePct != null ? c.slippagePct : (t.slippagePct != null ? t.slippagePct : 0.05);
  return 2 * (fee + slip) / 100;
}

const MAX_TRAIN = 40000; // training rows per model: neighbouring candles carry almost the same label, so taking every k-th row loses very little and keeps it fast
const MIN_SYMBOLS = 2, MAX_SYMBOLS = 12;
const sum = (a) => a.reduce((x, y) => x + y, 0);

// ---------------------------------------------------------------------------------------------------------------------------
// data
function prepareSets(sets, p, ev, table) {
  const feats = p.features.filter((g) => g !== 'structure'); // market-structure analysis is too slow for hundreds of thousands of candles
  const q = { ...p, features: feats };
  const tfs = sets.map((x) => ml.inferTf(x.bars));
  if (tfs.some((t) => t !== tfs[0])) throw new MLError('همه‌ی آرشیوها باید یک تایم‌فریم داشته باشند (الان تایم‌فریم‌ها فرق دارند).');
  const need = ml.warmFor(feats, ml.windows(tfs[0])) + p.horizon + 700;
  const backtest = ev ? require('./backtest') : null, want = ev && ev.dir === 'short' ? 'sell' : 'buy';
  const prepared = sets.map((x, k) => {
    if (!Array.isArray(x.bars) || x.bars.length < need) throw new MLError(`کندل کافی نیست: ${x.name} دست‌کم ${need} کندل لازم دارد (الان ${Array.isArray(x.bars) ? x.bars.length : 0}).`);
    const pre = ml.prepare(x.bars, q), base = [];
    let sig = null;
    if (ev) { sig = backtest.signalSeries(x.bars, ev.strategy, ev.rsi, ev.risk); if (!sig) throw new MLError('این استراتژی پیدا نشد (حذف شده یا خطا دارد).'); }
    for (let i = pre.warm; i + p.horizon <= pre.s.n - 1; i++) {
      if (sig && !(sig[i] === want && sig[i - 1] !== want)) continue; // meta-labeling: only the candles where the strategy has just turned to buy (or sell)
      if (!pre.ext[i]) continue;
      const row = ml.featureRow(pre.s, i).concat(pre.ext[i]);
      if (row.some((v) => !Number.isFinite(v))) continue;
      base.push({ i, t: x.bars[i].time, tEnd: x.bars[i + p.horizon].time + pre.tfSec, x: row });
    }
    return { name: x.name, bars: x.bars, pre, base, k, costPct: p.costMode === 'real' ? costPctFor(x.name, table) : null };
  });
  return { prepared, tfSec: tfs[0], names: prepared[0].pre.names, feats, meta: ev ? { strategy: ev.strategy, dir: ev.dir === 'short' ? 'short' : 'long' } : null };
}

// the labels depend on the cost; the features do not (so a cost sweep prepares once)
function label(set, p, meta) {
  const out = [];
  for (const b of set.base) {
    // meta-labeling: one outcome only (the direction of the strategy's signal), stored on both sides so every statistic below works unchanged
    const pp = set.costPct != null ? { ...p, costPct: set.costPct * p.costMult } : p; // real mode: this symbol's own cost
    const L = ml.outcome(set.pre.s, b.i, meta ? meta.dir : 'long', pp), S = meta ? L : ml.outcome(set.pre.s, b.i, 'short', pp);
    if (!L || !S) continue;
    out.push({ i: b.i, t: b.t, tEnd: b.tEnd, x: b.x, L, S, yL: L.R > 0 ? 1 : 0, yS: S.R > 0 ? 1 : 0 });
  }
  return out;
}
const lowerBound = (arr, key, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m][key] < v) lo = m + 1; else hi = m; } return lo; };
const upperBound = (arr, key, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m][key] <= v) lo = m + 1; else hi = m; } return lo; };

// ---------------------------------------------------------------------------------------------------------------------------
// statistics that keep the correlation between symbols
// The null worlds below move every symbol's labels by the SAME amount of CALENDAR time (not the same index): with all candles that is the same
// thing, with sparse signals (meta-labeling) each symbol has a different number of events, so the shift is converted per symbol.
function groupsOf(oos, minN = 50) { return oos.filter((g) => g.length >= minN); }
const lbT = (T, v) => { let lo = 0, hi = T.length; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < v) lo = m + 1; else hi = m; } return lo; };
function shiftsFor(G, H, u) {
  const d = u * Math.min(...G.map((g) => g.T[g.n - 1] - g.T[0]));
  return G.map((g) => { const lo = Math.min(2 * H, Math.floor(g.n / 4)); return Math.max(lo, Math.min(g.n - lo, lbT(g.T, g.T[0] + d))); });
}

function pooledPermAuc(oos, H, B = 2000, minN = 50) {
  const G = groupsOf(oos, minN).map((g) => {
    const n = g.length, yL = g.map((q) => q.yL), yS = g.map((q) => q.yS), PL = sum(yL), PS = sum(yS);
    return { n, T: g.map((q) => q.t), yL, yS, PL, PS, rL: ml.ranksOf(g.map((q) => q.pL)), rS: ml.ranksOf(g.map((q) => q.pS)) };
  }).filter((g) => g.PL && g.PS && g.PL < g.n && g.PS < g.n);
  if (!G.length) return null;
  const aucOf = (g, r, y, P, o) => { let s = 0; for (let i = 0; i < g.n; i++) { let k = i + o; if (k >= g.n) k -= g.n; if (y[k]) s += r[i]; } return (s - P * (P + 1) / 2) / (P * (g.n - P)); };
  const meanAt = (offs) => ({ L: sum(G.map((g, j) => aucOf(g, g.rL, g.yL, g.PL, offs[j]))) / G.length, S: sum(G.map((g, j) => aucOf(g, g.rS, g.yS, g.PS, offs[j]))) / G.length });
  const o0 = meanAt(G.map(() => 0)), obs = Math.max(o0.L, o0.S), rand = ml.rng(777);
  let ge = 0, tot = 0;
  for (let b = 0; b < B; b++) {
    const m = meanAt(shiftsFor(G, H, 0.15 + 0.7 * rand())), a = Math.max(m.L, m.S); // the SAME calendar shift for every symbol
    tot += a; if (a >= obs) ge++;
  }
  return { p: (ge + 1) / (B + 1), nullMean: tot / B, B };
}

function pooledPermTrades(oos, obsMean, nTrades, H, B = 300, minN = 50) {
  const G = groupsOf(oos, minN).map((g) => Object.assign(g.slice(), { n: g.length, T: g.map((q) => q.t) })); if (nTrades < 10 || !G.length) return null;
  const rand = ml.rng(4242);
  let ge = 0, used = 0, tot = 0;
  for (let b = 0; b < B; b++) {
    const offs = shiftsFor(G, H, 0.15 + 0.7 * rand()); let t = 0, c = 0;
    G.forEach((g, j) => {
      const n = g.length, o = offs[j]; let busy = -1;
      for (let s = 0; s < n; s++) {
        const q = g[s]; if (q.i < busy) continue;
        let k = s + o; if (k >= n) k -= n; const w = g[k], eL = w.pL - w.tL, eS = w.pS - w.tS;
        if (eL <= 0 && eS <= 0) continue;
        const out = eL >= eS ? q.L : q.S; t += out.R; c++; busy = out.exit;
      }
    });
    if (c < 5) continue;
    used++; const m = t / c; tot += m; if (m >= obsMean) ge++;
  }
  return used ? { p: (ge + 1) / (used + 1), nullMean: tot / used, B: used } : null;
}

function pooledAucCI(oos, H, tfSec, B = 300, minN = 50) {
  const G = groupsOf(oos, minN).map((g) => {
    const n = g.length, ord = (key) => Array.from({ length: n }, (_, i) => i).sort((a, b) => g[a][key] - g[b][key]);
    return { n, T: g.map((q) => q.t), yL: g.map((q) => q.yL), yS: g.map((q) => q.yS), oL: ord('pL'), oS: ord('pS') };
  });
  if (!G.length) return null;
  const bl = H * tfSec; // a block = H candles of calendar time (labels reach H candles ahead, so they are dependent inside it)
  G.forEach((g) => { g.t0 = g.T[0]; g.span = g.T[g.n - 1] - g.T[0]; g.nb = Math.max(1, Math.ceil(g.span / bl)); });
  const rand = ml.rng(99), nbMax = Math.max(...G.map((g) => g.nb)), res = { L: [], S: [] }, mult = G.map((g) => new Int32Array(g.n));
  const aucW = (order, y, m) => { let cumNeg = 0, num = 0, P = 0, N = 0; for (let k = 0; k < order.length; k++) { const i = order[k], mm = m[i]; if (!mm) continue; if (y[i]) { P += mm; num += mm * cumNeg; } else { cumNeg += mm; N += mm; } } return P && N ? num / (P * N) : null; };
  for (let b = 0; b < B; b++) {
    const us = Array.from({ length: nbMax }, () => rand());
    const aL = [], aS = [];
    G.forEach((g, gi) => {
      const m = mult[gi]; m.fill(0);
      for (let k = 0; k < g.nb; k++) { // same calendar position for every symbol
        const st = g.t0 + us[k] * Math.max(0, g.span - bl), a = lbT(g.T, st), z = lbT(g.T, st + bl);
        for (let t = a; t < z; t++) m[t]++;
      }
      const l = aucW(g.oL, g.yL, m), s2 = aucW(g.oS, g.yS, m); if (l !== null) aL.push(l); if (s2 !== null) aS.push(s2);
    });
    if (aL.length) res.L.push(sum(aL) / aL.length); if (aS.length) res.S.push(sum(aS) / aS.length);
  }
  const ci = (a) => { if (a.length < 20) return null; a.sort((x, y) => x - y); return [a[Math.floor(a.length * 0.025)], a[Math.floor(a.length * 0.975)]]; };
  return { long: ci(res.L), short: ci(res.S) };
}

// ---------------------------------------------------------------------------------------------------------------------------
function evaluate(prep, labelled, p, mode, extra) {
  const { prepared, names, meta } = prep, S = prepared.length, train = ml.MODELS[p.model];
  const MINROWS = meta ? 120 : 300, MINN = meta ? 20 : 50; // a strategy gives far fewer samples than "every candle", so the floors are lower
  const all = []; for (const l of labelled) for (const q of l) all.push(q.t);
  all.sort((a, b) => a - b);
  const N = all.length, cutoff = extra.cutoff || null; // cutoff (seconds): ONE block = everything after it, trained only on what happened before it (the sealed forward check)
  const first = cutoff ? all.filter((t) => t < cutoff).length : Math.floor(N * p.trainFrac), size = cutoff ? N - first : Math.ceil((N - first) / p.folds);
  if (cutoff && size < 1) throw new MLError('بعد از تاریخ کنارگذاری هیچ سیگنالی نیست؛ داده‌ی تازه هنوز کم است.');
  if (first < MINROWS || size < (meta ? 10 : 50)) throw new MLError(meta ? 'تعداد سیگنال‌های این استراتژی برای آموزش و آزمون کافی نیست؛ نماد یا کندل بیشتر، یا تایم‌فریم پایین‌تر، یا استراتژی پرسیگنال‌تر انتخاب کن.' : 'بعد از آماده‌سازی، نمونه‌ی کافی برای آموزش و آزمون نمانده؛ کندل بیشتری لازم است.');
  const edges = []; if (cutoff) edges.push(cutoff); else for (let f = 0; f < p.folds; f++) { const ix = first + f * size; if (ix >= N) break; edges.push(all[ix]); }
  edges.push(Infinity);
  const oos = Array.from({ length: S }, () => []), foldInfo = [], imp = new Array(names.length).fill(0);
  let trainings = 0, heldOutInTrain = false;
  const audit = { maxTrainEndBeforeTest: true, heldOutInTrain: false };

  const fit = (idx, lo) => { // idx = symbols the model may learn from; only rows whose label finished before `lo`
    const cuts = idx.map((k) => upperBound(labelled[k], 'tEnd', lo)), total = sum(cuts);
    const stride = Math.max(1, Math.ceil(total / MAX_TRAIN)), rows = []; let maxEnd = 0;
    idx.forEach((k, j) => { for (let r = 0; r < cuts[j]; r += stride) { const q = labelled[k][r]; rows.push(q); if (q.tEnd > maxEnd) maxEnd = q.tEnd; } });
    if (rows.length < MINROWS) { if (meta) return null; throw new MLError('دادهٔ آموزش کم است.'); } // meta-labeling: early blocks may have too few signals to learn from; they are simply not tested
    const X = rows.map((q) => q.x), mL = train(X, rows.map((q) => q.yL)), mS = meta ? mL : train(X, rows.map((q) => q.yS)); // meta: one outcome, one model
    const baseL = sum(rows.map((q) => q.yL)) / rows.length, baseS = sum(rows.map((q) => q.yS)) / rows.length;
    const iL = mL.importance(), iS = mS.importance(), tot = sum(iL) + sum(iS) || 1;
    for (let k = 0; k < imp.length; k++) imp[k] += (iL[k] + iS[k]) / tot; trainings++;
    return { mL, mS, baseL, baseS, rows: rows.length, maxEnd };
  };

  for (let f = 0; f < edges.length - 1; f++) {
    const lo = edges[f], hi = edges[f + 1];
    let tested = 0, trainRows = 0, maxEnd = 0, firstT = Infinity, lastT = 0, fits = 0;
    const shared = mode === 'walk' ? fit(prepared.map((_, k) => k), lo) : null;
    if (mode === 'walk' && !shared) continue;
    for (let h = 0; h < S; h++) {
      const lab = labelled[h], a = lowerBound(lab, 't', lo), b = hi === Infinity ? lab.length : lowerBound(lab, 't', hi);
      if (b - a < 1) continue;
      let m = shared;
      if (!m) {
        const others = prepared.map((_, k) => k).filter((k) => k !== h);
        m = fit(others, lo);
        if (!m) continue;
        if (others.includes(h)) heldOutInTrain = true;
      }
      fits++; trainRows += m.rows; if (m.maxEnd > maxEnd) maxEnd = m.maxEnd;
      for (let r = a; r < b; r++) {
        const q = lab[r];
        oos[h].push({ i: q.i, t: q.t, L: q.L, S: q.S, yL: q.yL, yS: q.yS, pL: m.mL.predict(q.x), pS: m.mS.predict(q.x), tL: m.baseL + p.margin, tS: m.baseS + p.margin, fold: f });
        tested++; if (q.t < firstT) firstT = q.t; if (q.t > lastT) lastT = q.t;
      }
    }
    if (!tested) continue;
    if (maxEnd > firstT) audit.maxTrainEndBeforeTest = false;
    foldInfo.push({ from: firstT, to: lastT, samples: tested, trainSamples: Math.round(trainRows / Math.max(1, fits)), f });
  }
  audit.heldOutInTrain = heldOutInTrain;
  if (!foldInfo.length) throw new MLError(meta ? 'هیچ بازه‌ای سیگنال کافی برای آموزش نداشت؛ نماد یا کندل بیشتر، یا تایم‌فریم پایین‌تر، یا استراتژی پرسیگنال‌تر انتخاب کن.' : 'هیچ نمونه‌ی آزمونی ساخته نشد.');

  const keep = oos.map((g, k) => ({ g, k })).filter((x) => x.g.length >= MINN);
  if (!keep.length) throw new MLError(`در بخش آزمون هیچ نمادی دست‌کم ${MINN} ${meta ? 'سیگنال' : 'نمونه'} نداشت.`);
  const sets = keep.map((x) => x.g);
  const perSym = keep.map(({ g, k }) => {
    const aL = ml.auc(g.map((q) => q.pL), g.map((q) => q.yL)), aS = ml.auc(g.map((q) => q.pS), g.map((q) => q.yS));
    const tr = ml.simulate(g, (q) => { const eL = q.pL - q.tL, eS = q.pS - q.tS; if (eL <= 0 && eS <= 0) return null; return eL >= eS ? 'long' : 'short'; });
    const st = ml.tradeStats(tr), hold = (prepared[k].bars[g[g.length - 1].i].close / prepared[k].bars[g[0].i + 1].open - 1) * 100;
    const costAtr = g.reduce((a, q) => a + (q.L.c || 0), 0) / g.length; // average round-trip cost of this symbol's samples, in ATR
    return { name: prepared[k].name, samples: g.length, candles: prepared[k].bars.length, costAtr, aucLong: aL, aucShort: aS, trades: st.trades, meanR: st.meanR, winRate: st.winRate, holdPct: hold, from: g[0].t, to: g[g.length - 1].t, _tr: tr };
  });
  const model = perSym.flatMap((x) => x._tr), st = ml.tradeStats(model), pv = ml.bootstrapP(model.map((t) => t.R));
  const randL = sets.flatMap((g) => ml.simulate(g, () => 'long')), randS = sets.flatMap((g) => ml.simulate(g, () => 'short'));
  const baseline = { long: ml.tradeStats(randL), short: ml.tradeStats(randS) }, beats = st.meanR > Math.max(baseline.long.meanR, baseline.short.meanR);
  const valid = (v) => Number.isFinite(v), mean = (a) => (a.length ? sum(a) / a.length : null);
  const aucL = mean(perSym.map((x) => x.aucLong).filter(valid)), aucS = mean(perSym.map((x) => x.aucShort).filter(valid)), aucBest = Math.max(aucL || 0, aucS || 0);
  const byFold = foldInfo.map((fo) => { const t = model.filter((x) => x.fold === fo.f), q = ml.tradeStats(t); return { ...fo, trades: q.trades, meanR: q.meanR }; });
  const withTrades = byFold.filter((q) => q.trades >= 3), good = withTrades.filter((q) => q.meanR > 0).length;
  const byDirection = {}; for (const d of ['long', 'short']) byDirection[d] = ml.tradeStats(model.filter((t) => t.dir === d));
  let stats = null;
  if (extra.stats !== false) {
    const aucPerm = pooledPermAuc(sets, p.horizon, 2000, MINN), tradePerm = pooledPermTrades(sets, st.meanR, st.trades, p.horizon, 300, MINN), aucCI = pooledAucCI(sets, p.horizon, prep.tfSec, 300, MINN) || { long: null, short: null };
    const thin = (g) => { let c = 0, last = -Infinity; for (const q of g) if (q.t - last >= p.horizon * prep.tfSec) { c++; last = q.t; } return c; }; // signals that do not overlap in time
    stats = { aucPerm, tradePerm, aucCI, effectiveN: meta ? sum(sets.map(thin)) : Math.round(sum(sets.map((g) => g.length)) / p.horizon) };
  }
  const bestSide = (aucL || 0) >= (aucS || 0) ? 'long' : 'short';
  const verdict = ml.judge({ st, pv, aucBest, good, withTrades: withTrades.length, beats, stats, ciLow: stats && stats.aucCI[bestSide] ? stats.aucCI[bestSide][0] : null });
  if (meta) verdict.text += ` فیلتر مدل ${st.trades} سیگنال از ${baseline.long.trades} سیگنال را گرفت؛ میانگین ${st.meanR.toFixed(2)}R در برابر ${baseline.long.meanR.toFixed(2)}R اگر همه‌ی سیگنال‌های استراتژی گرفته می‌شد.`;
  if (verdict.level !== 'none') verdict.text += ' نمادها با هم همبسته‌اند (مثلاً بیت‌کوین و اتریوم تقریباً هم‌جهت حرکت می‌کنند)، پس شواهد واقعی کمتر از شمارش ظاهری است.';
  const sortedP = sets.flat().map((q) => Math.max(q.pL - q.tL, q.pS - q.tS));
  return {
    ok: true, pooled: true, mode, params: p, candles: sum(prepared.map((x) => x.bars.length)), cost: { mode: p.costMode, mult: p.costMult, avgAtr: mean(perSym.map((x) => x.costAtr)) }, samples: sum(labelled.map((l) => l.length)), oosSamples: sum(sets.map((g) => g.length)),
    from: foldInfo[0].from, to: foldInfo[foldInfo.length - 1].to, auc: { long: aucL, short: aucS }, trades: st, byDirection, pValue: pv, baseline,
    hold: { pct: mean(perSym.map((x) => x.holdPct)), from: Math.min(...perSym.map((x) => x.from)), to: Math.max(...perSym.map((x) => x.to)) },
    folds: byFold, foldsProfitable: good, foldsWithTrades: withTrades.length,
    importance: names.map(([id, fa], k) => ({ id, name: fa, share: imp[k] / Math.max(1, trainings) })).sort((a, b) => b.share - a.share).slice(0, 6),
    features: { groups: prep.feats, ref: false, count: names.length }, stats, perSymbol: perSym.map(({ _tr, ...x }) => x), audit, trainings,
    meta: meta ? { strategy: meta.strategy, dir: meta.dir, signals: sum(sets.map((g) => g.length)), takeAll: baseline.long, selected: st, gainR: st.meanR - baseline.long.meanR } : null,
    breakEvenWinRate: (1 + p.costAtr / p.slAtr) / (1 + p.rr), thresholdMargin: p.margin, unusedSignals: sortedP.filter((x) => x <= 0).length, verdict,
  };
}

function runPooled(sets, options, extra = {}) {
  const t0 = Date.now();
  if (!Array.isArray(sets) || sets.length < MIN_SYMBOLS || sets.length > MAX_SYMBOLS) throw new MLError('برای آزمون چندنمادی ۲ تا ۱۲ آرشیو لازم است.');
  const p = ml.normalize(options), mode = options && options.mode === 'walk' ? 'walk' : 'loso';
  const prep = extra.prep || prepareSets(sets, p, undefined, options && options.costTable);
  const res = evaluate(prep, prep.prepared.map((s) => label(s, p, prep.meta)), p, mode, extra);
  res.symbols = prep.prepared.map((s) => s.name); res.ms = Date.now() - t0;
  return res;
}

// Meta-labeling: options = the usual lab options + { strategy: id from strategy.js, dir: 'long' (buy signals) | 'short' (sell signals),
// mode: 'loso' | 'walk', rsi: {period,buy,sell}, risk: {atrPeriod,trendEma} } (the last two = the bot's current settings, so a signal means what it means live),
// costTable: the bot's { feePct, slippagePct, costs: { crypto, stock, forex } } (used when costMode is 'real') }.
// ONE archive is allowed (then only the time hold-out applies); several are pooled exactly as in runPooled.
// extra.cutoff (seconds): the sealed forward check — train only on what happened before it, test on everything after it, one block.
function metaSetup(sets, options) {
  if (!Array.isArray(sets) || sets.length < 1 || sets.length > MAX_SYMBOLS) throw new MLError('برای متالیبلینگ ۱ تا ۱۲ آرشیو لازم است.');
  const p = ml.normalize(options), o = options || {};
  const cfg = require('./config'), rsi = { ...cfg.rsi, ...(o.rsi || {}) }, risk = { ...cfg.risk, ...(o.risk || {}) };
  const ev = { strategy: String(o.strategy || ''), dir: o.dir === 'short' ? 'short' : 'long', rsi, risk };
  return { p, ev, mode: sets.length < 2 || o.mode === 'walk' ? 'walk' : 'loso', table: o.costTable };
}
function runMeta(sets, options, extra = {}) {
  const t0 = Date.now(), { p, ev, mode, table } = metaSetup(sets, options);
  const prep = extra.prep || prepareSets(sets, p, ev, table);
  const res = evaluate(prep, prep.prepared.map((s) => label(s, p, prep.meta)), p, mode, extra);
  res.symbols = prep.prepared.map((s) => s.name); res.ms = Date.now() - t0;
  return res;
}

// The cost sweep. Fixed cost: 0 / 0.1 / 0.2 ATR and the chosen one. Real cost: 0x / 0.5x / 1x / 2x the bot's own market table (and the chosen multiple).
function sweepRuns(prep, p0, mode) {
  const real = p0.costMode === 'real', r3 = (x) => Math.round(x * 1000) / 1000;
  const steps = [...new Set((real ? [0, 0.5, 1, 2, p0.costMult] : [0, 0.1, 0.2, p0.costAtr]).map(r3))].sort((a, b) => a - b), mainIdx = steps.indexOf(r3(real ? p0.costMult : p0.costAtr));
  const runs = steps.map((c, k) => { const p = real ? { ...p0, costMult: c } : { ...p0, costAtr: c }; return evaluate(prep, prep.prepared.map((s) => label(s, p, prep.meta)), p, mode, { stats: k === mainIdx }); });
  const main = runs[mainIdx];
  main.costSweep = runs.map((r, k) => ({ costAtr: real ? r.cost.avgAtr : r.params.costAtr, costMult: real ? steps[k] : null, main: k === mainIdx, trades: r.trades.trades, meanR: r.trades.meanR, winRate: r.trades.winRate, aucBest: Math.max(r.auc.long || 0, r.auc.short || 0), level: r.verdict.level }));
  return main;
}
function runMetaSweep(sets, options) {
  const { p: p0, ev, mode, table } = metaSetup(sets, options), t0 = Date.now();
  const prep = prepareSets(sets, p0, ev, table), main = sweepRuns(prep, p0, mode);
  main.symbols = prep.prepared.map((s) => s.name); main.ms = Date.now() - t0;
  return main;
}
function runPooledSweep(sets, options) {
  const p0 = ml.normalize(options), mode = options && options.mode === 'walk' ? 'walk' : 'loso';
  if (!Array.isArray(sets) || sets.length < MIN_SYMBOLS || sets.length > MAX_SYMBOLS) throw new MLError('برای آزمون چندنمادی ۲ تا ۱۲ آرشیو لازم است.');
  const prep = prepareSets(sets, p0, undefined, options && options.costTable), t0 = Date.now(), main = sweepRuns(prep, p0, mode);
  main.symbols = prep.prepared.map((s) => s.name); main.ms = Date.now() - t0;
  return main;
}

module.exports = { runPooled, runPooledSweep, runMeta, runMetaSweep, pooledPermAuc, pooledPermTrades, pooledAucCI, symbolOf, costPctFor, MAX_TRAIN, MIN_SYMBOLS, MAX_SYMBOLS };
