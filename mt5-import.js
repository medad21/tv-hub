// Long history for gold / forex from MetaTrader 5. TradingView only gives the last few thousand candles; MetaTrader keeps years of
// them on your broker's server. The script mt5/TvHubExport.mq5 (run it inside MT5) writes them as CSV files into MetaTrader's shared
// "Common\Files\tvhub-mt5" folder; this file reads those CSV files and puts the candles into the candle archive under a SEPARATE
// name ("MT5:<TradingView symbol>"), so MetaTrader data and TradingView data are never mixed. A backtest chooses which one it uses
// (dashboard: "data source"; the live bot keeps using TradingView, unchanged).
// Timeframes: M1 M5 M15 M30 H1 H4 D1 W1 MN1 (MetaTrader has no yearly timeframe).
//
//   node mt5-import.js                        reads %APPDATA%\MetaQuotes\Terminal\Common\Files\tvhub-mt5
//   node mt5-import.js --dir "D:\MT5\Common\Files\tvhub-mt5"      (a portable MT5, or another folder)
//   options: --map "GOLD#=OANDA:XAUUSD,BTCUSD=BINANCE:BTCUSDT"   MetaTrader name = TradingView name (the usual forex/gold names and
//                                                                 broker suffixes like XAUUSD.a are recognised without this)
//            --offset auto | fixed:3 | ny:7 | eu:0                how to turn the broker's clock into UTC (default auto, see below)
//            --dry                                                check everything, store nothing
//   npm run import-mt5
//
// THE TIME PROBLEM. MetaTrader candle times are the SERVER's clock, not UTC, and most brokers' clocks move with daylight saving
// (typically "New York time + 7 hours": UTC+2 in winter, UTC+3 in summer). One fixed shift for the whole history would be wrong for
// part of the years. The clock belongs to the broker's SERVER, not to a symbol, so `auto` decides it ONCE per server from all its files,
// and REFUSES to store when it cannot be sure (see chooseClock):
//   1. it lines the MetaTrader candles up with the TradingView candles the bot archived (the closes must match, a wrong shift does not);
//      every file that has TradingView candles must agree;
//   2. the clock models that still differ somewhere in the history are told apart ONLY by TradingView candles that span a daylight-saving
//      change (direct proof: the right model leaves clearly fewer candles misplaced); no proof -> refuse, nothing is guessed;
//   3. symbols/timeframes without TradingView candles, daily/weekly/monthly files simply use the server's clock.
// The archive of one symbol+timeframe is REPLACED by every import (it is a pure import: running it again with a longer export or a
// better setting fixes everything instead of leaving old candles behind).
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./candle-store');
const { atomicWrite } = require('./fsutil');
const { findGaps, compareOverlap } = require('./history-import');

const TF = { M1: '1', M5: '5', M15: '15', M30: '30', H1: '60', H4: '240', D1: 'D', W1: 'W', MN1: 'M' };
const STEP = { '1': 60, '5': 300, '15': 900, '30': 1800, '60': 3600, '240': 14400, D: 86400, W: 604800, M: 2592000 }; // M (monthly) is only roughly 30 days
const INTRADAY = (tf) => STEP[tf] < 86400;
const ZONES = { ny: 'America/New_York', eu: 'Europe/Athens' }; // brokers' servers follow one of these two daylight-saving calendars (or none)
const mt5Key = (tvSymbol) => 'MT5:' + tvSymbol; // the archive name of MetaTrader data (TradingView data keeps the plain symbol name)

function defaultDir() {
  if (process.env.MT5_COMMON_DIR) return process.env.MT5_COMMON_DIR;
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'MetaQuotes', 'Terminal', 'Common', 'Files', 'tvhub-mt5');
}

// ---------------- CSV (written by TvHubExport.mq5) ----------------
// "#key,value" lines are information, then "time,open,high,low,close,tick_volume,spread". Returns { meta, bars, dropped }.
function parseCsv(text) {
  const meta = {}, byTime = new Map();
  let dropped = 0;
  for (const raw of String(text).replace(/^\uFEFF/, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === '#') { const i = line.indexOf(','); if (i > 1) meta[line.slice(1, i)] = line.slice(i + 1).trim(); continue; }
    const f = line.split(',');
    if (f.length < 5) continue;
    const t = Number(f[0]);
    if (!Number.isFinite(t)) continue; // the column titles
    const b = { time: Math.floor(t), open: Number(f[1]), max: Number(f[2]), min: Number(f[3]), close: Number(f[4]), volume: Number(f[5]) || 0 };
    const sane = [b.open, b.max, b.min, b.close].every(Number.isFinite) && b.max >= b.min && b.max >= Math.max(b.open, b.close) && b.min <= Math.min(b.open, b.close) && b.min > 0 && b.volume >= 0;
    if (sane) byTime.set(b.time, b); else dropped++;
  }
  return { meta, bars: [...byTime.values()].sort((a, b) => a.time - b.time), dropped };
}

