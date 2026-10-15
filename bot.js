const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { EXCH, route, classify } = require('./symbols');
const { sizePosition, groupBlockReason, costsFor } = require('./risk');
const journal = require('./journal');
const card = require('./signal-card');
const { checks } = require('./strategy');
const notifier = require('./notify');
const overrides = require('./config-overrides');
const { atomicWrite } = require('./fsutil');

const alpaca = require('./broker-alpaca');
const oanda = require('./broker-oanda');

const R = cfg.risk;
const DATA = process.env.DATA_DIR || __dirname;
const STATE_FILE = process.env.STATE_FILE || path.join(DATA, 'state.json');
const LOG_FILE = process.env.EVENT_LOG || path.join(DATA, 'events.log');
const CAPITAL = cfg.mode === 'live' ? cfg.live.capitalUsdt : cfg.paper.balance;
// Live crypto: a protective stop order on the exchange itself, ON by default. Switch lives in the dashboard (stored in cfg.live.exchangeStops);
// with it OFF only the software stop works, i.e. NO stop at all if the bot / feed / internet dies. Read on every use so the switch acts at once.
const stopsOn = () => cfg.live.exchangeStops !== false;

const events = [];
const prices = {};
const busy = new Set();
const subs = [];

const today = () => new Date().toISOString().slice(0, 10);
const fresh = () => ({
  mode: cfg.mode, cash: CAPITAL, realized: 0, wins: 0, losses: 0,
  positions: {}, sigPos: {}, cooldown: {}, peak: CAPITAL, dayKey: today(), dayStart: CAPITAL,
  manualHalt: false, haltReason: '',
  lastBar: {}, // symbol -> open time of the last CLOSED candle already evaluated for signals (survives restarts)
});

let S = fresh();
let startupNote = null; // set when the saved state could not be used — shown in the startup Telegram message
let raw = null;
try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch {} // no file = first run, nothing to resume
if (raw !== null) {
  try { // resume after restart, but never mix state between modes
    const saved = JSON.parse(raw);
    if (saved.mode === cfg.mode) S = saved;
  } catch (e) {
    // The file exists but is empty/truncated/garbage. Starting "fresh" would silently forget real open positions,
    // so: keep the bad file for inspection, and refuse new entries until a human has looked and pressed Resume.
    const aside = `${STATE_FILE}.corrupt-${Date.now()}`;
    try { fs.renameSync(STATE_FILE, aside); } catch {}
    S.haltReason = 'فایل وضعیت خراب بود و کنار گذاشته شد — پوزیشن‌های باز را در صرافی/بروکر دستی چک کن، بعد «ادامه» بزن';
    startupNote = `state file unreadable (${e.message}); moved to ${path.basename(aside)}; new entries halted`;
    console.error('state:', startupNote);
  }
}
if (!S.lastBar) S.lastBar = {}; // state files written before this field existed
if (!S.sigPos) S.sigPos = {}; // signal mode: the suggested long per symbol that is being tracked (entry, stops, targets) so its exit can be reported in full
// JSON has no Infinity: an old state file may hold tp:null for a position whose fixed target was lifted by a
// partial exit. null now explicitly means "no fixed target" (see tick()), so nothing to repair here.
const save = () => {
  try { atomicWrite(STATE_FILE, JSON.stringify(S)); } catch (e) { console.error('save state:', e.message); }
};

const notify = (text) => { notifier.send(text); }; // queued + retried, see notify.js (no-op when Telegram is not configured)

function ev(symbol, side, price, note, quiet = false, extra = {}) {
  const e = { time: Date.now(), symbol, side, price, mode: cfg.mode, note, ...extra };
  events.unshift(e); events.length = Math.min(events.length, 50);
  fs.appendFile(LOG_FILE, JSON.stringify(e) + '\n', () => {}); // permanent audit trail
  subs.forEach((fn) => { try { fn(e); } catch {} });
  // a complete signal card (signal-card.js) already carries its own headline, symbol and price: send it as-is
  if (!quiet) notify(extra.card ? note : `${side === 'buy' ? '🟢' : '🔴'} ${symbol} ${side.toUpperCase()} @ ${price} [${cfg.mode}] ${note}`);
  return e;
}
const skip = (symbol, price, why) => ev(symbol, 'skip', price, `skipped: ${why}`, true);

// ---------- risk state ----------
function equity() {
  let e = S.cash;
  for (const [s, p] of Object.entries(S.positions)) e += p.qty * (prices[s] ?? p.entry);
  return e;
}

