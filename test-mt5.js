// Offline checks for the MetaTrader import (mt5-import.js) and the data-source switch of the backtester. No MetaTrader, no network:
// a synthetic market (closed on weekends exactly like forex/gold: Sunday 17:00 -> Friday 17:00 New York time) is written as the CSV files
// TvHubExport.mq5 makes, with the broker's clock set to each of the models brokers really use. Checked: the clock is found (and found
// RIGHT, candle by candle, across both daylight-saving changes), the import refuses when it cannot be sure, MetaTrader data goes to a
// separate archive and never touches the TradingView one, daily candles reuse the intraday clock, and backtests can read it.
// Run: node test-mt5.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-mt5-'));
process.env.CANDLE_DIR = path.join(tmp, 'candles');
const m = require('./mt5-import');
const store = require('./candle-store');
let passed = 0;
const ok = (c, msg) => { assert(c, msg); passed++; console.log('  ok  ' + msg); };

// ---- synthetic market ----
const NY = 'America/New_York', ATH = 'Europe/Athens';
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function isOpen(u) { const d = new Date((u + m.zoneOffset(NY, u)) * 1000), day = d.getUTCDay(), hr = d.getUTCHours(); return day === 6 ? false : day === 0 ? hr >= 17 : day === 5 ? hr < 17 : true; }
function truth(fromIso, toIso, seed, flat) { // true UTC candles
  const r = rng(seed), out = []; let p = 2000;
  for (let u = Date.parse(fromIso) / 1000; u < Date.parse(toIso) / 1000; u += 900) {
    if (!isOpen(u)) continue;
    const o = p, c = flat ? p : p * (1 + (r() - 0.5) * 0.0028);
    out.push({ time: u, open: o, max: Math.max(o, c) * (1 + r() * (flat ? 0 : 0.0003)), min: Math.min(o, c) * (1 - r() * (flat ? 0 : 0.0003)), close: c, volume: 100 + Math.floor(r() * 100) });
    p = c;
  }
  return out;
}
const SERVER = { 'ny:7': (u) => u + m.zoneOffset(NY, u) + 7 * 3600, 'fixed:3': (u) => u + 3 * 3600, 'eu:0': (u) => u + m.zoneOffset(ATH, u) };
function csv({ symbol = 'EURUSD', tf = 'M15', clock, bars, seed = 7, crlf = false, server = 'Test-Server' }) { // what the broker's terminal would export (server clock, a little feed noise)
  const r = rng(seed), L = ['#tvhub-mt5,1', `#server,${server}`, '#company,Test Broker Ltd.', `#symbol,${symbol}`, `#tf,${tf}`, 'time,open,high,low,close,tick_volume,spread'];
  for (const b of bars) { const k = 1 + (r() - 0.5) * 0.0001; L.push([SERVER[clock](b.time), (b.open * k).toFixed(2), (b.max * k).toFixed(2), (b.min * k).toFixed(2), (b.close * k).toFixed(2), b.volume, 20].join(',')); }
  return L.join(crlf ? '\r\n' : '\n') + '\n';
}
let n = 0;
function scenario() { // a fresh archive + export folder
  n++; process.env.CANDLE_DIR = path.join(tmp, `candles${n}`); store._reset();
  const dir = path.join(tmp, `export${n}`); fs.mkdirSync(dir, { recursive: true }); return dir;
}
const put = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);
const seedTv = (bars, sym = 'OANDA:EURUSD', tf = '15') => store.backfill(sym, tf, bars.map((b, i) => { const k = 1 + (((i * 7919) % 100) / 100 - 0.5) * 0.0001; return { ...b, open: b.open * k, max: b.max * k, min: b.min * k, close: b.close * k }; }));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const YEAR = truth('2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 11); // spans both daylight-saving changes of 2025 (US and Europe)
const LAST = YEAR.filter((b) => b.time >= Date.parse('2025-02-20T00:00:00Z') / 1000 && b.time < Date.parse('2025-04-20T00:00:00Z') / 1000); // TradingView candles that SPAN the March daylight-saving gap: the direct proof of the clock

// ---- 1) csv + helpers ----
{
  const p = m.parseCsv('\uFEFF#tvhub-mt5,1\r\n#symbol,EURUSD.a\r\n#company,A, B & Co\r\ntime,open,high,low,close,tick_volume,spread\r\n1700000000,2000.1,2001,1999,2000.5,10,20\r\n1700000900,2000.5,2002,2000,2001,11,20\r\n1700000900,2000.6,2003,2000,2002,12,20\r\nbroken line\r\n1700001800,2000,1990,2010,2000,1,1\r\n1700002700,0,0,0,0,0,0\r\n1700003600,2001,2002,2000,2001.5,5,20\r\n');
  ok(p.meta.symbol === 'EURUSD.a' && p.meta.company === 'A, B & Co', 'csv: header lines are read (a comma inside a value is kept), BOM and Windows line ends are fine');
  ok(p.bars.length === 3 && p.dropped === 2, 'csv: titles and garbage are skipped, impossible candles (high<low, zero price) are counted and dropped');
  ok(p.bars.length === 3 && p.bars[1].close === 2002, 'csv: a time that appears twice keeps one candle (the later line)');
  ok(m.mapSymbol('XAUUSD') === 'OANDA:XAUUSD' && m.mapSymbol('EURUSD') === 'OANDA:EURUSD' && m.mapSymbol('xauusd.a') === 'OANDA:XAUUSD' && m.mapSymbol('GOLD') === 'OANDA:XAUUSD' && m.mapSymbol('GBPJPYm') === 'OANDA:GBPJPY', 'symbols: gold/forex names, lower case, broker suffixes (.a, m) and GOLD are mapped to TradingView names');
  ok(m.mapSymbol('USDCNH') === 'OANDA:USDCNH' && m.mapSymbol('USDTRY.a') === 'OANDA:USDTRY' && m.mapSymbol('XAUEUR') === 'OANDA:XAUEUR', 'symbols: more forex/metal names (USDCNH, USDTRY, XAUEUR) are recognised');
  ok(m.mapSymbol('BTCUSD') === null && m.mapSymbol('US30') === null, 'symbols: crypto and indices are NOT guessed (the user must say with --map)');
  ok(m.mapSymbol('BTCUSD', m.parseMap('btcusd=binance:btcusdt, GOLD#=OANDA:XAUUSD')) === 'BINANCE:BTCUSDT' && m.mapSymbol('GOLD#', m.parseMap('GOLD#=OANDA:XAUUSD')) === 'OANDA:XAUUSD', 'symbols: --map overrides');
  let e = null; try { m.parseOffset('plus3'); } catch (x) { e = x; } ok(e && /--offset/.test(e.message), 'offset: a bad --offset is refused with an example');
}

// ---- 2) the clock models are real calendars ----
{
  const h = m.makeHyp('ny', 7), at = (iso) => Date.parse(iso) / 1000;
  ok(h.offsetAt(at('2025-01-15T12:00:00Z')) === 2 * 3600 && h.offsetAt(at('2025-07-15T12:00:00Z')) === 3 * 3600, 'clock: "New York + 7h" is UTC+2 in winter and UTC+3 in summer');
  ok(h.offsetAt(at('2025-03-15T12:00:00Z')) === 3 * 3600 && m.makeHyp('eu', 0).offsetAt(at('2025-03-15T12:00:00Z')) === 2 * 3600, 'clock: US and European daylight saving really differ in mid-March (the case the import has to tell apart)');
  ok(m.makeHyp('fixed', 3).offsetAt(at('2025-01-15T12:00:00Z')) === 3 * 3600, 'clock: a fixed model never moves');
}

(async () => {
  // ---- 3) every clock model is found, and found RIGHT for the whole history ----
  for (const clock of ['ny:7', 'fixed:3', 'eu:0']) {
    const dir = scenario();
    seedTv(LAST);
    put(dir, 'EURUSD_M15.csv', csv({ clock, bars: YEAR }));
    const [r] = m.importAll({ dir });
    ok(r.status === 'stored' && r.hyp.id === clock, `clock ${clock}: found from TradingView candles that span a clock change (got ${r.hyp ? r.hyp.id : r.reason})`);
    const got = store.read('MT5:OANDA:EURUSD', '15');
    ok(got.length === YEAR.length && got.every((b, i) => b.time === YEAR[i].time), `clock ${clock}: all ${got.length} candles sit on their true UTC time (both daylight-saving changes included)`);
    ok(r.evidence.medianPct < 0.02 && /ناهم‌خوان/.test(r.note), `clock ${clock}: proven by the candles it leaves misplaced (${r.note})`);
  }

  // ---- 4) MetaTrader data is a separate archive ----
  {
    const dir = scenario();
    seedTv(LAST);
    const tvFile = path.join(process.env.CANDLE_DIR, 'OANDA_EURUSD_15.jsonl'), before = sha(tvFile);
    put(dir, 'EURUSD_M15.csv', csv({ clock: 'ny:7', bars: YEAR }));
    const dry = m.importAll({ dir, dry: true })[0];
    ok(dry.status === 'dry' && !fs.existsSync(path.join(process.env.CANDLE_DIR, 'MT5_OANDA_EURUSD_15.jsonl')), 'dry run: checks everything, stores nothing');
    const r = m.importAll({ dir })[0];
    ok(r.status === 'stored' && sha(tvFile) === before, 'the TradingView archive file is byte-for-byte unchanged by the import');
    ok(fs.existsSync(path.join(process.env.CANDLE_DIR, 'MT5_OANDA_EURUSD_15.jsonl')) && store.read('OANDA:EURUSD', '15').length === LAST.length, 'MetaTrader candles live in their own file (MT5_...), TradingView ones are still only the overlap');
    const again = m.importAll({ dir })[0];
    ok(again.status === 'stored' && store.read('MT5:OANDA:EURUSD', '15').length === YEAR.length, 'running the import twice gives the same archive');
    put(dir, 'EURUSD_M15.csv', csv({ clock: 'ny:7', bars: YEAR.slice(-21000) }));
    m.importAll({ dir });
    ok(store.read('MT5:OANDA:EURUSD', '15').length === 21000, 'a new, shorter export REPLACES the archive (the export is the single source of truth)');
    const meta = JSON.parse(fs.readFileSync(path.join(process.env.CANDLE_DIR, 'mt5-import.json'), 'utf8'))['MT5:OANDA:EURUSD|15'];
    ok(meta && meta.clock === 'ny:7' && meta.server === 'Test-Server', 'the broker server name and the clock model used are recorded');
  }

  // ---- 5) it refuses when it cannot be sure ----
  {
    let dir = scenario(); // no TradingView overlap at all
    put(dir, 'EURUSD_M15.csv', csv({ clock: 'ny:7', bars: YEAR }));
    let r = m.importAll({ dir })[0];
    ok(r.status === 'refused' && /--offset/.test(r.reason) && !store.read('MT5:OANDA:EURUSD', '15').length, 'no TradingView candles to compare with: refused, nothing stored, and it says how to go on');
    r = m.importAll({ dir, offset: 'ny:7' })[0];
    ok(r.status === 'stored' && store.read('MT5:OANDA:EURUSD', '15').length === YEAR.length, 'the same files with --offset ny:7 are accepted');

    dir = scenario(); // TradingView archive of an unrelated price series
    seedTv(truth('2025-11-20T00:00:00Z', '2025-12-31T00:00:00Z', 999));
    put(dir, 'EURUSD_M15.csv', csv({ clock: 'ny:7', bars: YEAR }));
    r = m.importAll({ dir })[0];
    ok(r.status === 'refused' && !store.read('MT5:OANDA:EURUSD', '15').length, 'prices that do not match the TradingView candles at any clock: refused');

    dir = scenario(); // a market so quiet that no clock stands out
    const flat = truth('2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 5, true);
    seedTv(flat.slice(-2500));
    put(dir, 'EURUSD_M15.csv', csv({ clock: 'ny:7', bars: flat }));
    r = m.importAll({ dir })[0];
    ok(r.status === 'refused' && /قطعی نشد|فرقی/.test(r.reason), 'a flat market (every clock fits equally): refused instead of guessing');

    dir = scenario(); // the user says a clock that does not fit the data
    seedTv(LAST);
    put(dir, 'EURUSD_M15.csv', csv({ clock: 'ny:7', bars: YEAR }));
    r = m.importAll({ dir, offset: 'fixed:9' })[0];
    ok(r.status === 'refused' && /نمی‌خوانند/.test(r.reason) && !store.read('MT5:OANDA:EURUSD', '15').length, 'a wrong manual --offset is caught by the overlap and nothing is stored');
  }

  // ---- 6) one clock regime in the history: no need to tell the models apart ----
  {
    const dir = scenario(), part = truth('2025-11-10T00:00:00Z', '2025-12-20T00:00:00Z', 21);
    seedTv(part.slice(-1500));
    put(dir, 'EURUSD_M15.csv', csv({ clock: 'ny:7', bars: part }));
    const r = m.importAll({ dir })[0];
    ok(r.status === 'stored' && /یک دوره/.test(r.note) && store.read('MT5:OANDA:EURUSD', '15').every((b, i) => b.time === part[i].time), 'a history inside one clock regime is accepted, and the report says the models could not be told apart');
  }

  // ---- 7) daily candles use the intraday clock ----
  {
    const dir = scenario(), days = [];
    seedTv(LAST);
    for (let u = Date.parse('2024-01-01T00:00:00Z') / 1000, r = rng(3), p = 1900; days.length < 400; u += 86400) { const c = p * (1 + (r() - 0.5) * 0.01); days.push({ time: u, open: p, max: Math.max(p, c) * 1.001, min: Math.min(p, c) * 0.999, close: c, volume: 1000 }); p = c; }
    const dayCsv = (clock) => csv({ tf: 'D1', clock: 'fixed:3', bars: days }); // times are midnight server time
    put(dir, 'EURUSD_D1.csv', dayCsv());
    let rs = m.importAll({ dir });
    ok(rs[0].status === 'refused' && /درون‌روزی/.test(rs[0].reason), 'daily candles alone: refused (their clock cannot be found without intraday candles)');
    put(dir, 'EURUSD_M15.csv', csv({ clock: 'ny:7', bars: YEAR }));
    rs = m.importAll({ dir });
    const d1 = rs.find((x) => x.tf === 'D');
    ok(rs[0].tf === '15' && d1.status === 'stored' && d1.hyp.id === 'ny:7' && /درون‌روزی/.test(d1.note), 'daily candles are converted with the clock found for the same symbol\'s M15 candles (intraday files are processed first)');
  }

  // ---- 7b) other timeframes of the same symbol reuse the proven clock ----
  {
    const dir = scenario(), agg = (k) => { const out = []; for (const b of YEAR) { const slot = Math.floor(b.time / (900 * k)) * 900 * k, l = out[out.length - 1]; if (l && l.time === slot) { l.max = Math.max(l.max, b.max); l.min = Math.min(l.min, b.min); l.close = b.close; l.volume += b.volume; } else out.push({ time: slot, open: b.open, max: b.max, min: b.min, close: b.close, volume: b.volume }); } return out; };
    seedTv(LAST); // TradingView candles exist for M15 ONLY
    put(dir, 'EURUSD_M5.csv', csv({ tf: 'M5', clock: 'ny:7', bars: YEAR.slice(-9000).map((b) => ({ ...b, time: b.time })) })); // a finer file that sorts BEFORE the M15 one
    put(dir, 'EURUSD_M15.csv', csv({ clock: 'ny:7', bars: YEAR }));
    put(dir, 'EURUSD_H1.csv', csv({ tf: 'H1', clock: 'ny:7', bars: agg(4) }));
    const rs = m.importAll({ dir }), by = (tf) => rs.find((x) => x.tf === tf);
    ok(by('15').status === 'stored' && by('15').hyp.id === 'ny:7', 'several timeframes: M15 is proven against TradingView');
    ok(by('60').status === 'stored' && by('60').hyp.id === 'ny:7' && /کافی نبود/.test(by('60').note) && store.read('MT5:OANDA:EURUSD', '60').length === agg(4).length, 'several timeframes: H1 (no TradingView H1 candles at all) reuses the clock proven on M15');
    ok(by('5').status === 'stored' && by('5').hyp.id === 'ny:7', 'several timeframes: a finer file (M5, processed before M15) is retried after M15 has proven the clock');
    const h1 = store.read('MT5:OANDA:EURUSD', '60'), want = agg(4);
    ok(h1.every((b, i) => b.time === want[i].time), 'several timeframes: the H1 candles sit on their true UTC hours');
  }

  // ---- 7b2) the clock belongs to the broker's SERVER; only TradingView candles across a clock change prove it ----
  {
    // like the real MetaQuotes-Demo server: the clock is "Athens" (Europe's daylight saving) and the broker's session schedule follows IT,
    // so the weekly opening hour drifts against New York in the weeks Europe and America differ (the old weekly-opening idea chose "New York" here)
    const ATHENS = (u) => { const d = new Date((u + m.zoneOffset(ATH, u)) * 1000), day = d.getUTCDay(), hr = d.getUTCHours(); return day === 6 ? false : day === 0 ? hr >= 23 : day === 5 ? hr < 22 : true; };
    const sched = (seed) => { const r = rng(seed), out = []; let p = 2000; for (let u = Date.parse('2025-01-01T00:00:00Z') / 1000; u < Date.parse('2026-01-01T00:00:00Z') / 1000; u += 900) { if (!ATHENS(u)) continue; const o = p, c = p * (1 + (r() - 0.5) * 0.0028); out.push({ time: u, open: o, max: Math.max(o, c) * 1.0002, min: Math.min(o, c) * 0.9998, close: c, volume: 100 }); p = c; } return out; };
    const fx = sched(77), goldBars = sched(78);
    const span = fx.filter((b) => b.time >= Date.parse('2025-02-20T00:00:00Z') / 1000 && b.time < Date.parse('2025-04-20T00:00:00Z') / 1000);
    const dayBars = Array.from({ length: 400 }, (_, i) => ({ time: Date.parse('2024-01-01T00:00:00Z') / 1000 + i * 86400, open: 2000, max: 2010, min: 1990, close: 2005, volume: 10 }));
    const files = (dir, extra = {}) => { put(dir, 'EURUSD_M15.csv', csv({ symbol: 'EURUSD', clock: 'eu:0', bars: fx })); put(dir, 'XAUUSD_M15.csv', csv({ symbol: 'XAUUSD', clock: 'eu:0', bars: goldBars, seed: 3, ...extra })); };
    let dir = scenario();
    seedTv(span, 'OANDA:EURUSD'); // TradingView has candles for EURUSD only, and they span the March gap
    files(dir);
    put(dir, 'XAUUSD_D1.csv', csv({ symbol: 'XAUUSD', tf: 'D1', clock: 'eu:0', bars: dayBars }));
    let rs = m.importAll({ dir });
    const eur = rs.find((x) => x.mt5Symbol === 'EURUSD'), gold = rs.find((x) => x.mt5Symbol === 'XAUUSD' && x.tf === '15'), goldD = rs.find((x) => x.mt5Symbol === 'XAUUSD' && x.tf === 'D');
    ok(eur.status === 'stored' && eur.hyp.id === 'eu:0' && /ناهم‌خوان/.test(eur.note), 'server clock: TradingView candles that span the March gap prove the clock DIRECTLY (misplaced candles are counted) - "Athens", not "New York"');
    ok(gold.status === 'stored' && gold.hyp.id === 'eu:0' && /Test-Server/.test(gold.note) && /EURUSD/.test(gold.note), 'server clock: gold has no TradingView candles and simply takes the server clock EURUSD proved');
    ok(goldD.status === 'stored' && goldD.hyp.id === 'eu:0', 'server clock: gold daily candles too');
    ok(store.read('MT5:OANDA:XAUUSD', '15').every((b, i) => b.time === goldBars[i].time) && store.read('MT5:OANDA:EURUSD', '15').every((b, i) => b.time === fx[i].time), 'server clock: every candle sits on its true UTC time');

    dir = scenario(); // TradingView candles from one winter month only: no proof, so nothing is guessed
    seedTv(fx.slice(-2500), 'OANDA:EURUSD');
    files(dir);
    rs = m.importAll({ dir });
    ok(rs.every((x) => x.status === 'refused' && /تغییر ساعت/.test(x.reason) && /--offset/.test(x.reason)) && !store.read('MT5:OANDA:EURUSD', '15').length, 'no TradingView candles across a clock change: everything is refused (nothing is guessed from market opening hours) and it says how to get the proof');
    rs = m.importAll({ dir, offset: 'eu:0' });
    ok(rs.every((x) => x.status === 'stored'), 'the same files with --offset eu:0 are accepted');

    dir = scenario(); // another server is never given this clock
    seedTv(span, 'OANDA:EURUSD');
    files(dir, { server: 'Other-Broker' });
    rs = m.importAll({ dir });
    const other = rs.find((x) => x.mt5Symbol === 'XAUUSD');
    ok(rs.find((x) => x.mt5Symbol === 'EURUSD').status === 'stored' && other.status === 'refused' && /--offset/.test(other.reason), 'a DIFFERENT server\'s clock is never borrowed (its own clock is unknown: refused)');
  }

  // ---- 7c) weekly and monthly files ----
  {
    const dir = scenario(), mk = (n, next) => { const out = []; let p = 1500; const r = rng(9); for (let i = 0; i < n; i++) { const c = p * (1 + (r() - 0.5) * 0.04); out.push({ time: next(i), open: p, max: Math.max(p, c) * 1.002, min: Math.min(p, c) * 0.998, close: c, volume: 5000 }); p = c; } return out; };
    seedTv(LAST);
    put(dir, 'EURUSD_M15.csv', csv({ clock: 'ny:7', bars: YEAR }));
    put(dir, 'EURUSD_W1.csv', csv({ tf: 'W1', clock: 'fixed:3', bars: mk(400, (i) => 1262563200 + i * 604800) }));
    put(dir, 'EURUSD_MN1.csv', csv({ tf: 'MN1', clock: 'fixed:3', bars: mk(250, (i) => Date.UTC(1990, i, 1) / 1000) }));
    const rs = m.importAll({ dir }), w = rs.find((x) => x.tf === 'W'), mo = rs.find((x) => x.tf === 'M');
    ok(w && w.status === 'stored' && mo && mo.status === 'stored' && store.read('MT5:OANDA:EURUSD', 'W').length === 400 && store.read('MT5:OANDA:EURUSD', 'M').length === 250, 'weekly (W1) and monthly (MN1) files are imported with the clock of the symbol\'s intraday file');
  }

  // ---- 8) files that are not usable are skipped with a reason ----
  {
    const dir = scenario();
    put(dir, 'a.csv', '1,2,3\n');
    put(dir, 'EURUSD_M15.csv', '#tvhub-mt5,1\n#symbol,US30\n#tf,M15\ntime,open,high,low,close\n' + YEAR.slice(0, 400).map((b) => [b.time, b.open, b.max, b.min, b.close].join(',')).join('\n'));
    put(dir, 'EURUSD_M7.csv', '#symbol,EURUSD\n#tf,M7\n');
    const rs = m.importAll({ dir });
    ok(rs.every((r) => r.status === 'skipped') && rs.some((r) => /--map/.test(r.reason)) && rs.some((r) => /M7/.test(r.reason)) && rs.some((r) => /#symbol/.test(r.reason)), 'unknown symbol (asks for --map), unknown timeframe and a file the script did not make: each skipped with its own reason');
    let e = null; try { m.importAll({ dir: path.join(tmp, 'nothing-here') }); } catch (x) { e = x; }
    ok(e && /TvHubExport/.test(e.message), 'a missing folder explains how to create the files');
  }

  // ---- 8b) the command line saves a report Notepad can read ----
  {
    const cp = require('child_process'), dir = scenario(), out = path.join(tmp, 'report.txt');
    seedTv(LAST);
    put(dir, 'EURUSD_M15.csv', csv({ clock: 'ny:7', bars: YEAR }));
    const r1 = cp.spawnSync(process.execPath, [path.join(__dirname, 'mt5-import.js'), '--dir', dir, '--out', out], { env: { ...process.env }, encoding: 'utf8' });
    const txt = fs.readFileSync(out, 'utf8');
    ok(r1.status === 0 && txt.charCodeAt(0) === 0xFEFF && /OANDA:EURUSD/.test(txt) && /1 از 1 فایل وارد شد/.test(txt), 'command line: --out saves the report as UTF-8 with a BOM (Persian shows correctly in Notepad), and exit code 0');
    const r2 = cp.spawnSync(process.execPath, [path.join(__dirname, 'mt5-import.js'), '--dir', path.join(tmp, 'missing'), '--out', out], { env: { ...process.env }, encoding: 'utf8' });
    ok(r2.status === 1 && /TvHubExport/.test(fs.readFileSync(out, 'utf8')), 'command line: even an error (missing folder) is written to the report file');
  }

  // ---- 9) backtests can read the MetaTrader archive ----
  {
    const bt = require('./backtest');
    const dir = scenario();
    seedTv(LAST);
    put(dir, 'EURUSD_M15.csv', csv({ clock: 'ny:7', bars: YEAR }));
    m.importAll({ dir });
    const cache = path.join(tmp, 'btcache');
    const r = await bt.loadAll({ symbols: ['OANDA:EURUSD'], tf: '15', candles: 20000, cacheDir: cache, source: 'mt5' });
    const bars = r.data['OANDA:EURUSD'];
    ok(bars.length === 20000 && bars[bars.length - 1].time === YEAR[YEAR.length - 1].time && r.stamps['OANDA:EURUSD'] > 0, 'backtest source "mt5": the newest 20000 candles come straight from the MetaTrader archive (no TradingView download)');
    const all = await bt.loadAll({ symbols: ['OANDA:EURUSD', 'OANDA:GBPUSD'], tf: '15', candles: 999999, cacheDir: cache, source: 'mt5' });
    ok(all.data['OANDA:EURUSD'].length === YEAR.length && all.data['OANDA:GBPUSD'].length === 0, 'backtest source "mt5": all history is available, and a symbol that was never imported is simply empty');
    const rep = await bt.runBacktest({ symbols: ['OANDA:GBPUSD'], tf: '15', candles: 5000, cacheDir: cache, source: 'mt5' });
    ok(rep.error && /MetaTrader/.test(rep.error) && !/TradingView access/.test(rep.error), 'a backtest on MetaTrader data with nothing imported says to import first (not "check TradingView")');
    const rep2 = await bt.runBacktest({ symbols: ['OANDA:EURUSD'], tf: '15', candles: 30000, cacheDir: cache, source: 'mt5' });
    ok(!rep2.error && rep2.source === 'mt5', 'a full backtest runs on 30000 MetaTrader candles and the report says where the data came from');
  }

  console.log(`\n${passed} MetaTrader import checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
