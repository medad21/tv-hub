// LIVE MetaTrader 5 data. The Expert Advisor mt5/TvHubLive.mq5 (runs inside MT5, read-only, never trades) writes one small JSON file
// per symbol into MetaTrader's shared "Common\Files\tvhub-mt5\live" folder every few seconds: price + spread, the newest candles of
// M15/H1/H4/D1, open positions and account totals. This file reads those files. It talks to nothing, writes nothing, and never mixes
// this data into the candle archive: the archive's MetaTrader data goes through mt5-import.js, which proves the broker's clock first.
//
//   const live = require('./mt5-live');
//   live.status()                          -> { dir, exists, files: [{ mt5Symbol, tvSymbol, fresh, ageSec, ... }] }
//   live.read('XAUUSD' | 'OANDA:XAUUSD')   -> { ok, fresh, ageSec, tick, timeframes: { '60': { name:'H1', bars:[...], forming } }, positions, account, clock }
//   live.bars('XAUUSD', '60')              -> closed candles (oldest -> newest) ready for market-structure.analyze()
//
// FRESHNESS IS PART OF THE ANSWER. A snapshot older than MT5_LIVE_MAX_AGE_SEC (default 30 s; the EA writes every 5 s), or one written while
// MT5 had no connection, comes back with fresh:false and a reason: whoever uses it must say "data is old" instead of analysing it.
//
// CLOCK. MetaTrader candle times are the broker server's clock. The EA also writes server-minus-UTC RIGHT NOW (server_utc_offset_sec); that
// is exact for the newest candles. If the broker's clock changed for daylight saving inside the window, the OLDER candles are one hour off
// in absolute time (their prices and order are fine): clock.dstInWindow says when that can be the case.
const fs = require('fs');
const path = require('path');
const imp = require('./mt5-import');

const MAX_FILE = 5 * 1024 * 1024;
const MAX_BARS = 2000;
const TF_BY_NAME = { M1: '1', M5: '5', M15: '15', M30: '30', H1: '60', H4: '240', D1: 'D', W1: 'W', MN1: 'M' }; // D1 -> 'D'
const STEP = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400, W1: 604800, MN1: 2592000 };

const dir = () => process.env.MT5_LIVE_DIR || path.join(imp.defaultDir(), 'live');
const maxAge = () => { const v = Number(process.env.MT5_LIVE_MAX_AGE_SEC); return Number.isFinite(v) && v >= 5 ? v : 30; };
const symbolMap = () => { try { return imp.parseMap(process.env.MT5_SYMBOL_MAP || ''); } catch { return {}; } };
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// [serverTime, o, h, l, c, tickVolume] -> candle in UTC seconds, or null if it is not a sane candle
function toBar(row, offsetSec) {
  if (!Array.isArray(row) || row.length < 5) return null;
  const [t, o, h, l, c, v] = row.map(Number);
  if (![t, o, h, l, c].every(Number.isFinite) || o <= 0 || h <= 0 || l <= 0 || c <= 0) return null;
  if (h < l || h < Math.max(o, c) || l > Math.min(o, c)) return null;
  return { time: Math.floor(t) - offsetSec, open: o, max: h, min: l, close: c, volume: Number.isFinite(v) && v >= 0 ? v : 0 };
}

function dstInWindow(oldest, newest) {
  if (!Number.isFinite(oldest) || !Number.isFinite(newest) || newest <= oldest) return false;
  for (const z of Object.values(imp.ZONES)) if (imp.zoneOffset(z, oldest) !== imp.zoneOffset(z, newest)) return true;
  return false;
}