function refreshRisk() {
  const eq = equity();
  if (today() !== S.dayKey) {
    S.dayKey = today(); S.dayStart = eq;
    if (S.haltReason.startsWith('daily')) S.haltReason = '';
  }
  S.peak = Math.max(S.peak, eq);
  if (!S.haltReason.startsWith('max drawdown')) {
    const dd = (S.peak - eq) / S.peak * 100, dayLoss = (S.dayStart - eq) / S.dayStart * 100;
    if (dd >= R.maxDrawdownPct) S.haltReason = `max drawdown ${dd.toFixed(1)}%`;
    else if (dayLoss >= R.dailyLossLimitPct) S.haltReason = `daily loss ${dayLoss.toFixed(1)}%`;
  }
}

function blockReason(symbol) {
  if (S.manualHalt) return 'paused manually';
  if (S.haltReason) return `halted (${S.haltReason})`;
  if (S.positions[symbol]) return 'already holding';
  if (Object.keys(S.positions).length >= R.maxOpenPositions) return 'max open positions';
  if (Date.now() < (S.cooldown[symbol] || 0)) return 'cooldown after last trade';
  return null;
}

// ---------- live exchanges (spot, via ccxt) ----------
// TradingView prefix -> ccxt exchange id. Keys come from .env: <PREFIX>_KEY, <PREFIX>_SECRET
// (+ <PREFIX>_PASSPHRASE for OKX / KuCoin / Bitget). An exchange without keys is signal-only.
const env = (prefix, name) => process.env[`${prefix}_${name}`] || (prefix === 'BINANCE' ? process.env[`EXCHANGE_${name}`] : undefined);
const liveExchanges = () => Object.keys(EXCH).filter((k) => env(k, 'KEY') && env(k, 'SECRET')).map((k) => EXCH[k]);

function liveOk(symbol) {
  const c = classify(symbol);
  if (!c) return false;
  if (c.cls === 'stock') return alpaca.enabled();
  if (c.cls === 'forex') return oanda.enabled();
  return !!(env(c.prefix, 'KEY') && env(c.prefix, 'SECRET'));
}

const exchanges = {};
async function getEx(prefix) {
  if (!exchanges[prefix]) {
    const ccxt = require('ccxt');
    const ex = new ccxt[EXCH[prefix]]({
      apiKey: env(prefix, 'KEY'), secret: env(prefix, 'SECRET'), password: env(prefix, 'PASSPHRASE'), enableRateLimit: true,
    });
    // Throws if this exchange has no sandbox: we then refuse to trade instead of falling back to real money.
    if (process.env.EXCHANGE_TESTNET === 'YES') ex.setSandboxMode(true);
    exchanges[prefix] = ex;
  }
  await exchanges[prefix].loadMarkets();
  return exchanges[prefix];
}

async function liveOrder(symbol, side, qty, price) {
  if (process.env.LIVE_CONFIRM !== 'YES') return { error: 'blocked: set LIVE_CONFIRM=YES' };
  const r = route(symbol);
  try {
    const ex = await getEx(r.prefix);
    let amount = qty;
    if (side === 'buy') amount = Math.min(qty, cfg.live.maxOrderUsdt / price);
    else amount = Math.min(qty, (await ex.fetchBalance()).free[r.base] || 0);
    amount = Number(ex.amountToPrecision(r.pair, amount));
    if (!(amount > 0)) return { error: 'amount too small' };
    // price is passed on buys because some exchanges need it to size a market buy
    const o = await ex.createOrder(r.pair, 'market', side, amount, side === 'buy' ? price : undefined);
    return { qty: o.filled || amount, fill: o.average || o.price || price };
  } catch (e) { return { error: e.message }; }
}

// Protective stop on the exchange (cfg.live.exchangeStops). Uses ccxt's unified stopLossPrice.
async function placeStop(symbol, p) {
  const r = route(symbol), ex = await getEx(r.prefix);
  if (!ex.has.createStopLossOrder) throw new Error(`${r.id} has no unified stop-loss order in ccxt`);
  const free = (await ex.fetchBalance()).free[r.base] || 0;
  const amount = Number(ex.amountToPrecision(r.pair, Math.min(p.qty, free)));
  const stop = Number(ex.priceToPrecision(r.pair, p.sl));
  const limit = Number(ex.priceToPrecision(r.pair, p.sl * 0.995));
  const o = await ex.createOrder(r.pair, 'limit', 'sell', amount, limit, { stopLossPrice: stop });
  p.stopId = o.id; p.stopSl = p.sl;
}

