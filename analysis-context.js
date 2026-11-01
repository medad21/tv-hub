// Everything the assistant is allowed to say, as plain numbers and plain Persian sentences — computed by CODE, never by an AI model.
// For one symbol + timeframe it gathers: where each strategy stands right now (the same readings and the same signal function the
// backtester and the live bot use), market structure (support/resistance, trend, break/pullback), the trade plan the risk rules would
// produce (entry, stop, target, risk), the probability of reaching target vs stop (forecast.js), what the backtests said about each
// strategy on this timeframe, and how fresh and trustworthy the data is.
//
// An AI model (assistant.js) may only REWORD this. Every number it writes is checked against this object; a number that is not here is rejected.
const S = require('./strategy');
const ms = require('./market-structure');
const fc = require('./forecast');
const { costsFor } = require('./risk');

const MIN_BARS = 120;
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const cleanBars = (bars) => (Array.isArray(bars) ? bars : []).filter((b) => b && [b.time, b.open, b.max, b.min, b.close].every(finite) && b.max >= b.min);
const digitsFor = (p) => (p >= 1000 ? 2 : p >= 10 ? 3 : p >= 1 ? 4 : 5);
const rnd = (x, d) => (finite(x) ? Number(x.toFixed(d)) : null);
const TF_FA = { 1: '۱ دقیقه', 5: '۵ دقیقه', 15: '۱۵ دقیقه', 30: '۳۰ دقیقه', 60: '۱ ساعت', 120: '۲ ساعت', 240: '۴ ساعت', 1440: 'روزانه' };
const tfFa = (tf) => { const t = String(tf).toUpperCase(); const m = /^\d+$/.test(t) ? Number(t) : t === 'D' || t === '1D' ? 1440 : null; return (m && TF_FA[m]) || String(tf); };

// ---- what one built-in strategy "sees" right now, in words ----
function explainOne(cid, r, RS, atr, p) {
  const f1 = (x) => (finite(x) ? x.toFixed(1) : '—'), f2 = (x) => (finite(x) ? x.toFixed(2) : '—');
  if (cid === 'rsi_dip') {
    if (!finite(r.rsi)) return 'RSI هنوز قابل محاسبه نیست (داده کم است)';
    const zone = r.rsi < RS.buy ? 'در ناحیه‌ی خرید است' : r.rsi > RS.sell ? 'در ناحیه‌ی خروج است' : `${f1(r.rsi - RS.buy)} واحد تا ناحیه‌ی خرید فاصله دارد`;
    return `RSI(${RS.period}) الان ${f1(r.rsi)} است؛ خرید زیر ${RS.buy} و خروج بالای ${RS.sell}؛ ${zone}`;
  }
  if (cid === 'trend_ma') {
    if (!finite(r.emaShort) || !finite(r.emaLong)) return 'میانگین‌های متحرک هنوز قابل محاسبه نیستند';
    return `EMA(10) = ${p(r.emaShort)} ${r.emaShort > r.emaLong ? 'بالای' : 'زیر'} EMA(30) = ${p(r.emaLong)} (روند کوتاه‌مدت ${r.emaShort > r.emaLong ? 'صعودی' : 'نزولی'})؛ خرید فقط لحظه‌ی عبور EMA(10) از پایین به بالای EMA(30) است`;
  }
  if (cid === 'breakout') {
    if (!finite(r.hh) || !finite(r.ll)) return 'سقف و کف ۲۰ کندل هنوز قابل محاسبه نیست';
    const upTo = (r.hh - r.close) / atr;
    return `بالاترین سقف ۲۰ کندل قبل ${p(r.hh)} و پایین‌ترین کف ${p(r.ll)} است؛ قیمت ${p(r.close)}؛ ${r.close > r.hh ? 'بالای سقف بسته شده (شرط خرید)' : r.close < r.ll ? 'زیر کف بسته شده (شرط خروج)' : `برای سیگنال خرید باید بالای ${p(r.hh)} بسته شود (${f1(upTo)} ATR بالاتر)`}`;
  }
  if (cid === 'momentum_macd') {
    if (!finite(r.hist)) return 'MACD هنوز قابل محاسبه نیست';
    return `هیستوگرام MACD ${f2(r.hist)} است${finite(r.histPrev) ? ` (کندل قبل ${f2(r.histPrev)})` : ''}؛ خرید فقط لحظه‌ی عبور آن از صفر به بالا و خروج لحظه‌ی عبور به پایین است`;
  }
  return null;
}
const STANCE_FA = { 1: 'صعودی', '-1': 'نزولی', 0: 'خنثی' };