// parse + validate the text of one snapshot file. Throws Error with a readable message.
function parse(text) {
  let j;
  try { j = JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch { throw new Error('فایل JSON معتبر نیست'); }
  if (!j || typeof j !== 'object' || j.v !== 1) throw new Error('نسخه‌ی فایل پشتیبانی نمی‌شود (باید v=1 باشد؛ اکسپرت TvHubLive.mq5 را به‌روز کن)');
  if (typeof j.symbol !== 'string' || !j.symbol || j.symbol.length > 40) throw new Error('نماد در فایل نیست');
  const offsetSec = num(j.server_utc_offset_sec);
  if (offsetSec === null || Math.abs(offsetSec) > 14 * 3600 || offsetSec % 900 !== 0) throw new Error('اختلاف ساعت سرور با UTC نامعتبر است');
  const written = num(j.written_gmt);
  if (written === null || written <= 0) throw new Error('زمان نوشتن فایل نامعتبر است');
  const tickRaw = j.tick && typeof j.tick === 'object' ? j.tick : {};
  const bid = num(tickRaw.bid), ask = num(tickRaw.ask);
  const out = {
    symbol: j.symbol, server: typeof j.server === 'string' ? j.server.slice(0, 80) : '', company: typeof j.company === 'string' ? j.company.slice(0, 80) : '',
    seq: num(j.seq), writtenAt: written, connected: j.terminal_connected !== false,
    digits: num(j.digits), point: num(j.point), contractSize: num(j.contract_size), volumeMin: num(j.volume_min), volumeStep: num(j.volume_step),
    stopsLevelPoints: num(j.stops_level_points), tradeMode: num(j.trade_mode),
    tick: { time: num(tickRaw.time) === null ? null : tickRaw.time - offsetSec, bid, ask, spreadPoints: num(tickRaw.spread_points), mid: bid !== null && ask !== null ? (bid + ask) / 2 : null },
    serverTimeUtc: num(j.server_time) === null ? null : j.server_time - offsetSec,
    timeframes: {}, dropped: 0, positions: [], account: null,
    clock: { offsetSec },
  };
  if (!(bid > 0) || !(ask > 0) || ask < bid) throw new Error('قیمت لحظه‌ای (bid/ask) نامعتبر است');
  let oldest = Infinity, newest = 0;
  for (const tf of Array.isArray(j.timeframes) ? j.timeframes : []) {
    if (!tf || typeof tf.tf !== 'string' || !TF_BY_NAME[tf.tf.toUpperCase()] || !Array.isArray(tf.closed)) continue;
    const name = tf.tf.toUpperCase(), seen = new Map();
    for (const row of tf.closed.slice(-MAX_BARS)) { const b = toBar(row, offsetSec); if (b) seen.set(b.time, b); else out.dropped++; }
    const bars = [...seen.values()].sort((a, b) => a.time - b.time);
    if (!bars.length) continue;
    const forming = toBar(tf.forming, offsetSec);
    out.timeframes[TF_BY_NAME[name]] = { name, stepSec: STEP[name], bars, forming };
    oldest = Math.min(oldest, bars[0].time); newest = Math.max(newest, bars[bars.length - 1].time);
  }
  if (!Object.keys(out.timeframes).length) throw new Error('هیچ کندل معتبری در فایل نیست (تاریخچه‌ی MT5 هنوز لود نشده؟)');
  out.clock.dstInWindow = dstInWindow(oldest, newest);
  out.clock.note = out.clock.dstInWindow
    ? 'در بازه‌ی این کندل‌ها ممکن است ساعت تابستانی/زمستانی سرور عوض شده باشد: ساعت مطلق کندل‌های قدیمی‌تر ممکن است یک ساعت اشتباه باشد (قیمت و ترتیب کندل‌ها درست است).'
    : 'ساعت کندل‌ها با اختلاف فعلی سرور و UTC تبدیل شده است.';
  for (const p of (Array.isArray(j.positions) ? j.positions : []).slice(0, 200)) {
    if (!p || (p.type !== 'buy' && p.type !== 'sell')) continue;
    out.positions.push({ ticket: num(p.ticket), type: p.type, volume: num(p.volume), open: num(p.open), sl: num(p.sl) > 0 ? p.sl : null, tp: num(p.tp) > 0 ? p.tp : null, profit: num(p.profit), swap: num(p.swap), time: num(p.time) === null ? null : p.time - offsetSec });
  }
  if (j.account && typeof j.account === 'object') {
    const a = j.account;
    out.account = { currency: typeof a.currency === 'string' ? a.currency.slice(0, 8) : '', balance: num(a.balance), equity: num(a.equity), margin: num(a.margin), marginFree: num(a.margin_free), leverage: num(a.leverage) };
  }
  return out;
}

// ---- reading with a tiny cache (a file is re-parsed only when its size/mtime changed) ----
const cache = new Map(); // full path -> { sig, snap }
function readFile(full) {
  const st = fs.statSync(full);
  if (st.size > MAX_FILE) throw new Error('فایل بیش از حد بزرگ است');
  const sig = `${st.mtimeMs}:${st.size}`, c = cache.get(full);
  if (c && c.sig === sig) return { snap: c.snap };
  try {
    const snap = parse(fs.readFileSync(full, 'utf8'));
    cache.set(full, { sig, snap });
    return { snap };
  } catch (e) {
    if (c) return { snap: c.snap, warning: `${e.message}؛ آخرین نسخه‌ی سالم نشان داده می‌شود` }; // never replace a good snapshot with a broken read
    throw e;
  }
}
const reset = () => cache.clear();

function describeFreshness(snap, now) {
  const ageSec = Math.max(0, Math.round(now / 1000 - snap.writtenAt));
  const tickAge = snap.serverTimeUtc !== null && snap.tick.time !== null ? Math.max(0, snap.serverTimeUtc - snap.tick.time) : null;
  let fresh = true, reason = null;
  if (ageSec > maxAge()) { fresh = false; reason = `داده‌ی MT5 ${ageSec} ثانیه قدیمی است (اکسپرت TvHubLive روی چارت فعال است؟ MT5 باز است؟)`; }
  else if (!snap.connected) { fresh = false; reason = 'MT5 به سرور کارگزار وصل نیست'; }
  return { fresh, reason, ageSec, marketQuiet: tickAge !== null && tickAge > 300 }; // no new price for 5+ min: closed market (weekend/holiday) or a frozen feed
}

function files() {
  const d = dir();
  let names;
  try { names = fs.readdirSync(d); } catch { return { dir: d, exists: false, names: [] }; }
  return { dir: d, exists: true, names: names.filter((n) => /^[A-Za-z0-9._-]+\.json$/.test(n)).sort() };
}

function status(now = Date.now()) {
  const f = files(), map = symbolMap(), list = [];
  for (const n of f.names) {
    const full = path.join(f.dir, n), row = { file: n };
    try {
      const { snap, warning } = readFile(full);
      const fr = describeFreshness(snap, now);
      Object.assign(row, { ok: true, mt5Symbol: snap.symbol, tvSymbol: imp.mapSymbol(snap.symbol, map), fresh: fr.fresh, ageSec: fr.ageSec, reason: fr.reason, marketQuiet: fr.marketQuiet, timeframes: Object.values(snap.timeframes).map((t) => t.name), warning: warning || null });
    } catch (e) { Object.assign(row, { ok: false, error: e.message }); }
    list.push(row);
  }
  return { dir: f.dir, exists: f.exists, maxAgeSec: maxAge(), files: list,
    hint: !f.exists ? 'پوشه‌ی live پیدا نشد: اکسپرت mt5/TvHubLive.mq5 را روی یک چارت MT5 بگذار، یا مسیر را با MT5_LIVE_DIR بده' : !list.length ? 'پوشه خالی است: اکسپرت TvHubLive روی چارت فعال نیست یا نمادی در InpSymbols ننوشته‌ای' : null };
}

// `which`: MetaTrader name ("XAUUSD", "XAUUSD.a") or TradingView name ("OANDA:XAUUSD"). Never builds a path from it: it only looks among the files that are there.
function find(which) {
  const q = String(which || '').trim().toUpperCase();
  if (!/^[A-Z0-9:._#!-]{1,40}$/.test(q)) return null;
  const f = files(), map = symbolMap();
  for (const n of f.names) {
    const full = path.join(f.dir, n);
    let snap;
    try { snap = readFile(full).snap; } catch (e) {
      if (n.toUpperCase() === `${q}.JSON`) return { full, name: n, error: e.message }; // the file you asked for by name exists but is unusable: say so, do not pretend it is missing
      continue;
    }
    if (snap.symbol.toUpperCase() === q || n.toUpperCase() === `${q}.JSON` || (q.includes(':') && imp.mapSymbol(snap.symbol, map) === q)) return { full, name: n };
  }
  return null;
}

function read(which, { now = Date.now() } = {}) {
  const hit = find(which);
  if (!hit) return { ok: false, error: 'NOT_FOUND', reason: `برای «${which}» فایل زنده‌ای پیدا نشد (نماد را همان‌طور که در InpSymbols اکسپرت نوشته‌ای بده، یا MT5_SYMBOL_MAP را تنظیم کن)` };
  if (hit.error) return { ok: false, error: 'BAD_FILE', reason: `${hit.name}: ${hit.error}` };
  try {
    const { snap, warning } = readFile(hit.full), fr = describeFreshness(snap, now);
    return { ok: true, ...snap, tvSymbol: imp.mapSymbol(snap.symbol, symbolMap()), fresh: fr.fresh, staleReason: fr.reason, ageSec: fr.ageSec, marketQuiet: fr.marketQuiet, warning: warning || null };
  } catch (e) { return { ok: false, error: 'BAD_FILE', reason: e.message }; }
}

// tf in TradingView notation ('15','60','240','D') or MetaTrader names ('M15','H1','H4','D1')
const tfKey = (tf) => { const t = String(tf).toUpperCase(); return TF_BY_NAME[t] || (['1', '5', '15', '30', '60', '240', 'D', 'W', 'M'].includes(t) ? t : null); };
function bars(which, tf, opts) {
  const r = read(which, opts), key = tfKey(tf);
  if (!r.ok) return r;
  const t = key && r.timeframes[key];
  if (!t) return { ok: false, error: 'NO_TIMEFRAME', reason: `تایم‌فریم ${tf} در فایل زنده نیست (موجود: ${Object.values(r.timeframes).map((x) => x.name).join('، ')})` };
  return { ok: true, fresh: r.fresh, staleReason: r.staleReason, ageSec: r.ageSec, marketQuiet: r.marketQuiet, symbol: r.symbol, tvSymbol: r.tvSymbol, tf: key, name: t.name, bars: t.bars, forming: t.forming, clock: r.clock };
}

module.exports = { dir, status, read, bars, find, parse, reset, tfKey, describeFreshness, TF_BY_NAME };