// Returns {filled:true, fill, qty} if the exchange already executed our stop, else cancels it.
async function stopStatus(symbol, p) {
  if (!p.stopId) return { filled: false };
  const r = route(symbol), ex = await getEx(r.prefix);
  const o = await ex.fetchOrder(p.stopId, r.pair);
  if (o.status === 'closed') return { filled: true, fill: o.average || o.price, qty: o.filled };
  if (o.status === 'open') await ex.cancelOrder(p.stopId, r.pair);
  p.stopId = null;
  return { filled: false };
}

async function replaceStop(symbol, p) {
  if (!p.stopId || p.sl - (p.stopSl || 0) < 0.25 * p.dist) return null;
  try {
    const st = await stopStatus(symbol, p);
    if (st.filled) return null; // closePos will book it on the next tick
    await placeStop(symbol, p); save();
  } catch (e) { skip(symbol, p.sl, `exchange stop update failed: ${e.message}`); }
  return null;
}

// ---------- open / close ----------
async function open({ symbol, price, atr, trendOk }) {
  if (cfg.mode === 'live' && !liveOk(symbol)) return ev(symbol, 'buy', price, 'signal only (no live route: unsupported symbol or no API keys for this exchange)');
  const why = blockReason(symbol);
  if (why) return skip(symbol, price, why);
  if (R.trendFilter && !trendOk) return skip(symbol, price, 'price below trend EMA (or not enough data)');
  if (!atr) return skip(symbol, price, 'not enough data for ATR');

  const eq = equity();
  const { qty: rawQty, dist, riskPct, volAdapted } = sizePosition({ equity: eq, cash: S.cash, price, atrVal: atr, R: { ...R, ...costsFor(symbol, R) } });
  let qty = rawQty;
  if (qty * price < R.minNotional) return skip(symbol, price, 'position too small');

  const groupWhy = groupBlockReason(S.positions, prices, symbol, eq, qty * price, R);
  if (groupWhy) return skip(symbol, price, groupWhy);

  let fill = price * (1 + costsFor(symbol, R).slippagePct / 100);
  const sl = price - dist, tp = price + dist * R.takeProfitRR; // levels sent to the broker, pre-fill
  let brokerProtected = false;
  const c = cfg.mode === 'live' ? classify(symbol) : null;

  if (cfg.mode === 'live' && stopsOn() && c && c.cls === 'crypto') {
    // never BUY something we could not protect: check the exchange can hold a stop order before any money moves
    try {
      const ex = await getEx(route(symbol).prefix);
      if (!ex.has || !ex.has.createStopLossOrder) return skip(symbol, price, 'this exchange has no stop-loss order in ccxt, so the position could not be protected (turn off «استاپ سمت صرافی» in the dashboard to accept a software-only stop)');
    } catch (e) { return skip(symbol, price, `order failed: ${e.message}`); }
  }

  if (cfg.mode === 'live') {
    try {
      if (c.cls === 'stock') { const r = await alpaca.buy(c.ticker, qty, sl, tp); qty = r.qty; fill = r.fill; brokerProtected = true; }
      else if (c.cls === 'forex') { const r = await oanda.buy(c.instrument, qty, sl, tp); qty = r.qty; fill = r.fill; brokerProtected = true; }
      else {
        const r = await liveOrder(symbol, 'buy', qty, price);
        if (r.error) return skip(symbol, price, `order failed: ${r.error}`);
        qty = r.qty; fill = r.fill;
      }
    } catch (e) { return skip(symbol, price, `order failed: ${e.message}`); }
  }
  const spend = qty * fill * (1 + costsFor(symbol, R).feePct / 100);
  S.cash -= spend;
  // Partial exit only ever actually fires for paper/signal, or live crypto (ccxt supports selling a partial
  // amount). Stock/forex live orders in this bot are broker-side bracket/full-close orders that can't be
  // split, so tp1 is left unset there — the position just runs to the normal full target, same as before.
  const PE = R.partialExit;
  const peOk = PE && PE.enabled && (cfg.mode !== 'live' || (c && c.cls === 'crypto'));
  const tp1 = peOk ? price + dist * PE.atR : null; // same base price as sl/tp above (price, not fill) — kept consistent with them
  const p = S.positions[symbol] = { qty, entry: fill, sl, tp, dist, peak: fill, cost: spend, retryAt: 0, brokerProtected, t: Date.now(), tp1, partialDone: false };
  let note = `size ${qty.toPrecision(4)} | SL ${p.sl.toPrecision(6)} | TP ${p.tp.toPrecision(6)} | risk ${riskPct.toFixed(2)}%`;
  if (tp1) note += ` | خروج پلکانی: ${PE.closePct}% در ${tp1.toPrecision(6)}`;
  else if (PE && PE.enabled && cfg.mode === 'live') note += ' | خروج پلکانی برای این بازار پشتیبانی نمی‌شود (فقط کریپتو)';
  if (volAdapted) note += ' (reduced: high volatility)';
  if (brokerProtected) note += ' | SL/TP placed at broker';
  else if (cfg.mode === 'live' && stopsOn() && c && c.cls === 'crypto') {
    let err = null;
    for (let attempt = 0; attempt < 2 && !p.stopId; attempt++) {
      try { await placeStop(symbol, p); } catch (e) { err = e; }
    }
    if (p.stopId) note += ' | exchange stop placed';
    else { p.unprotected = true; note += ` | EXCHANGE STOP FAILED (${err ? err.message : 'unknown'}) after 2 tries -> closing the position now`; }
  }
  save();
  const buyEv = ev(symbol, 'buy', fill, note);
  if (p.unprotected) { // bought but could not be protected: do not sit on a position with no stop — sell it right away (tick() retries if this sell fails)
    const out = await closePos(symbol, fill, 'closed: no protective stop could be placed');
    return out || buyEv;
  }
  return buyEv;
}

