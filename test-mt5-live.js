// Offline checks for the LIVE MetaTrader 5 feed: mt5-live.js (reads the JSON files that mt5/TvHubLive.mq5 writes), its API routes
// (mt5-live-routes.js) and the contract between the two (every field the reader needs is written by the EA; the EA never trades).
// No MetaTrader, no network: snapshot files are written here in exactly the format the EA produces. Run: node test-mt5-live.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-live-'));
process.env.MT5_LIVE_DIR = path.join(tmp, 'live');
fs.mkdirSync(process.env.MT5_LIVE_DIR, { recursive: true });
const live = require('./mt5-live');
const ms = require('./market-structure');
let passed = 0;
const ok = (c, msg) => { assert(c, msg); passed++; console.log('  ok  ' + msg); };

const OFFSET = 7200; // the broker's server clock = UTC + 2 h
const NOW = Date.UTC(2026, 0, 14, 12, 30, 0); // a January afternoon (no daylight-saving change nearby)
const nowSec = NOW / 1000;

// a market with a range and a breakout, as H1 candles in SERVER time (what the EA writes)
function hourly(n, endUtc, wp) {
  const out = []; let prev = wp[0][0]; const segs = wp.slice(1); const total = segs.reduce((s, x) => s + x[1], 0);
  const rows = []; let t0 = endUtc - total * 3600;
  for (const [target, k] of segs) for (let i = 1; i <= k; i++) { const c = prev + (target - prev) * (i / k), w = 0.25 + 0.1 * ((rows.length * 7) % 3); rows.push([prev, Math.max(prev, c) + w, Math.min(prev, c) - w, c]); prev = c; }
  rows.forEach((r, i) => out.push([t0 + i * 3600 + OFFSET, +r[0].toFixed(2), +r[1].toFixed(2), +r[2].toFixed(2), +r[3].toFixed(2), 100 + i]));
  return out.slice(-n);
}
const WP = [[2200, 0], [2300, 236], [2310, 10], [2302, 8], [2310, 8], [2302, 8], [2310.1, 8], [2302.5, 8], [2312, 6], [2310.3, 3], [2316, 5]];
const lastHourUtc = Math.floor(nowSec / 3600) * 3600;
const h1 = hourly(300, lastHourUtc, WP);
function snap(o = {}) { // = what TvHubLive.mq5 writes
  return {
    v: 1, seq: 7, symbol: 'XAUUSD', server: 'Test-Server', company: 'Test Broker Ltd.', written_gmt: nowSec - 3, server_time: nowSec + OFFSET - 3, server_utc_offset_sec: OFFSET,
    terminal_connected: true, digits: 2, point: 0.01, contract_size: 100, volume_min: 0.01, volume_step: 0.01, stops_level_points: 10, trade_mode: 4,
    tick: { time: nowSec + OFFSET - 4, bid: 2316.1, ask: 2316.4, spread_points: 30 },
    timeframes: [{ tf: 'H1', closed: h1, forming: [lastHourUtc + OFFSET, 2316, 2317, 2315.5, 2316.2, 55] }, { tf: 'D1', closed: Array.from({ length: 60 }, (_, i) => [Math.floor(lastHourUtc / 86400) * 86400 - (59 - i) * 86400 + OFFSET, 2250 + i, 2253 + i, 2248 + i, 2251 + i, 500]), forming: null }],
    positions: [{ ticket: 11, type: 'buy', volume: 0.1, open: 2305, sl: 0, tp: 2330, profit: 111.5, swap: -0.2, time: nowSec - 5000 + OFFSET }],
    account: { currency: 'USD', balance: 10000, equity: 10111.5, margin: 230, margin_free: 9881.5, leverage: 100 },
    ...o,
  };
}
const write = (name, obj) => { const f = path.join(process.env.MT5_LIVE_DIR, name); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
const bump = (f) => { const t = new Date(Date.now() + (bump.n = (bump.n || 0) + 5) * 1000); fs.utimesSync(f, t, t); }; // force "file changed" for the cache

// ---- reading ----
const f1 = write('XAUUSD.json', snap());
let r = live.read('XAUUSD', { now: NOW });
ok(r.ok && r.symbol === 'XAUUSD' && r.tvSymbol === 'OANDA:XAUUSD' && r.fresh === true && r.ageSec === 3, 'a fresh snapshot is read: symbol mapped to the TradingView name, age 3 s, fresh');
ok(r.tick.bid === 2316.1 && r.tick.ask === 2316.4 && Math.abs(r.tick.mid - 2316.25) < 1e-9 && r.tick.spreadPoints === 30, 'bid / ask / mid / spread');
const hb = r.timeframes['60'].bars;
ok(hb.length === 300 && hb[hb.length - 1].time === lastHourUtc - 3600, 'H1 candles: 300 closed ones, converted from server clock to UTC (newest = the last full hour)');
ok(hb.every((b, i) => i === 0 || b.time - hb[i - 1].time === 3600) && hb.every((b) => b.max >= Math.max(b.open, b.close) && b.min <= Math.min(b.open, b.close)), 'candles are in order, one hour apart, and sane');
ok(r.timeframes['60'].forming && r.timeframes['60'].forming.time === lastHourUtc, 'the still-forming candle is kept apart from the closed ones');
ok(Object.keys(r.timeframes).sort().join() === '60,D' && r.timeframes.D.name === 'D1', 'timeframes are keyed like TradingView (60, D) and carry the MetaTrader name');
ok(r.positions.length === 1 && r.positions[0].sl === null && r.positions[0].tp === 2330 && r.positions[0].type === 'buy', 'positions: sl 0 means "no stop" -> null');
ok(r.account.equity === 10111.5 && r.account.currency === 'USD' && !('login' in r.account) && !('name' in r.account), 'account totals only (no login number, no name)');
ok(r.clock.offsetSec === OFFSET && r.clock.dstInWindow === false, 'clock: server = UTC+2; no daylight-saving change inside this window');

// ---- freshness ----
ok(live.read('XAUUSD', { now: NOW + 120 * 1000 }).fresh === false && /قدیمی/.test(live.read('XAUUSD', { now: NOW + 120 * 1000 }).staleReason), 'two minutes later the same file is NOT fresh, and says why');
write('XAUUSD.json', snap({ terminal_connected: false })); bump(f1);
ok(live.read('XAUUSD', { now: NOW }).fresh === false && /وصل نیست/.test(live.read('XAUUSD', { now: NOW }).staleReason), 'MT5 without a broker connection -> not fresh');
write('XAUUSD.json', snap({ tick: { time: nowSec + OFFSET - 4000, bid: 2316.1, ask: 2316.4, spread_points: 30 } })); bump(f1);
ok(live.read('XAUUSD', { now: NOW }).marketQuiet === true, 'no new price for over 5 minutes -> marketQuiet (weekend / frozen feed)');
write('XAUUSD.json', snap()); bump(f1);

// ---- bad files ----
const f2 = write('BAD.json', '{"v":1,"symbol":"EURUSD","written_gmt":');
ok(live.status(NOW).files.find((x) => x.file === 'BAD.json').ok === false, 'a cut-off / broken file is reported as broken, not trusted');
ok(live.status(NOW).files.find((x) => x.file === 'XAUUSD.json').ok === true, '...and does not stop the good files from being listed');
fs.unlinkSync(f2);
write('EURUSD.json', snap({ v: 2, symbol: 'EURUSD' }));
ok(/نسخه/.test(live.read('EURUSD', { now: NOW }).reason || ''), 'an unknown file version is refused with an instruction to update the EA');
fs.unlinkSync(path.join(process.env.MT5_LIVE_DIR, 'EURUSD.json'));
const bad = snap(); bad.timeframes[0].closed = bad.timeframes[0].closed.slice(); bad.timeframes[0].closed[5] = [bad.timeframes[0].closed[5][0], 10, 5, 20, 10, 1]; bad.timeframes[0].closed[6] = ['x', 1, 1, 1, 1, 1];
write('XAUUSD.json', bad); bump(f1);
r = live.read('XAUUSD', { now: NOW });
ok(r.ok && r.dropped === 2 && r.timeframes['60'].bars.length === 298, 'impossible candles (high < low) and garbage rows are dropped and counted');
fs.writeFileSync(f1, '{"v":1,"sy'); bump(f1);
r = live.read('XAUUSD', { now: NOW });
ok(r.ok && r.warning && r.timeframes['60'].bars.length === 298, 'a file that turns unreadable never replaces the last good snapshot (it is shown with a warning)');
write('XAUUSD.json', snap({ tick: { time: 1, bid: 0, ask: 1, spread_points: 1 } })); bump(f1);
ok(live.read('XAUUSD', { now: NOW }).ok === true && live.read('XAUUSD', { now: NOW }).warning, 'a snapshot with an impossible price is refused (last good one stays)');
write('XAUUSD.json', snap()); bump(f1);
ok(!live.read('XAUUSD', { now: NOW }).warning, 'a good file after a bad one clears the warning');

// ---- finding symbols (never a path from user text) ----
write('XAUUSD_a.json', snap({ symbol: 'XAUUSD.a' }));
ok(live.read('XAUUSD.a', { now: NOW }).ok && live.read('XAUUSD_a', { now: NOW }).ok, 'a broker suffix (XAUUSD.a) is found by its MetaTrader name and by its file name');
ok(live.read('OANDA:XAUUSD', { now: NOW }).ok, 'a TradingView name finds the file of that symbol');
write('GOLD.json', snap({ symbol: 'GOLD#' }));
process.env.MT5_SYMBOL_MAP = 'GOLD#=OANDA:XAUUSD';
ok(live.status(NOW).files.find((x) => x.mt5Symbol === 'GOLD#').tvSymbol === 'OANDA:XAUUSD', 'MT5_SYMBOL_MAP maps odd broker names');
delete process.env.MT5_SYMBOL_MAP;
for (const evil of ['../secret', '..\\x', 'a/b', '', 'x'.repeat(80), 'XAUUSD;rm', 'NOPE']) {
  const x = live.read(evil, { now: NOW });
  assert(x.ok === false && x.error === 'NOT_FOUND', 'refused: ' + evil);
}
ok(true, 'path tricks, empty, over-long and unknown names are all just "not found"');
ok(live.bars('XAUUSD', 'H1', { now: NOW }).bars.length === live.bars('XAUUSD', '60', { now: NOW }).bars.length && live.bars('XAUUSD', 'H4', { now: NOW }).ok === false, 'bars(): H1 = 60, and a timeframe the EA does not publish is a clear error');

// ---- daylight saving can touch old candles ----
const wide = snap(); wide.timeframes[0].closed = Array.from({ length: 300 }, (_, i) => { const t = Date.UTC(2026, 2, 1) / 1000 + i * 4 * 3600 + OFFSET; return [t, 100, 101, 99, 100, 1]; });
write('XAUUSD.json', wide); bump(f1);
ok(live.read('XAUUSD', { now: NOW }).clock.dstInWindow === true && /ساعت/.test(live.read('XAUUSD', { now: NOW }).clock.note), 'a window that crosses the March clock change is flagged (old candles may be 1 h off in absolute time)');
write('XAUUSD.json', snap()); bump(f1);

// ---- status ----
const st = live.status(NOW);
ok(st.exists && st.files.length >= 3 && st.files.every((x) => x.file && typeof x.ok === 'boolean'), 'status(): every file listed');
process.env.MT5_LIVE_DIR = path.join(tmp, 'does-not-exist');
ok(live.status(NOW).exists === false && /TvHubLive/.test(live.status(NOW).hint), 'status(): no folder -> a hint on how to start the EA');
process.env.MT5_LIVE_DIR = path.join(tmp, 'live');

// ---- structure on live candles ----
const b = live.bars('XAUUSD', '60', { now: NOW }), an = ms.analyze(b.bars);
ok(an.ok && an.setups.some((s) => s.dir === 'up'), 'market structure runs on the live candles and sees the breakout of the 2310 zone');

// ---- the API ----
(async () => {
  write('XAUUSD.json', snap({ written_gmt: 1000, server_time: 1000 + OFFSET })); bump(f1); // written long before the real clock: the API must say fresh:false
  const express = require('express');
  const app = express(); app.use('/api/mt5/live', require('./mt5-live-routes')());
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${srv.address().port}/api/mt5/live`;
  const get = async (u) => { const x = await fetch(base + u); return { status: x.status, body: await x.json() }; };
  try {
    let g = await get('');
    ok(g.status === 200 && Array.isArray(g.body.files) && g.body.maxAgeSec === 30, 'GET /api/mt5/live -> folder status');
    g = await get('/XAUUSD');
    ok(g.status === 200 && g.body.ok && g.body.timeframes['60'].count === 300 && !g.body.timeframes['60'].bars && g.body.positions.length === 1, 'GET /:symbol -> snapshot summary without the candle arrays');
    g = await get('/XAUUSD?candles=5');
    ok(g.body.timeframes['60'].bars.length === 5, 'GET /:symbol?candles=5 -> the newest 5 candles');
    g = await get('/OANDA:XAUUSD/structure?tf=60');
    ok(g.status === 200 && g.body.analysis.ok && Array.isArray(g.body.text) && g.body.text.length >= 3 && g.body.timeframe === 'H1' && 'fresh' in g.body, 'GET /:symbol/structure -> numbers + plain Persian text + freshness');
    ok(g.body.fresh === false, 'the test files are old by the real clock: the API says fresh:false (it never hides stale data)');
    g = await get('/XAUUSD/structure?tf=240');
    ok(g.status === 422 && /تایم‌فریم/.test(g.body.error), 'a timeframe the EA does not publish -> 422 with the reason');
    g = await get('/NOPE');
    ok(g.status === 404 && g.body.code === 'NOT_FOUND', 'unknown symbol -> 404');
    g = await get('/..%2F..%2Fetc%2Fpasswd');
    ok(g.status === 404, 'path trick in the URL -> 404, nothing read');
  } finally { srv.close(); }

  // ---- the EA and the reader agree ----
  const ea = fs.readFileSync(path.join(__dirname, 'mt5', 'TvHubLive.mq5'), 'utf8');
  const keys = ['v', 'seq', 'symbol', 'server', 'company', 'written_gmt', 'server_time', 'server_utc_offset_sec', 'terminal_connected', 'digits', 'point', 'contract_size', 'volume_min', 'volume_step', 'stops_level_points', 'trade_mode', 'tick', 'time', 'bid', 'ask', 'spread_points', 'timeframes', 'tf', 'closed', 'forming', 'positions', 'ticket', 'type', 'volume', 'open', 'sl', 'tp', 'profit', 'swap', 'time', 'account', 'currency', 'balance', 'equity', 'margin', 'margin_free', 'leverage'];
  const missing = keys.filter((k) => !ea.includes(`\\"${k}\\"`));
  ok(missing.length === 0, 'every JSON field the reader uses is written by the EA' + (missing.length ? ' — MISSING: ' + missing.join(',') : ''));
  ok(!/\b(OrderSend|OrderSendAsync|CTrade|PositionClose|OrderDelete|TradeRequest|MqlTradeRequest)\b/.test(ea), 'the EA contains no trading call at all (read-only)');
  ok(/FileMove\(/.test(ea) && /\.tmp/.test(ea), 'the EA writes a temp file and renames it (the reader never sees half a file)');
  ok(!/ACCOUNT_LOGIN|ACCOUNT_NAME/.test(ea), 'the EA never reads the account login or the account holder name');
  ok(/string SafeName\(/.test(ea) && /c == '\.' \|\| c == '-'/.test(ea), 'file names are made safe the same way the reader expects (letters, digits, . and - only)');

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
