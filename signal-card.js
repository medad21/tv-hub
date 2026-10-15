// Complete, human-readable signal messages (Telegram + dashboard) for SIGNAL mode.
// A bare "sell @ 67250" is not actionable: you need to know what it relates to, where to get in, where the stop and
// target are, how big, why it fired, and — on the way out — what the trade ended up doing. Pure text builders, no I/O.

const LINE = '━━━━━━━━━━━━━━';
const TF_FA = { 1: '۱ دقیقه', 3: '۳ دقیقه', 5: '۵ دقیقه', 15: '۱۵ دقیقه', 30: '۳۰ دقیقه', 45: '۴۵ دقیقه', 60: '۱ ساعت', 120: '۲ ساعت', 180: '۳ ساعت', 240: '۴ ساعت', 1440: 'روزانه', 10080: 'هفتگی' };
const tfFa = (tf) => { const t = String(tf).toUpperCase(); const m = /^\d+$/.test(t) ? Number(t) : t === 'D' || t === '1D' ? 1440 : t === 'W' || t === '1W' ? 10080 : null; return (m && TF_FA[m]) || String(tf); };

// price with sensible precision: 67250.12 / 1.0843 / 0.00001234
const num = (x) => {
  if (x == null || !Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  const d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return Number(x.toFixed(d)).toString();
};
const sgn = (x, d = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
const pctFrom = (from, to) => ((to / from - 1) * 100);
const when = (barTime) => (barTime ? new Date((barTime < 1e12 ? barTime * 1000 : barTime)).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : null);
const dur = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d ? `${d} روز` : '', h ? `${h} ساعت` : '', !d && mm ? `${mm} دقیقه` : ''].filter(Boolean).join(' و ') || 'کمتر از ۱ دقیقه';
};
const tick = (v) => (v === true ? '✅' : v === false ? '❌' : '➖');
const head = (icon, title, symbol, tf, strategyName, barTime) =>
  `${icon} ${title} — ${symbol}\n` + [`تایم‌فریم: ${tfFa(tf)}`, strategyName ? `استراتژی: ${strategyName}` : null, when(barTime) ? `کندل: ${when(barTime)}` : null].filter(Boolean).join(' | ');

function buyCard(c) {
  const L = [head('🟢', 'سیگنال خرید', c.symbol, c.tf, c.strategyName, c.barTime), LINE];
  L.push(`📍 ورود پیشنهادی: ${num(c.price)}  (قیمت لحظه‌ی بسته شدن کندل)`);
  L.push(`🛑 حد ضرر: ${num(c.sl)}  (${sgn(pctFrom(c.price, c.sl))}٪) — ${c.atrMult} × ATR`);
  L.push(`🎯 حد سود: ${num(c.tp)}  (${sgn(pctFrom(c.price, c.tp))}٪) — ریسک به ریوارد ۱ به ${c.rr}`);
  if (c.partial) L.push(`↗️ خروج پلکانی: ${c.partial.closePct}٪ پوزیشن در ${num(c.partial.price)} (${sgn(pctFrom(c.price, c.partial.price))}٪) ببند و حد ضرر باقی‌مانده را به نقطه‌ی ورود بیاور`);
  if (c.trailing) L.push('🔁 حد ضرر دنبال‌کننده: بعد از ۱ برابر ریسک سود، حد ضرر به نقطه‌ی ورود می‌آید و پشت قیمت بالا می‌رود');
  L.push(LINE);
  if (c.qty > 0) {
    L.push(`💰 حجم پیشنهادی (برای سرمایه‌ی ${num(c.base)}): ${num(c.qty)} واحد ≈ ${num(c.notional)} (${(c.notional / c.base * 100).toFixed(1)}٪ سرمایه)`);
    L.push(`⚠️ ریسک این معامله اگر حد ضرر بخورد: ≈ ${num(c.riskAmt)} (${c.riskPct}٪ سرمایه)${c.volAdapted ? ' — نماد پرنوسان است، ریسک نصف شده' : ''}`);
  }
  if (c.roundTripCostPct != null) L.push(`💸 هزینه‌ی تخمینی رفت‌وبرگشت (کارمزد + لغزش): ≈ ${c.roundTripCostPct.toFixed(2)}٪ از ارزش معامله`);
  L.push(LINE);
  const why = [];
  if (c.rsi != null) why.push(`RSI = ${c.rsi.toFixed(1)}`);
  if (c.confluenceOn && c.checks) { why.push(`MACD در حال برگشت: ${tick(c.checks.macd)}`); why.push(`حجم بالاتر از میانگین: ${tick(c.checks.volume)}`); }
  why.push(`قیمت بالای خط روند (EMA): ${tick(c.trendOk)}`);
  L.push('🔎 چرا: ' + why.join(' | '));
  if (c.trendFilter && !c.trendOk) L.push('⚠️ توجه: قیمت زیر خط روند است — در حالت آزمایشی/زنده فیلتر روند این سیگنال را رد می‌کرد؛ با احتیاط‌تر نگاهش کن.');
  L.push('ℹ️ حالت «فقط سیگنال»: هیچ سفارشی ثبت نشد. این پیشنهاد دنبال می‌شود و وقتی به حد ضرر/سود یا سیگنال فروش برسد همین‌جا خبر می‌دهم.');
  return L.join('\n');
}