async function closePos(symbol, price, reason) {
  const p = S.positions[symbol];
  if (!p || Date.now() < p.retryAt) return null;
  let fill = price * (1 - costsFor(symbol, R).slippagePct / 100), qty = p.qty, byStop = false;
  const c = cfg.mode === 'live' ? classify(symbol) : null;

  if (cfg.mode === 'live' && (c.cls === 'stock' || c.cls === 'forex')) {
    try {
      const r = c.cls === 'stock' ? await alpaca.closeAll(c.ticker) : await oanda.closeLong(c.instrument);
      if (r.closedByBroker) { byStop = true; reason = 'closed by broker SL/TP'; } // fill/qty stay at our own estimate
      else { qty = r.qty; fill = r.fill; }
    } catch (e) { p.retryAt = Date.now() + 30000; save(); return ev(symbol, 'sell', price, `SELL FAILED (${reason}): ${e.message}`); }
  } else if (cfg.mode === 'live') {
    try {
      if (p.stopId) {
        const st = await stopStatus(symbol, p);
        if (st.filled) { fill = st.fill; qty = st.qty; byStop = true; reason = 'exchange stop filled'; }
      }
    } catch (e) { p.retryAt = Date.now() + 30000; save(); return ev(symbol, 'sell', price, `STOP CHECK FAILED (${reason}): ${e.message}`); }
    if (!byStop) {
      const r = await liveOrder(symbol, 'sell', p.qty, price);
      if (r.error) { p.retryAt = Date.now() + 30000; save(); return ev(symbol, 'sell', price, `SELL FAILED (${reason}): ${r.error}`); }
      qty = r.qty; fill = r.fill;
    }
  }
  const proceeds = qty * fill * (1 - costsFor(symbol, R).feePct / 100);
  const pnl = proceeds - p.cost;
  S.cash += proceeds; S.realized += pnl;
  if (pnl >= 0) S.wins++; else S.losses++;
  journal.record({ time: Date.now(), entryTime: p.t || null, symbol, mode: cfg.mode, entry: p.entry, exit: fill, qty, pnl, pct: pnl / p.cost * 100, reason });
  delete S.positions[symbol];
  S.cooldown[symbol] = Date.now() + R.cooldownMin * 60000;
  refreshRisk(); save();
  return ev(symbol, 'sell', fill, `${reason} | PnL ${pnl.toFixed(2)} (${(pnl / p.cost * 100).toFixed(1)}%)`, false, { pnl, pnlPct: (pnl / p.cost) * 100 });
}