// ---------------- clock models: server time -> UTC ----------------
const dtfs = {}, offs = {};
function zoneOffset(zone, utc) { // seconds the wall clock of `zone` is ahead of UTC at that moment (changes on whole hours)
  const hour = Math.floor(utc / 3600), cache = offs[zone] || (offs[zone] = new Map());
  let v = cache.get(hour);
  if (v === undefined) {
    const f = dtfs[zone] || (dtfs[zone] = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
    const p = {};
    for (const x of f.formatToParts(new Date(hour * 3600000))) p[x.type] = x.value;
    v = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000 - hour * 3600;
    cache.set(hour, v);
  }
  return v;
}
function wallToUtc(zone, wall) { let u = wall - zoneOffset(zone, wall); u = wall - zoneOffset(zone, u); return wall - zoneOffset(zone, u); }

// kind: 'fixed' (n = hours ahead of UTC all year) | 'ny' / 'eu' (the server clock = that zone's clock + n hours, so it follows its daylight saving)
function makeHyp(kind, n) {
  const toUtc = kind === 'fixed' ? (t) => t - n * 3600 : (t) => wallToUtc(ZONES[kind], t - n * 3600);
  const sign = n >= 0 ? '+' : '';
  const label = kind === 'fixed' ? `ساعت ثابت (UTC${sign}${n}، بدون تغییر ساعت تابستانی)`
    : `ساعت سرور = ساعت ${kind === 'ny' ? 'نیویورک' : 'اروپای شرقی (آتن)'} ${sign}${n} ساعت (با تغییر ساعت تابستانی ${kind === 'ny' ? 'آمریکا' : 'اروپا'})`;
  return { kind, n, id: `${kind}:${n}`, label, toUtc, offsetAt: (t) => t - toUtc(t) };
}
const ALL = [];
for (const kind of ['fixed', 'ny', 'eu']) for (let n = -14; n <= 14; n++) ALL.push(makeHyp(kind, n));
const PREFER = { ny: 0, eu: 1, fixed: 2 };

function parseOffset(s) { // "fixed:3" | "ny:7" | "eu:0"
  const m = /^(fixed|ny|eu):(-?\d{1,2})$/i.exec(String(s || '').trim());
  if (!m || Math.abs(+m[2]) > 14) throw new Error('--offset must be auto, fixed:3, ny:7 or eu:0 (the number = hours)');
  return makeHyp(m[1].toLowerCase(), Number(m[2]));
}

// ---------------- finding the clock model ----------------
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function overlapFit(sample, tvMap, h) { // how far apart are the closes when the MetaTrader candles are moved to UTC with model h?
  const d = [];
  for (const b of sample) { const c = tvMap.get(h.toUtc(b.time)); if (c > 0) d.push(Math.abs(b.close - c) / c * 100); }
  return { n: d.length, med: d.length ? median(d) : Infinity };
}

const sameMapping = (bars, a, b) => { for (let i = 0; i < bars.length; i++) if (a.toUtc(bars[i].time) !== b.toUtc(bars[i].time)) return false; return true; };

// the MetaTrader candles that fall inside the time span of the TradingView archive (the newest 12000 of them): where the two can be compared
function overlapSample(bars, tvBars) {
  const lo = tvBars[0].time - 86400, hi = tvBars[tvBars.length - 1].time + 86400; // a day of margin: the server clock differs from UTC by hours
  return bars.filter((b) => b.time >= lo && b.time <= hi).slice(-12000);
}
const countBad = (sample, tvMap, h, tol) => { let n = 0; for (const b of sample) { const c = tvMap.get(h.toUtc(b.time)); if (c > 0 && Math.abs(b.close - c) / c * 100 > tol) n++; } return n; };

// Every clock model against the TradingView candles of ONE file: { sample, fits: [{ h, n, med, bad? }], mStar (best median), tol }.
// `bad` = candles whose close is further from TradingView's than tol (5x the best median, at least 0.01%): the candles a model misplaces.
function fitAll(bars, tvBars, minOverlap, withBad) {
  if (!tvBars || tvBars.length < minOverlap || !bars.length) return null;
  const sample = overlapSample(bars, tvBars);
  if (!sample.length) return null;
  const tvMap = new Map(tvBars.map((b) => [b.time, b.close]));
  const fits = ALL.map((h) => ({ h, ...overlapFit(sample, tvMap, h) })).filter((f) => f.n >= minOverlap);
  if (!fits.length) return { sample, fits };
  const mStar = Math.min(...fits.map((f) => f.med)), tol = Math.max(5 * mStar, 0.01);
  if (withBad) for (const f of fits) f.bad = countBad(sample, tvMap, f.h, tol);
  return { sample, fits, mStar, tol };
}

// How well does clock model h fit ONE file against its TradingView candles, and how much better than every model that maps the same
// candles to different times? null = too little overlap to say.
function fileEvidence(bars, tvBars, h, minOverlap = 100) {
  const F = fitAll(bars, tvBars, minOverlap, false);
  if (!F || !F.fits.length) return null;
  const mine = F.fits.find((f) => f.h.id === h.id);
  if (!mine) return null;
  let runner = Infinity;
  for (const f of F.fits) if (f.med < runner && !sameMapping(F.sample, h, f.h)) runner = f.med;
  return { overlap: mine.n, medianPct: mine.med, best: F.mStar, runnerUpPct: Number.isFinite(runner) ? runner : null };
}

// One file against TradingView: the clock models that line ITS candles up (every other model leaves a clear number of them misplaced).
// They must all map this file's overlap to the same times, otherwise the overlap cannot tell them apart (a flat market, a short window).
function alignFile(e, minOverlap = 100) {
  const F = fitAll(e.bars, e.tvBars, minOverlap, true);
  if (!F || !F.fits.length) return { ok: false, reason: `کندل‌های MetaTrader و TradingView برای ${e.tag} با هیچ ساعتی روی هم نیفتادند (کمتر از ${minOverlap} کندل هم‌زمان). نماد یا تایم‌فریم درست است؟ بازه‌ی زمانی مشترک دارند؟` };
  if (F.mStar > 0.5) return { ok: false, reason: `بهترین هم‌ترازی هم قابل‌قبول نیست (${e.tag}: اختلاف میانه‌ی قیمت ${F.mStar.toFixed(3)}٪). این دو منبع قیمتی خیلی با هم فرق دارند یا نماد یکی نیست.` };
  const b0 = Math.min(...F.fits.map((f) => f.bad)), slack = Math.max(5, Math.floor(0.01 * F.sample.length));
  const alive = F.fits.filter((f) => f.bad <= b0 + slack).sort((x, y) => x.bad - y.bad || x.med - y.med);
  const rep = alive[0];
  if (!alive.every((f) => sameMapping(F.sample, rep.h, f.h))) return { ok: false, reason: `هم‌ترازی زمانی قطعی نشد (${e.tag}): چند ساعت متفاوت به یک اندازه خوب با TradingView می‌خوانند (بازار آن‌قدر آرام بود یا بازه‌ی مشترک آن‌قدر کوتاه است که فرقی دیده نمی‌شود). با داده‌ی بیشتر یا بازه‌ی پرنوسان‌تر دوباره امتحان کن، یا ساعت را دستی بده.` };
  let runner = Infinity;
  for (const f of F.fits) if (f.med < runner && !sameMapping(F.sample, rep.h, f.h)) runner = f.med;
  return { ok: true, tag: e.tag, evidence: { overlap: rep.n, medianPct: rep.med, runnerUpPct: Number.isFinite(runner) ? runner : null }, fits: new Map(F.fits.map((f) => [f.h.id, f.bad])), A: alive.map((f) => ({ h: f.h })) };
}

const NO_OVERLAP = 'برای تشخیص ساعت سرور باید حداقل ۱۰۰ کندل مشترک با آرشیو TradingView باشد، ولی آرشیو TradingView این نمادها/تایم‌فریم‌ها تقریباً خالی است. یک بک‌تست با منبع TradingView روی یکی از همین نمادها (مثلاً EURUSD، ۱ ساعته) اجرا کن تا آرشیو پر شود، یا ساعت را دستی بده: --offset ny:7';
const INTRADAY_NEEDED = 'برای کندل روزانه/هفتگی/ماهانه نمی‌شود ساعت را مستقل تشخیص داد؛ همان نماد (یا یک جفت‌ارز اصلی مثل EURUSD) را در یک تایم‌فریم درون‌روزی (مثل M15) هم از همان سرور صادر کن تا همان ساعت به‌کار برود، یا --offset بده.';

// THE CLOCK BELONGS TO THE BROKER'S SERVER, NOT TO A SYMBOL: one decision for all the intraday files of one server, using all the evidence:
//   1. every file that has TradingView candles keeps only the clock models that line them up (alignFile); a model must survive ALL files;
//   2. the models that still differ somewhere in the history can only be told apart by TradingView candles that SPAN a daylight-saving
//      change: the right model leaves clearly fewer candles misplaced, the wrong ones are dropped by that file. That is the direct proof.
//   There is deliberately NO guessing from "when does the market open each week": on a real server (MetaQuotes-Demo) that idea picked the
//   wrong clock with 98% "consistency", because the broker's own session schedule follows ITS server clock, not New York.
//   No proof -> refuse. Symbols/timeframes without TradingView candles, daily/weekly/monthly files simply use the server's clock.
// entries: [{ bars (server clock), tvBars, tag }] -> { ok:true, hyp, note, evidence } | { ok:false, reason }
function chooseClock(entries) {
  if (!entries.length) return { ok: false, reason: INTRADAY_NEEDED };
  const aligned = [];
  let firstFail = null;
  for (const e of entries) {
    if (!e.tvBars || e.tvBars.length < 100) continue;
    const r = alignFile(e);
    if (r.ok) aligned.push(r); else if (!firstFail) firstFail = r;
  }
  if (!aligned.length) return firstFail ? { ok: false, reason: firstFail.reason } : { ok: false, reason: NO_OVERLAP };
  const from = aligned.slice(0, 3).map((x) => x.tag).join('، ') + (aligned.length > 3 ? '، ...' : '');
  const evidence = { files: aligned.length, from };
  let alive = null; // id -> h
  for (const r of aligned) { const m = new Map(r.A.map((a) => [a.h.id, a.h])); alive = alive ? new Map([...alive].filter(([id]) => m.has(id))) : m; }
  if (!alive.size) return { ok: false, reason: `فایل‌های این سرور با هم روی یک ساعت نمی‌خوانند (${from}): هر کدام ساعت دیگری را نشان می‌دهد. چیزی ذخیره نشد؛ ساعت را دستی بده: --offset ny:7`, evidence };
  // do the models that survived still differ somewhere in the history of this server? (compared on every hour any file has)
  const hours = new Set();
  let tNow = 0;
  for (const e of entries) { for (const b of e.bars) hours.add(Math.floor(b.time / 3600)); tNow = Math.max(tNow, e.bars[e.bars.length - 1].time); }
  const probe = [...hours].map((h) => ({ time: h * 3600 }));
  const survivors = [...alive.values()].sort((x, y) => PREFER[x.kind] - PREFER[y.kind] || x.n - y.n);
  const classes = [];
  for (const h of survivors) if (!classes.some((k) => sameMapping(probe, k, h))) classes.push(h);
  if (classes.length > 1) return { ok: false, reason: 'تاریخچه‌ی این سرور از یک تغییر ساعت تابستانی عبور می‌کند و مدل‌های ساعت فقط همان‌جا با هم فرق دارند، ولی کندل‌های TradingView تو نمی‌توانند بینشان تصمیم بگیرند (باید از یک تغییر ساعت عبور کنند: اواسط مارس یا اواخر اکتبر تا اول نوامبر). یک بک‌تست ۱ ساعته‌ی TradingView با تعداد کندل زیاد روی یک جفت‌ارز اجرا کن تا آرشیو بلندتر شود و دوباره import بزن، یا ساعت را دستی بده: --offset eu:0 (اروپای شرقی با تغییر ساعت اروپا) یا --offset ny:7 (نیویورک + ۷ با تغییر ساعت آمریکا)', evidence };
  const hyp = classes[0];
  // the rival that proves it: the model that agrees with this one NOW but differs somewhere in the history, and how many candles it misplaces
  const total = (h) => { let t = 0; for (const r of aligned) { const b = r.fits.get(h.id); if (b === undefined) return null; t += b; } return t; };
  const mine = total(hyp);
  let rival = null;
  for (const h of ALL) {
    if (h.offsetAt(tNow) !== hyp.offsetAt(tNow) || sameMapping(probe, hyp, h)) continue;
    const t = total(h);
    if (t !== null && (rival === null || t < rival)) rival = t;
  }
  if (rival !== null && mine !== null) return { ok: true, hyp, from, evidence: { ...evidence, bad: mine, rivalBad: rival }, note: `کندل‌های TradingView که از یک تغییر ساعت تابستانی عبور می‌کنند فقط با این مدل می‌خوانند (${mine} کندل ناهم‌خوان، در برابر ${rival} برای نزدیک‌ترین مدل رقیب).` };
  return { ok: true, hyp, from, evidence, note: 'کل تاریخچه‌ی این سرور در یک دوره‌ی ساعتی است؛ مدل‌های ساعت در این بازه فرقی ندارند. اگر بعداً تاریخچه‌ی بلندتری (که از تغییر ساعت عبور کند) وارد کنی، دوباره سنجیده می‌شود.' };
}

// ---------------- symbols ----------------
const CCY = 'USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|CNH|SEK|NOK|DKK|PLN|TRY|ZAR|MXN|SGD|HKD|CZK|HUF', FXRE = new RegExp(`^((?:XAU|XAG|${CCY})(?:${CCY}))([._#-]?[A-Z0-9]{0,4})$`);
const ALIAS = { GOLD: 'XAUUSD', SILVER: 'XAGUSD' };
function parseMap(s) {
  const out = {};
  for (const part of String(s || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^([^=]+)=([A-Z0-9_]+:[A-Z0-9._!-]+)$/i.exec(part);
    if (!m) throw new Error(`--map: "${part}" must look like GOLD#=OANDA:XAUUSD`);
    out[m[1].trim().toUpperCase()] = m[2].trim().toUpperCase();
  }
  return out;
}
// MetaTrader name -> TradingView name (null = unknown, the user must say with --map)
function mapSymbol(mt5Symbol, map = {}) {
  const u = String(mt5Symbol).trim().toUpperCase();
  if (map[u]) return map[u];
  if (ALIAS[u]) return 'OANDA:' + ALIAS[u];
  const m = FXRE.exec(u);
  return m ? 'OANDA:' + m[1] : null;
}

// ---------------- importing ----------------
const iso = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—');
const metaFile = () => path.join(store.dir(), 'mt5-import.json');
function readMeta() { try { return JSON.parse(fs.readFileSync(metaFile(), 'utf8')); } catch { return {}; } }

// reads one file: -> { res, bars, skip }  (skip = this file cannot be imported at all; res says why)
function prepare({ name, text }, map) {
  const { meta, bars, dropped } = parseCsv(text);
  const res = { file: name, mt5Symbol: meta.symbol || null, tf: null, tv: null, status: 'refused', candles: bars.length, dropped };
  const tfName = String(meta.tf || (/_([A-Z0-9]+)\.csv$/i.exec(name) || [])[1] || '').toUpperCase();
  res.tf = TF[tfName]; res.tfName = tfName;
  const skip = (reason) => ({ res: { ...res, status: 'skipped', reason }, bars, skip: true });
  if (!res.mt5Symbol) return skip('سرخط #symbol در فایل نیست (این فایل را اسکریپت TvHubExport نساخته است)');
  if (!res.tf) return skip(`تایم‌فریم «${tfName || '؟'}» پشتیبانی نمی‌شود`);
  res.tv = mapSymbol(res.mt5Symbol, map);
  if (!res.tv) return skip(`نام ${res.mt5Symbol} را به TradingView نمی‌شناسم؛ بگو با --map "${res.mt5Symbol}=EXCHANGE:SYMBOL" (نام TradingView را جای EXCHANGE:SYMBOL بگذار)`);
  const minBars = INTRADAY(res.tf) ? 300 : 200; // daily/weekly/monthly series are naturally shorter
  if (bars.length < minBars) return skip(`فقط ${bars.length} کندل (کمتر از ${minBars}) در فایل است`);
  res.server = meta.server || null; res.company = meta.company || null;
  return { res, bars, skip: false };
}

// one prepared file + the clock decided for its server -> result
function importOne({ res, bars }, { offset, dry, clocks }) {
  let hyp = offset, note = null;
  const tvBars = store.read(res.tv, res.tf);
  if (!hyp) {
    const c = clocks.get(res.server || '');
    if (!c || !c.ok) return { ...res, reason: c ? c.reason : INTRADAY_NEEDED, evidence: c && c.evidence };
    hyp = c.hyp;
    if (INTRADAY(res.tf)) note = c.note + (tvBars.length < 100 ? ` برای این نماد/تایم‌فریم کندل TradingView کافی نبود؛ ساعت سرور (${res.server || '؟'}) که با ${c.from} ثابت شد به‌کار رفت (ساعت مال سرور است و برای همه‌ی نمادها و تایم‌فریم‌های آن یکی است).` : '');
    else note = 'ساعت سرور از کندل‌های درون‌روزی تأییدشده با TradingView گرفته شد؛ روزانه/هفتگی/ماهانه با TradingView مقایسه نشد (ساعت شروع روز در دو منبع فرق دارد).';
  }
  if (INTRADAY(res.tf)) {
    const ev = fileEvidence(bars, tvBars, hyp);
    if (ev && ev.medianPct > 3 * ev.best + 0.01) return { ...res, hyp, reason: `با این ساعت (${hyp.label}) کندل‌ها با TradingView نمی‌خوانند (اختلاف میانه ${ev.medianPct.toFixed(3)}٪، در حالی که با ساعت درست ${ev.best.toFixed(4)}٪ می‌شود). ذخیره نشد${offset ? '؛ --offset auto را امتحان کن' : ''}.` };
    if (ev) res.evidence = ev;
  }
  const utc = [];
  for (const b of bars) utc.push({ ...b, time: hyp.toUtc(b.time) });
  utc.sort((a, b) => a.time - b.time);
  const clean = utc.filter((b, i) => i === 0 || b.time !== utc[i - 1].time);
  const overlap = compareOverlap(clean, tvBars);
  const long = findGaps(clean, STEP[res.tf]).list.filter((g) => g.missing * STEP[res.tf] > 5 * 86400);
  Object.assign(res, { hyp, note, overlap, longGaps: long, from: clean[0].time, to: clean[clean.length - 1].time, candles: clean.length });
  if (dry) return { ...res, status: 'dry' };
  store.replace(mt5Key(res.tv), res.tf, clean);
  const all = readMeta();
  all[`${mt5Key(res.tv)}|${res.tf}`] = { server: res.server, company: res.company, mt5Symbol: res.mt5Symbol, clock: hyp.id, importedAt: new Date().toISOString(), candles: clean.length, from: clean[0].time, to: clean[clean.length - 1].time };
  atomicWrite(metaFile(), JSON.stringify(all, null, 1));
  return { ...res, status: 'stored' };
}

// opts: { dir, map, offset ('auto' | 'ny:7' ...), dry }  -> results[]
function importAll(opts = {}) {
  const dir = opts.dir || defaultDir();
  let names;
  try { names = fs.readdirSync(dir).filter((x) => /\.csv$/i.test(x)); } catch { throw new Error(`پوشه‌ی ${dir} پیدا نشد. اول اسکریپت TvHubExport را در MetaTrader اجرا کن (راهنما: README، بخش MetaTrader)، یا مسیر درست را با --dir بده.`); }
  if (!names.length) throw new Error(`در ${dir} فایل CSV نیست. اول اسکریپت TvHubExport را در MetaTrader اجرا کن.`);
  const map = typeof opts.map === 'string' ? parseMap(opts.map) : (opts.map || {});
  const offset = opts.offset && String(opts.offset).toLowerCase() !== 'auto' ? parseOffset(opts.offset) : null;
  const files = names.map((name) => {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const tf = TF[String((/^#tf,(.+)$/m.exec(text) || [])[1] || (/_([A-Z0-9]+)\.csv$/i.exec(name) || [])[1] || '').trim().toUpperCase()];
    return { name, text, step: tf ? STEP[tf] : 1e9 };
  }).sort((a, b) => a.step - b.step); // finest timeframe first (only the order of the report)
  const preps = files.map((f) => { try { return prepare(f, map); } catch (e) { return { res: { file: f.name, status: 'refused', reason: e.message, candles: 0 }, skip: true }; } });
  // one clock per broker server
  const groups = new Map();
  for (const p of preps) if (!p.skip) { const k = p.res.server || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  const clocks = new Map();
  if (!offset) for (const [k, list] of groups) {
    try {
      clocks.set(k, chooseClock(list.filter((p) => INTRADAY(p.res.tf)).map((p) => ({ bars: p.bars, tvBars: store.read(p.res.tv, p.res.tf), tag: `${p.res.mt5Symbol} ${p.res.tfName}`}))));
    } catch (e) { clocks.set(k, { ok: false, reason: e.message }); }
  }
  const ctx = { offset, dry: !!opts.dry, clocks };
  return preps.map((p) => { if (p.skip) return p.res; try { return importOne(p, ctx); } catch (e) { return { ...p.res, status: 'refused', reason: e.message, candles: 0 }; } });
}

function reportText(r) {
  const head = `${r.mt5Symbol || r.file}${r.tv ? ' → ' + r.tv : ''} · ${r.tfName || '؟'}`;
  const L = [];
  if (r.status === 'stored' || r.status === 'dry') {
    L.push(`${head}: ${r.candles} کندل از ${iso(r.from)} تا ${iso(r.to)} (UTC)`);
    L.push(r.status === 'stored' ? `✅ در آرشیو جدا ذخیره شد (نام: ${mt5Key(r.tv)}؛ آرشیو TradingView دست نخورد).` : 'ℹ️ حالت آزمایشی: چیزی ذخیره نشد.');
    L.push(`ساعت سرور: ${r.hyp.label}`);
    if (r.evidence && r.evidence.overlap) L.push(`دلیل: روی ${r.evidence.overlap} کندل مشترک با TradingView اختلاف میانه‌ی قیمت ${r.evidence.medianPct.toFixed(4)}٪` + (r.evidence.runnerUpPct != null ? ` (ساعت‌های دیگر: ${r.evidence.runnerUpPct.toFixed(4)}٪ یا بدتر)` : ''));
    if (r.note) L.push(r.note);
    if (r.overlap && r.overlap.count) L.push(`هم‌پوشانی با آرشیو TradingView: ${r.overlap.count} کندل، اختلاف میانه ${r.overlap.medianPct.toFixed(4)}٪، بیشینه ${r.overlap.maxPct.toFixed(3)}٪ (قیمت دو کارگزار کمی فرق دارد؛ طبیعی است)`);
    if (r.longGaps && r.longGaps.length) L.push(`⚠️ ${r.longGaps.length} حفره‌ی بلندتر از ۵ روز: ${r.longGaps.slice(0, 3).map((g) => `${iso(g.from)} (${g.missing} کندل)`).join('، ')}`);
    if (r.dropped) L.push(`${r.dropped} کندل نامعتبر کنار گذاشته شد.`);
  } else {
    L.push(`${head}: ${r.status === 'skipped' ? '⏭️ رد شد' : '❌ ذخیره نشد'} — ${r.reason}`);
  }
  return L.join('\n');
}

// ---------------- command line ----------------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') o.dry = true;
    else if (/^--(dir|map|offset|out)$/.test(a)) o[a.slice(2)] = argv[++i];
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}
// --out <file>: the same report is also saved as UTF-8 WITH a BOM, so Notepad shows the Persian correctly (the Windows console cannot).
function main(argv) {
  const o = parseArgs(argv), lines = [];
  const say = (x) => { console.log(x); lines.push(x); };
  const save = () => { if (o.out) fs.writeFileSync(o.out, '\uFEFF' + lines.join('\n') + '\n', 'utf8'); };
  let results;
  try { results = importAll(o); } catch (e) { say(e.message); save(); process.exit(1); }
  for (const r of results) say(reportText(r) + '\n');
  const ok = results.filter((r) => r.status === 'stored' || r.status === 'dry').length;
  say(`${ok} از ${results.length} فایل وارد شد.`);
  save();
  if (results.some((r) => r.status === 'refused')) process.exit(2);
}

module.exports = { parseCsv, makeHyp, parseOffset, chooseClock, fileEvidence, mapSymbol, parseMap, importAll, importOne, reportText, mt5Key, defaultDir, zoneOffset, wallToUtc, ALL, TF, STEP, ZONES };
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); } }