function sellCard(c) {
  if (!c.pos) {
    return [head('🔴', 'سیگنال فروش / بستن', c.symbol, c.tf, c.strategyName, c.barTime), LINE,
      `📍 قیمت پیشنهادی خروج: ${num(c.price)}`,
      'ℹ️ این ربات فقط «خرید» پیشنهاد می‌دهد، پس فروش یعنی «بستن». اگر پوزیشن بازی روی این نماد داری، پیشنهاد استراتژی بستنش است. (هیچ خرید پیشنهادیِ بازی برای این نماد پیش من ثبت نیست: یا قبلاً به حد ضرر/سود رسیده، یا خرید آن را ندیده‌ام.)',
      'برای فروش استقراضی (Short) سیگنالی داده نمی‌شود.'].join('\n');
  }
  const p = c.pos, win = c.pnlPct >= 0;
  const L = [head(win ? '🔴' : '🔴', 'سیگنال فروش — بستن پوزیشن پیشنهادی', c.symbol, c.tf, c.strategyName, c.barTime), LINE];
  L.push(`📍 قیمت خروج پیشنهادی: ${num(c.price)}`);
  L.push(`↪️ ورود بود در: ${num(p.entry)}  (حد ضرر ${num(p.sl)}${p.tp != null ? ` | حد سود ${num(p.tp)}` : ''})`);
  L.push(`${win ? '🟢' : '🔴'} نتیجه: ${sgn(c.pnlPct)}٪ (${sgn(c.r)} R) ≈ ${sgn(c.pnlAmt)} روی سرمایه‌ی فرضی، بعد از کارمزد و لغزش`);
  L.push(`⏱ مدت نگه‌داری: ${dur(Date.now() - p.t)}`);
  L.push('🔎 چرا: استراتژی خودش سیگنال خروج داد (قبل از رسیدن به حد ضرر یا حد سود).');
  return L.join('\n');
}

// Stop / target / trailing / staged-exit events of the tracked suggested position.
function exitAlert(c) {
  const p = c.pos, icons = { 'stop-loss': '🛑', 'trailing stop': '🟠', 'take-profit': '🎯', partial: '⬆️' };
  const titles = { 'stop-loss': 'حد ضرر خورد', 'trailing stop': 'حد ضرر دنبال‌کننده خورد (سود/سر‌به‌سر قفل شده بود)', 'take-profit': 'به حد سود رسید', partial: 'خروج پلکانی' };
  const L = [`${icons[c.kind] || 'ℹ️'} ${titles[c.kind] || c.kind} — ${c.symbol}`, `تایم‌فریم: ${tfFa(c.tf)}`, LINE];
  if (c.kind === 'partial') {
    L.push(`📍 قیمت: ${num(c.price)}  (ورود ${num(p.entry)}، ${sgn(pctFrom(p.entry, c.price))}٪)`);
    L.push(`↗️ پیشنهاد: ${c.closePct}٪ از پوزیشن را همین‌جا ببند و سود را قطعی کن.`);
    if (c.newSl != null) L.push(`🛡 حد ضرر بقیه‌ی پوزیشن را ببر روی ${num(c.newSl)}${c.newSl >= p.entry ? ' (نقطه‌ی ورود؛ از این به بعد ریسکی برای این بخش نیست)' : ''}.`);
    return L.join('\n');
  }
  L.push(`📍 قیمت خروج: ${num(c.price)}  (ورود ${num(p.entry)})`);
  L.push(`${c.pnlPct >= 0 ? '🟢' : '🔴'} نتیجه: ${sgn(c.pnlPct)}٪ (${sgn(c.r)} R) ≈ ${sgn(c.pnlAmt)} روی سرمایه‌ی فرضی، بعد از کارمزد و لغزش`);
  L.push(`⏱ مدت نگه‌داری: ${dur(Date.now() - p.t)}`);
  L.push('اگر این پیشنهاد را اجرا کرده بودی، پوزیشن را ببند.');
  return L.join('\n');
}

module.exports = { buyCard, sellCard, exitAlert, num, tfFa, dur };