// Books part of the position at the nearer milestone (p.tp1), keeps the rest open. Never deletes the
// position itself (closePos handles that); if the configured % would leave a dust-sized remainder, it
// closes the whole thing instead, through the normal closePos path, so nothing is left half-tracked.
async function partialClose(symbol, price) {
  const p = S.positions[symbol];
  if (!p || p.partialDone || !p.tp1 || Date.now() < p.retryAt) return null;
  const pct = R.partialExit.closePct / 100;
  if (pct >= 0.995) return closePos(symbol, price, 'take-profit (partial = 100%)');
  if (pct <= 0) { p.partialDone = true; save(); return null; }

  let qty = p.qty * pct, fill = price * (1 - costsFor(symbol, R).slippagePct / 100);
  if (cfg.mode === 'live') { // only reached for crypto — see the peOk check in open()
    const r = await liveOrder(symbol, 'sell', qty, price);
    if (r.error) return skip(symbol, price, `partial exit failed: ${r.error}`);
    qty = r.qty; fill = r.fill;
  }
  const proceeds = qty * fill * (1 - costsFor(symbol, R).feePct / 100);
  const costPortion = p.cost * pct;
  const pnl = proceeds - costPortion;
  S.cash += proceeds; S.realized += pnl;
  if (pnl >= 0) S.wins++; else S.losses++;
  journal.record({ time: Date.now(), entryTime: p.t || null, symbol, mode: cfg.mode, entry: p.entry, exit: fill, qty, pnl, pct: pnl / costPortion * 100, reason: 'partial take-profit' });

  p.qty -= qty; p.cost -= costPortion; p.partialDone = true;
  if (R.partialExit.moveStopToBreakeven) p.sl = Math.max(p.sl, p.entry);
  if (R.trailing) p.tp = null; // remainder is no longer capped by the original fixed target; it rides the trailing stop instead (null, not Infinity: Infinity is lost in state.json)
  if (p.qty < 1e-8) { delete S.positions[symbol]; S.cooldown[symbol] = Date.now() + R.cooldownMin * 60000; }
  refreshRisk(); save();
  return ev(symbol, 'sell', fill, `partial take-profit ${R.partialExit.closePct}% | PnL ${pnl.toFixed(2)} (${(pnl / costPortion * 100).toFixed(1)}%) | remaining ${p.qty.toPrecision(4)}`, false, { pnl, pnlPct: (pnl / costPortion) * 100 });
}

// Books a position as closed WITHOUT sending any order — for a position that the exchange/broker no longer has (sold by hand,
// stopped out while we were offline...). The result is an ESTIMATE at the current price, labelled as such in the journal.
async function forgetPosition(symbol, price, reason) {
  const p = S.positions[symbol];
  if (!p) return null;
  const C = costsFor(symbol, R), fill = price * (1 - C.slippagePct / 100), proceeds = p.qty * fill * (1 - C.feePct / 100), pnl = proceeds - p.cost;
  S.cash += proceeds; S.realized += pnl;
  if (pnl >= 0) S.wins++; else S.losses++;
  journal.record({ time: Date.now(), entryTime: p.t || null, symbol, mode: cfg.mode, entry: p.entry, exit: fill, qty: p.qty, pnl, pct: pnl / p.cost * 100, reason: `${reason} (ESTIMATE, not a real fill)` });
  delete S.positions[symbol];
  S.cooldown[symbol] = Date.now() + R.cooldownMin * 60000;
  refreshRisk(); save();
  return ev(symbol, 'sell', fill, `${reason} | PnL ${pnl.toFixed(2)} (${(pnl / p.cost * 100).toFixed(1)}%) — تخمینی، با صرافی/بروکر چک کن`, false, { pnl, pnlPct: (pnl / p.cost) * 100 });
}

// Dashboard switch «استاپ سمت صرافی». Acts at once and is remembered across restarts. Stops already on the exchange are left alone:
// switching OFF stops managing/trailing them (they are still cancelled when the position closes); switching ON places stops for
// positions that have none at the next startup check (new buys get one immediately).
function setExchangeStops(enabled) {
  overrides.setLive({ exchangeStops: !!enabled });
  const open = Object.keys(S.positions).length;
  console.log(`exchange stops ${enabled ? 'ON' : 'OFF'} (set from the dashboard), ${open} open position(s)`);
  notify(enabled ? '🛡️ استاپ سمت صرافی روشن شد.' : '⚠️ استاپ سمت صرافی خاموش شد: از این به بعد فقط استاپ نرم‌افزاری داخل برنامه کار می‌کند؛ اگر برنامه/سرور/اینترنت قطع شود پوزیشن‌های جدید هیچ استاپی ندارند.');
  return { enabled: cfg.live.exchangeStops !== false, openPositions: open };
}