function evidenceFor(matrix, tf, sid, now) {
  if (!matrix) return { verdict: 'unknown', note: 'نتیجه‌ی مقایسه‌ی تایم‌فریم/استراتژی برای این نماد ذخیره نشده (بک‌تست > مقایسه را یک بار اجرا کن)' };
  const c = (matrix.cells || []).find((x) => String(x.tf) === String(tf) && x.strategyId === sid);
  if (!c) return { verdict: 'unknown', note: 'این ترکیب استراتژی و تایم‌فریم در آخرین مقایسه نبود' };
  return { verdict: c.verdict, reasons: c.reasons || [], trades: c.trades, ret: c.ret, pf: c.pf, avgR: c.avgR, maxDD: c.maxDD, holdout: c.holdout, error: !!c.error, ageDays: Math.max(0, Math.round((now - matrix.time) / 86400000)), windowDays: matrix.days };
}
const VERDICT_FA = { reliable: 'قابل اتکا', suspect: 'مشکوک', negative: 'منفی', insufficient: 'داده‌ی ناکافی', unknown: 'بررسی نشده' };

// input: { symbol, tf, bars (closed, oldest->newest), live (mt5-live read() result or null), strategies, cfg, matrix, calibration, horizon, paths, now, source }
function build(input) {
  const { symbol, tf, live = null, matrix = null, calibration = null, horizon = 12, paths = 2000, now = Date.now(), source = 'archive' } = input;
  const cfg = input.cfg || require('./config');
  const bars = cleanBars(input.bars);
  if (bars.length < MIN_BARS) return { ok: false, reason: `کندل کافی نیست (${bars.length} از حداقل ${MIN_BARS})؛ برای تحلیل باید تاریخچه‌ی بیشتری داشته باشی` };
  const { prepare } = require('./backtest'); // loaded here, not at the top: backtest.js is big and not needed to read this file
  const R = cfg.risk, RS = cfg.rsi, CF = cfg.confluence;
  const bs = bars.slice(-400), i = bs.length - 1, b = bs[i], prep = prepare(bs, RS, R);
  const p = (x) => (finite(x) ? Number(x.toFixed(digitsFor(b.close))) : null), d = digitsFor(b.close);
  const atrV = prep.at(i);
  if (!finite(atrV) || !(atrV > 0)) return { ok: false, reason: 'ATR قابل محاسبه نیست (قیمت ثابت یا داده ناقص)' };
  const tvSymbol = (live && live.tvSymbol) || symbol;

  const reading = { close: b.close, rsi: prep.rs[i], emaShort: prep.esh(i), emaLong: prep.elg(i), hist: prep.mh(i), histPrev: i > 0 ? prep.mh(i - 1) : null, hh: prep.hh(i), ll: prep.ll(i), trendEma: prep.em(i), volume: b.volume, avgVolume: prep.av(i) };

  // ---- data quality ----
  const warnings = [];
  const data = { source, candles: bars.length, lastCandleTime: b.time, fresh: source === 'live' ? !!(live && live.fresh) : null, ageSec: live ? live.ageSec : null, marketQuiet: !!(live && live.marketQuiet) };
  if (source === 'live' && live && !live.fresh) warnings.push(`داده‌ی زنده‌ی MT5 تازه نیست: ${live.staleReason || 'نامشخص'}`);
  if (data.marketQuiet) warnings.push('چند دقیقه است قیمت جدیدی نیامده؛ بازار بسته یا فید متوقف است');
  if (bars.length < 300) warnings.push(`فقط ${bars.length} کندل در دسترس است؛ اندیکاتورها و پیش‌بینی احتمالی با تاریخچه‌ی بیشتر قابل‌اتکاتر می‌شوند`);
  if (live && live.clock && live.clock.dstInWindow) warnings.push('ساعت کندل‌های قدیمی‌تر ممکن است یک ساعت جابه‌جا باشد (تغییر ساعت تابستانی)؛ قیمت‌ها درست‌اند');
  if (source === 'live' && live && live.warning) warnings.push(live.warning);

  // ---- structure ----
  const st = ms.analyze(bars, { window: 300 });
  const structure = st.ok ? { ...st, text: ms.describe(st) } : { ok: false, reason: st.reason, text: [st.reason] };

  // ---- the trade plan the risk rules would give (long-only, as the bot) ----
  const dist = atrV * R.atrMult, entry = b.close, sl = entry - dist, tp = entry + dist * R.takeProfitRR;
  const cst = costsFor(tvSymbol, R), roundTripPct = 2 * (cst.feePct + cst.slippagePct), costR = (roundTripPct / 100 * entry) / dist;
  const equity = live && live.account && finite(live.account.equity) ? live.account.equity : cfg.paper.balance;
  const spreadPrice = live && live.tick && finite(live.tick.spreadPoints) && finite(live.point) ? live.tick.spreadPoints * live.point : null;
  const plan = {
    entry: p(entry), stop: p(sl), target: p(tp), rewardToRisk: R.takeProfitRR, stopDistance: p(dist), stopPct: rnd(dist / entry * 100, 2),
    riskPerTradePct: R.riskPerTradePct, equity: rnd(equity, 2), equitySource: live && live.account ? 'MT5' : 'paper', riskAmount: rnd(equity * R.riskPerTradePct / 100, 2),
    roundTripCostPct: rnd(roundTripPct, 3), costInR: rnd(costR, 3),
    spread: spreadPrice === null ? null : { price: p(spreadPrice), pctOfStop: rnd(spreadPrice / dist * 100, 1) },
    note: 'ربات فقط خرید (Long) می‌کند؛ ورود در بازشدن کندل بعد انجام می‌شود، پس قیمت ورود واقعی کمی با این عدد فرق می‌کند',
  };
  if (plan.spread && plan.spread.pctOfStop > 10) warnings.push(`اسپرد ${plan.spread.pctOfStop}٪ فاصله‌ی حد ضرر است؛ هزینه‌ی ورود قابل‌توجه است`);

  // ---- probability: target before stop, and chances of touching the nearest zones ----
  const levels = [];
  const res = structure.ok && structure.nearest.resistance, sup = structure.ok && structure.nearest.support;
  if (res) levels.push({ name: 'nearest_resistance', price: res.low, dir: 'up' });
  if (sup) levels.push({ name: 'nearest_support', price: sup.high, dir: 'down' });
  const fcs = fc.forecast(bars, { horizon, paths }, { levels, trade: { sl, tp, entry, costR } });
  const forecast = fcs.ok ? {
    ok: true, horizon: fcs.horizon, paths: fcs.paths, assumptions: fcs.assumptions,
    pTargetFirst: rnd(fcs.trade.pTp, 3), pStopFirst: rnd(fcs.trade.pSl, 3), pNeither: rnd(fcs.trade.pNone, 3), expectedR: rnd(fcs.trade.expectedR, 2),
    closeRange: { low: p(fcs.closeQuantiles[0].price), median: p(fcs.closeQuantiles[2].price), high: p(fcs.closeQuantiles[4].price), lowPct: rnd(fcs.closeQuantiles[0].pct, 2), highPct: rnd(fcs.closeQuantiles[4].pct, 2) },
    zones: fcs.levels.map((l) => ({ name: l.name, price: p(l.price), dir: l.dir, probability: rnd(l.p, 3), medianBars: l.medianBars })),
    notes: fcs.notes,
    reliability: calibration ? { verdict: calibration.verdict, origins: calibration.origins, reasons: (calibration.reasons || []).slice(0, 3) } : { verdict: 'unknown', note: 'اعتبار این احتمال‌ها روی تاریخچه هنوز سنجیده نشده (آزمون کالیبراسیون را اجرا کن)' },
  } : { ok: false, reason: fcs.reason };

  // ---- each strategy ----
  const ids = (input.strategies && input.strategies.length ? input.strategies : Object.keys(S.STRATEGIES).filter((x) => !S.STRATEGIES[x].custom)).filter((x) => S.STRATEGIES[x]);
  const position = live && Array.isArray(live.positions) ? live.positions.filter((x) => x.type === 'buy')[0] || null : null;
  const strategies = ids.map((sid) => {
    const def = S.STRATEGIES[sid], READS = S.STRATEGY_READS[sid] || S.STRATEGY_READS.rsi_dip;
    const readAt = (j) => {
      const o = {};
      if (READS.custom) o.ctx = S.makeCtx(bs, j);
      for (const f of READS.fields) o[f] = f === 'rsi' ? prep.rs[j] : f === 'emaShort' ? prep.esh(j) : f === 'emaLong' ? prep.elg(j) : f === 'hist' ? prep.mh(j) : f === 'close' ? bs[j].close : f === 'hh' ? prep.hh(j) : prep.ll(j);
      return o;
    };
    const out = { id: sid, name: def.name || sid, isSetup: !!def.components, isCustom: !!def.custom, lines: [], components: null, signal: 'none', filteredSignal: 'none', error: null };
    let curr = null;
    try {
      curr = readAt(i);
      const prevv = READS.needsPrev && i > 0 ? readAt(i - 1) : null;
      out.signal = S.strategySignal(sid, curr, prevv, RS);
      const extra = { macdHist: prep.mh(i), macdPrevHist: i > 0 ? prep.mh(i - 1) : null, volume: b.volume, avgVol: prep.av(i) };
      out.filteredSignal = S.confluence(out.signal, extra, CF);
      out.confirmations = out.signal === 'buy' || out.signal === 'sell' ? S.checks(out.signal, extra, CF.volumeMult) : null;
    } catch (e) { out.error = String(e && e.message || e).slice(0, 200); }

    if (def.components) {
      const rc = def.rsiBuy != null || def.rsiSell != null ? { ...RS, ...(def.rsiBuy != null ? { buy: def.rsiBuy } : {}), ...(def.rsiSell != null ? { sell: def.rsiSell } : {}) } : RS;
      out.components = def.components.map((cid) => {
        const stance = curr ? S.componentStance(cid, curr, rc) : 0, cdef = S.STRATEGIES[cid] || {};
        return { id: cid, name: cdef.name || cid, stance, stanceFa: STANCE_FA[stance], text: explainOne(cid, reading, rc, atrV, p) };
      });
      const bull = out.components.filter((c) => c.stance === 1).length, bear = out.components.filter((c) => c.stance === -1).length;
      out.votes = { bullish: bull, bearish: bear, total: def.components.length, needToBuy: def.entryVotes, needToExit: def.exitVotes };
      out.lines.push(`${bull} از ${def.components.length} جزء الان صعودی است (برای خرید ${def.entryVotes} رأی لازم است) و ${bear} جزء نزولی است (با ${def.exitVotes} رأی نزولی خروج می‌دهد)`);
      for (const c of out.components) out.lines.push(`${c.name}: ${c.stanceFa}${c.text ? ' — ' + c.text : ''}`);
    } else if (!def.custom) {
      const t = explainOne(sid, reading, RS, atrV, p); if (t) out.lines.push(t);
      out.stance = curr ? S.componentStance(sid, curr, RS) : 0; out.stanceFa = STANCE_FA[out.stance];
    } else out.lines.push('استراتژی سفارشی: فقط خروجی فعلی آن در دسترس است');

    // ---- the decision, from the rules (never from an AI) ----
    const reasons = [], cautions = [];
    const trendOk = !R.trendFilter || (finite(reading.trendEma) && b.close > reading.trendEma);
    let decision;
    if (out.error) { decision = 'error'; reasons.push(`خطا در محاسبه‌ی این استراتژی: ${out.error}`); }
    else if (source === 'live' && live && !live.fresh) { decision = 'no_data'; reasons.push('داده‌ی زنده تازه نیست؛ تحلیل بر پایه‌ی داده‌ی کهنه گمراه‌کننده است'); }
    else if (out.filteredSignal === 'sell') {
      decision = position ? 'exit' : 'exit_signal';
      reasons.push(position ? 'استراتژی سیگنال خروج داده و یک پوزیشن خرید باز است' : 'استراتژی سیگنال خروج داده؛ ورود جدید وجود ندارد (ربات فقط خرید می‌کند)');
    } else if (out.signal === 'buy' && out.filteredSignal === 'buy') {
      if (!trendOk) { decision = 'entry_blocked'; reasons.push(`فیلتر روند ورود را رد می‌کند: قیمت (${p(b.close)}) زیر EMA(${R.trendEma}) = ${p(reading.trendEma)} است`); }
      else { decision = 'entry_ready'; reasons.push('سیگنال خرید صادر شده و فیلتر روند و تأییدیه‌ها قبول‌اند؛ ربات در بازشدن کندل بعد وارد می‌شود'); }
    } else if (out.signal === 'buy') {
      decision = 'entry_blocked'; reasons.push('سیگنال خرید صادر شد ولی تأییدیه‌ها (MACD / حجم) با آن هم‌نظر نیستند' + (out.confirmations ? ` (MACD: ${out.confirmations.macd === null ? 'نامشخص' : out.confirmations.macd ? 'تأیید' : 'رد'}، حجم: ${out.confirmations.volume === null ? 'نامشخص' : out.confirmations.volume ? 'تأیید' : 'رد'})` : ''));
    } else {
      decision = 'wait'; reasons.push(out.signal === 'none' ? 'داده‌ی گرم‌کردن این استراتژی هنوز کافی نیست' : 'شرط ورود هنوز برقرار نیست');
    }
    const ev = evidenceFor(matrix, tf, sid, now);
    if (ev.verdict === 'negative' || ev.verdict === 'suspect') cautions.push(`در بک‌تست روی همین نماد و تایم‌فریم «${VERDICT_FA[ev.verdict]}» بوده: ${(ev.reasons || [])[0] || ''}`.trim());
    else if (ev.verdict === 'insufficient') cautions.push('داده‌ی بک‌تست برای قضاوت درباره‌ی این ترکیب کافی نبوده');
    else if (ev.verdict === 'unknown') cautions.push(ev.note);
    if (ev.ageDays > 30) cautions.push(`آخرین بررسی بک‌تست ${ev.ageDays} روز پیش بوده`);
    if (forecast.ok && forecast.reliability.verdict === 'unreliable') cautions.push('آزمون کالیبراسیون نشان داده احتمال‌های پیش‌بینی روی این بازار کاملاً قابل‌اتکا نیستند');
    if (decision === 'entry_ready' && forecast.ok && forecast.expectedR < 0) cautions.push(`با نوسان فعلی، امید ریاضی معامله (${forecast.expectedR} R) منفی است`);
    const grade = decision !== 'entry_ready' ? null : ev.verdict === 'reliable' ? 'A' : (ev.verdict === 'negative' || ev.verdict === 'suspect') ? 'C' : 'B';
    return { ...out, decision, reasons, cautions, grade, evidence: ev };
  });

  return {
    ok: true, generatedAt: now, symbol, tvSymbol, tf: String(tf), timeframeFa: tfFa(tf), source, time: b.time, price: p(b.close), atr: p(atrV), atrPct: rnd(atrV / b.close * 100, 3), digits: d,
    config: { rsiPeriod: RS.period, rsiBuy: RS.buy, rsiSell: RS.sell, emaShort: 10, emaLong: 30, breakoutLookback: 20, macd: [12, 26, 9], atrPeriod: R.atrPeriod, atrMult: R.atrMult, trendFilter: !!R.trendFilter, trendEma: R.trendEma, takeProfitRR: R.takeProfitRR, riskPerTradePct: R.riskPerTradePct, horizonCandles: forecast.ok ? forecast.horizon : horizon, longOnly: true },
    readings: { rsi: rnd(reading.rsi, 1), emaShort: p(reading.emaShort), emaLong: p(reading.emaLong), macdHist: rnd(reading.hist, 3), breakoutHigh: p(reading.hh), breakoutLow: p(reading.ll), trendEma: p(reading.trendEma) },
    data, warnings, structure, plan, forecast, position: position ? { ticket: position.ticket, volume: position.volume, open: position.open, sl: position.sl, tp: position.tp, profit: position.profit } : null,
    account: live && live.account ? { currency: live.account.currency, equity: live.account.equity, balance: live.account.balance, marginFree: live.account.marginFree } : null,
    live: live && live.tick ? { bid: live.tick.bid, ask: live.tick.ask, spreadPoints: live.tick.spreadPoints } : null,
    strategies,
  };
}

module.exports = { build, explainOne, evidenceFor, tfFa, MIN_BARS, VERDICT_FA };