// Startup check (live only): does what state.json says we hold really exist where the orders were placed?
//  - crypto: the exchange balance must cover the tracked amount (2% tolerance for fees taken in the coin), and the stop order we
//    placed must still be working (if it was filled while we were offline it is booked; if it vanished a new one is placed)
//  - stocks / forex: the broker's open positions must contain it
// A position with nothing behind it is booked once a price arrives (see tick); every problem halts NEW entries until a human has looked
// and pressed Resume. If the check itself cannot run, new entries are halted too (exits keep working). It cannot see holdings the bot
// never tracked, and it does not compare cash balances.
async function reconcile() {
  if (cfg.mode !== 'live') return { skipped: true, issues: [] };
  const issues = [], entries = Object.entries(S.positions);
  if (!entries.length) return { checked: 0, issues };
  let alp = null, oan = null; const bal = {};
  try {
    for (const [symbol, p] of entries) {
      const c = classify(symbol);
      if (!c) continue;
      let have;
      if (c.cls === 'stock') { alp = alp || await alpaca.positions(); have = alp[c.ticker] || 0; }
      else if (c.cls === 'forex') { oan = oan || await oanda.positions(); have = oan[c.instrument] || 0; }
      else { const r = route(symbol), ex = await getEx(r.prefix); bal[r.prefix] = bal[r.prefix] || (await ex.fetchBalance()).total || {}; have = bal[r.prefix][r.base] || 0; }
      if (have < p.qty * 0.98) {
        p.orphan = 'position not found at the exchange/broker (sold by hand or closed by its own stop/target while offline)';
        issues.push(`${symbol}: state says ${Number(p.qty).toPrecision(4)}, exchange/broker has ${Number(have).toPrecision(4)}`);
        continue;
      }
      if (c.cls === 'crypto' && stopsOn()) {
        const r = route(symbol), ex = await getEx(r.prefix);
        let status = null;
        if (p.stopId) { try { status = (await ex.fetchOrder(p.stopId, r.pair)).status; } catch { status = 'unknown'; } }
        if (status === 'closed') { await guard(symbol, () => closePos(symbol, p.sl, 'exchange stop filled (while offline)')); issues.push(`${symbol}: its exchange stop was filled while offline (booked)`); }
        else if (status !== 'open') { // never placed, cancelled, expired, or unreadable: put a fresh one
          p.stopId = null;
          try { await placeStop(symbol, p); issues.push(`${symbol}: the exchange stop was missing and has been placed again`); }
          catch (e) { p.unprotected = true; issues.push(`${symbol}: NO exchange stop and placing one failed (${e.message}) — it will be closed`); }
        }
      }
    }
  } catch (e) {
    issues.push(`could not verify against the exchange/broker: ${e.message}`);
  }
  if (issues.length) {
    if (!S.haltReason) S.haltReason = `reconcile: ${issues.length} problem(s) at startup — check, then press Resume`;
    notify(`⚠️ بررسی اول اجرا با صرافی/بروکر:\n${issues.join('\n')}\nورود جدید متوقف شد تا خودت چک کنی و «ادامه» بزنی.`);
  }
  save();
  return { checked: entries.length, issues };
}

const guard = async (symbol, fn) => {
  if (busy.has(symbol)) return null;
  busy.add(symbol);
  try { return await fn(); } finally { busy.delete(symbol); }
};

// ---------- public API ----------
function tick({ symbol, price }) {
  prices[symbol] = price;
  if (cfg.mode === 'signal') return signalTick(symbol, price); // no real position: follow the suggested one and report its stop / target
  const p = S.positions[symbol];
  refreshRisk();
  if (!p) return Promise.resolve(null);
  if (p.orphan) return guard(symbol, () => forgetPosition(symbol, price, p.orphan)); // startup check found nothing at the exchange/broker behind this position
  if (p.unprotected && Date.now() >= p.retryAt) return guard(symbol, () => closePos(symbol, price, 'closed: no protective stop could be placed')); // an earlier emergency sell failed: keep trying
  p.peak = Math.max(p.peak, price);
  if (R.trailing && p.peak - p.entry >= p.dist) {
    const ns = Math.max(p.entry, p.peak - p.dist);
    if (ns > p.sl) { p.sl = ns; save(); }
  }
  if (price <= p.sl) return guard(symbol, () => closePos(symbol, price, p.sl >= p.entry ? 'trailing stop' : 'stop-loss'));
  if (p.tp1 && !p.partialDone && price >= p.tp1) return guard(symbol, () => partialClose(symbol, price));
  if (p.tp != null && price >= p.tp) return guard(symbol, () => closePos(symbol, price, 'take-profit')); // tp null = no fixed target (trailing only)
  // still open: keep the exchange-side stop in step with the trailing stop (crypto + exchange stops ON only;
  // never while exiting). Stock/forex broker-side SL/TP is placed once at entry and does not trail.
  if (cfg.mode === 'live' && stopsOn() && !p.brokerProtected) guard(symbol, () => replaceStop(symbol, p));
  return Promise.resolve(null);
}

// side is already the confluence-filtered decision (see confluence() in server.js) — bot.js itself stays
// unaware of which indicators produced it; strategyName is passed through purely for the note text below,
// so "signal" mode can say WHICH strategy fired and WHAT it suggests, not just "buy" or "sell".
function signal({ symbol, side, price, atr, trendOk, strategyName, info = {} }) {
  return guard(symbol, async () => {
    const who = strategyName ? ` (${strategyName})` : '';
    if (cfg.mode === 'signal') return signalModeCard({ symbol, side, price, atr, trendOk, strategyName, info });
    if (side === 'buy') return open({ symbol, price, atr, trendOk });
    return S.positions[symbol] ? closePos(symbol, price, `سیگنال فروش${who}`) : null;
  });
}

// ---------- signal mode: complete cards + a tracked "suggested position" ----------
// No order is ever placed here. But a buy signal still gets a full plan (entry, stop, target, size, why), and the
// suggested position is remembered so its exit — by stop, target, or the strategy's own sell — is reported with the
// entry, the result in % and R, and the time held. Without this, a sell was just "sell at some price".
const sigPnl = (symbol, vp, exitPrice) => {
  const C = costsFor(symbol, R);
  const fill = exitPrice * (1 - C.slippagePct / 100), cost = vp.qty * vp.entry * (1 + C.feePct / 100);
  const pnl = vp.qty * fill * (1 - C.feePct / 100) - cost;
  return { pnl, pnlPct: cost ? pnl / cost * 100 : 0, r: vp.risk ? pnl / vp.risk : 0 };
};
function sigClose(symbol, vp, price, reason) {
  const out = sigPnl(symbol, vp, price);
  const C = costsFor(symbol, R);
  journal.record({ time: Date.now(), entryTime: vp.t, symbol, mode: 'signal', entry: vp.entry, exit: price * (1 - C.slippagePct / 100), qty: vp.qty, pnl: out.pnl, pct: out.pnlPct, reason });
  delete S.sigPos[symbol]; save();
  return out;
}

function signalModeCard({ symbol, side, price, atr, trendOk, strategyName, info }) {
  const tf = info.timeframe || cfg.timeframe, vp = S.sigPos[symbol];
  if (side === 'sell') {
    const common = { symbol, tf, strategyName, price, barTime: info.barTime };
    if (!vp) return ev(symbol, 'sell', price, card.sellCard({ ...common, pos: null }), false, { card: true });
    const out = sigClose(symbol, vp, price, `سیگنال فروش${strategyName ? ` (${strategyName})` : ''}`);
    return ev(symbol, 'sell', price, card.sellCard({ ...common, pos: vp, pnlPct: out.pnlPct, r: out.r, pnlAmt: out.pnl }), false, { card: true, pnl: out.pnl, pnlPct: out.pnlPct });
  }
  if (vp) return skip(symbol, price, 'یک خرید پیشنهادی برای این نماد از قبل باز است (هنوز به حد ضرر/سود/سیگنال فروش نرسیده)');
  if (!atr) return ev(symbol, 'buy', price, `🟢 سیگنال خرید — ${symbol}${strategyName ? ` (${strategyName})` : ''} @ ${card.num(price)}\nداده‌ی کافی برای محاسبه‌ی ATR نیست، پس حد ضرر / حد سود / حجم قابل محاسبه نیست.`, false, { card: true });
  const C = costsFor(symbol, R), Rc = { ...R, ...C };
  const { qty, dist, riskPct, volAdapted } = sizePosition({ equity: CAPITAL, cash: CAPITAL, price, atrVal: atr, R: Rc });
  const sl = price - dist, tp = price + dist * R.takeProfitRR, riskAmt = qty * dist;
  const PE = R.partialExit, tp1 = PE && PE.enabled ? price + dist * PE.atR : null;
  const ck = info.extra ? checks('buy', info.extra, cfg.confluence.volumeMult) : { macd: null, volume: null };
  S.sigPos[symbol] = { entry: price, sl, tp, dist, peak: price, qty, risk: riskAmt, t: Date.now(), tp1, partialDone: false, tf, strategyName };
  save();
  const text = card.buyCard({
    symbol, tf, strategyName, price, sl, tp, rr: R.takeProfitRR, atrMult: R.atrMult, trailing: !!R.trailing,
    partial: tp1 ? { closePct: PE.closePct, price: tp1 } : null,
    qty, notional: qty * price, riskPct, riskAmt, base: CAPITAL, volAdapted,
    roundTripCostPct: 2 * (C.feePct + C.slippagePct), trendOk, trendFilter: R.trendFilter,
    rsi: info.rsi, checks: ck, confluenceOn: !!cfg.confluence.enabled, barTime: info.barTime,
  });
  return ev(symbol, 'buy', price, text, false, { card: true });
}

// Called on every price update in signal mode: reports stop / target / trailing / staged-exit events of the suggested position.
function signalTick(symbol, price) {
  const vp = S.sigPos[symbol];
  if (!vp) return Promise.resolve(null);
  vp.peak = Math.max(vp.peak, price);
  const tf = vp.tf || cfg.timeframe;
  const finish = (kind) => {
    const pos = { ...vp }, out = sigClose(symbol, vp, price, kind);
    return ev(symbol, 'sell', price, card.exitAlert({ symbol, tf, kind, price, pos, pnlPct: out.pnlPct, r: out.r, pnlAmt: out.pnl }), false, { card: true, pnl: out.pnl, pnlPct: out.pnlPct });
  };
  if (R.trailing && vp.peak - vp.entry >= vp.dist) { const ns = Math.max(vp.entry, vp.peak - vp.dist); if (ns > vp.sl) { vp.sl = ns; save(); } }
  if (price <= vp.sl) return Promise.resolve(finish(vp.sl >= vp.entry ? 'trailing stop' : 'stop-loss'));
  if (vp.tp1 && !vp.partialDone && price >= vp.tp1) {
    vp.partialDone = true;
    if (R.partialExit.moveStopToBreakeven) vp.sl = Math.max(vp.sl, vp.entry);
    if (R.trailing) vp.tp = null; // like the real bot: after the staged exit the rest rides the trailing stop
    save();
    return Promise.resolve(ev(symbol, 'info', price, card.exitAlert({ symbol, tf, kind: 'partial', price, pos: vp, closePct: R.partialExit.closePct, newSl: vp.sl }), false, { card: true }));
  }
  if (vp.tp != null && price >= vp.tp) return Promise.resolve(finish('take-profit'));
  return Promise.resolve(null);
}

function portfolio() {
  refreshRisk();
  const eq = equity();
  return {
    mode: cfg.mode, equity: eq, cash: S.cash, realized: S.realized, wins: S.wins, losses: S.losses,
    drawdownPct: (S.peak - eq) / S.peak * 100, dayPnlPct: (eq - S.dayStart) / S.dayStart * 100,
    halted: !!(S.manualHalt || S.haltReason), manualHalt: S.manualHalt,
    haltReason: S.manualHalt ? 'paused manually' : S.haltReason,
    positions: Object.entries(S.positions).map(([symbol, p]) => ({
      symbol, qty: p.qty, entry: p.entry, sl: p.sl, tp: p.tp,
      tp1: p.partialDone ? null : (p.tp1 || null), // null once fired (or never applicable) so the dashboard only shows an upcoming milestone
      partialDone: !!p.partialDone,
      pnlPct: ((prices[symbol] ?? p.entry) / p.entry - 1) * 100,
    })),
  };
}

function setHalt(on) {
  if (on) S.manualHalt = true;
  else { S.manualHalt = false; S.haltReason = ''; S.peak = equity(); S.dayStart = equity(); }
  save();
}
const toggleHalt = () => setHalt(!(S.manualHalt || S.haltReason));

// Panic button: close every open position now.
async function closeAll(reason = 'manual close') {
  const out = [];
  for (const symbol of Object.keys(S.positions)) {
    S.positions[symbol].retryAt = 0;
    const e = await guard(symbol, () => closePos(symbol, prices[symbol] ?? S.positions[symbol].entry, reason));
    if (e) out.push(e);
  }
  return out;
}

// Close one position by hand (Telegram /close). null = nothing to close, or an order for it is already in flight.
async function closeOne(symbol, reason = 'manual close') {
  const p = S.positions[symbol];
  if (!p) return null;
  p.retryAt = 0;
  return guard(symbol, () => closePos(symbol, prices[symbol] ?? p.entry, reason));
}

// UTC day (YYYY-MM-DD) the daily Telegram summary was last sent — kept in state.json so a restart does not repeat it.
const getSummaryDay = () => S.summaryDay;
const setSummaryDay = (d) => { S.summaryDay = d; save(); };

// Last closed candle already evaluated for `symbol` (undefined = never seen). Persisted in state.json so a
// restart neither re-fires a signal from the same candle nor silently skips a fresh one.
// After the timeframe changes the old candle times mean nothing: forget them, so the first candle seen on the new timeframe is treated
// as a cold start (an old transition from history never triggers a trade).
const resetLastBars = () => { S.lastBar = {}; save(); };
const getLastBar = (symbol) => S.lastBar[symbol];
const setLastBar = (symbol, t) => { if (S.lastBar[symbol] !== t) { S.lastBar[symbol] = t; save(); } };

module.exports = {
  setExchangeStops, reconcile, resetLastBars, getLastBar, setLastBar, closeOne, getSummaryDay, setSummaryDay, startupNote: () => startupNote,
  tick, signal, portfolio, toggleHalt, setHalt, closeAll, route, classify, liveExchanges,
  subscribe: (fn) => subs.push(fn), history: () => events,
  logSkip: skip, // quiet audit-log entry for signals the bot chose not to act on (e.g. confluence filter)
};
