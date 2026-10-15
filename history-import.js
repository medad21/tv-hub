// Long history for the backtester. TradingView only hands out the last few thousand candles, so a 180-day backtest on 15-minute
// candles leaves a few dozen trades and the statistics have almost nothing to work with. This downloads years of candles ONCE
// from Binance's public data archive (data.binance.vision — the same exchange the bot trades on, free, no key) and adds them to
// the candle archive (candle-store.js), which backtests already read. The live bot keeps using TradingView, unchanged.
//
//   node history-import.js --symbols BINANCE:BTCUSDT,BINANCE:ETHUSDT --tf 15,60,240,D --from 2023-01
//   options: --to YYYY-MM (default: the last complete month)   --dry   (download and check, store nothing)
//   npm run import-history -- --symbols BINANCE:BTCUSDT --tf 15 --from 2023-01
//
// What it does for every month file:
//   - checks the SHA-256 checksum Binance publishes next to it (a damaged download is rejected, never stored)
//   - reads the zip itself (no extra package), checks the zip's own CRC
//   - understands both timestamp styles (milliseconds; microseconds, which Binance spot uses from 2025-01-01)
//   - drops impossible candles (high < low, NaN ...) and counts them
// and for the whole import it reports: gaps (missing candles), and a comparison with what the archive ALREADY holds for the same
// times (candles the bot saw through TradingView): a median or maximum difference that is not tiny means something is different
// about the two sources and the import should not be trusted blindly.
// Candles already in the archive are never changed. The newest part (the current, unfinished month) is not in these files; the bot
// and the TradingView download keep supplying it, and the archive merges everything by time.
// Only Binance spot (BINANCE:<PAIR>) is supported here; forex/gold and stocks need their own sources.
const zlib = require('zlib');
const crypto = require('crypto');
const store = require('./candle-store');

const BASE = process.env.BINANCE_DATA_URL || 'https://data.binance.vision';
const INTERVAL = { '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '1h', '240': '4h', D: '1d', W: '1w' };
const STEP = { '1': 60, '5': 300, '15': 900, '30': 1800, '60': 3600, '240': 14400, D: 86400, W: 604800 };

// ---------------- a minimal zip reader (the first file of an archive; deflate or stored) ----------------
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) { CRC_TABLE = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; } }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function readZipFirstFile(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file (no end-of-archive record)');
  const entries = buf.readUInt16LE(eocd + 10), cdOffset = buf.readUInt32LE(eocd + 16);
  if (!entries) throw new Error('empty zip');
  if (entries === 0xFFFF || cdOffset === 0xFFFFFFFF) throw new Error('zip64 archives are not supported');
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('damaged zip (central directory)');
  const method = buf.readUInt16LE(cdOffset + 10), crc = buf.readUInt32LE(cdOffset + 16);
  const compSize = buf.readUInt32LE(cdOffset + 20), size = buf.readUInt32LE(cdOffset + 24), local = buf.readUInt32LE(cdOffset + 42);
  const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + buf.readUInt16LE(cdOffset + 28));
  if (compSize === 0xFFFFFFFF || size === 0xFFFFFFFF) throw new Error('zip64 archives are not supported');
  if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('damaged zip (local header)');
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const raw = buf.subarray(start, start + compSize);
  if (raw.length !== compSize) throw new Error('damaged zip (truncated)');
  let data;
  if (method === 0) data = Buffer.from(raw);
  else if (method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`unsupported zip compression method ${method}`);
  if (data.length !== size) throw new Error('damaged zip (wrong size after unpacking)');
  if (crc32(data) !== crc) throw new Error('damaged zip (CRC does not match)');
  return { name, data };
}

// ---------------- Binance CSV -> candles ----------------
// columns: open time, open, high, low, close, volume, ... ; open time is milliseconds, or microseconds from 2025-01-01 on.
// A header line (some files have one) is skipped. Returns { bars, dropped }.
function parseKlines(text) {
  const bars = [];
  let dropped = 0;
  for (const line of text.split('\n')) {
    const f = line.trim().split(',');
    if (f.length < 6) continue;
    const t = Number(f[0]);
    if (!Number.isFinite(t)) continue; // header
    const time = Math.floor(t > 1e14 ? t / 1e6 : t / 1e3);
    const b = { time, open: Number(f[1]), max: Number(f[2]), min: Number(f[3]), close: Number(f[4]), volume: Number(f[5]) };
    const sane = [b.open, b.max, b.min, b.close, b.volume].every(Number.isFinite) && b.max >= b.min && b.max >= Math.max(b.open, b.close) && b.min <= Math.min(b.open, b.close) && b.min > 0 && b.volume >= 0;
    if (sane) bars.push(b); else dropped++;
  }
  return { bars, dropped };
}

// ---------------- checks ----------------
// gaps: places where candles are missing (exchange maintenance, or a damaged file). Returns { total, list(first 20) }.
function findGaps(bars, step) {
  let total = 0;
  const list = [];
  for (let i = 1; i < bars.length; i++) {
    const missing = Math.round((bars[i].time - bars[i - 1].time) / step) - 1;
    if (missing > 0) { total += missing; if (list.length < 20) list.push({ from: bars[i - 1].time + step, to: bars[i].time - step, missing }); }
  }
  return { total, list };
}

// the same candle time in both sources: how far apart are the closes (in percent)?
function compareOverlap(imported, existing) {
  const have = new Map(existing.map((b) => [b.time, b]));
  const diffs = [];
  for (const b of imported) { const o = have.get(b.time); if (o && o.close > 0) diffs.push(Math.abs(b.close - o.close) / o.close * 100); }
  if (!diffs.length) return { count: 0, medianPct: 0, maxPct: 0, suspicious: false };
  diffs.sort((a, b) => a - b);
  const medianPct = diffs[Math.floor(diffs.length / 2)], maxPct = diffs[diffs.length - 1];
  // the same exchange should agree to rounding; a median above 0.01% or any candle off by more than 1% is not "rounding"
  return { count: diffs.length, medianPct, maxPct, suspicious: medianPct > 0.01 || maxPct > 1 };
}

// ---------------- download ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 404 -> null (that month does not exist); network errors and 5xx are retried; anything else throws
async function get(url, fetchFn, tries = 3) {
  let last;
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetchFn(url);
      if (res.status === 404) return null;
      if (res.status >= 500 || res.status === 429) { last = new Error(`HTTP ${res.status}`); await sleep(500 * (a + 1) * (a + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) { last = e; if (/HTTP 4\d\d/.test(e.message)) throw e; await sleep(500 * (a + 1) * (a + 1)); }
  }
  throw new Error(`${url}: ${last && last.message}`);
}

const pad = (n) => String(n).padStart(2, '0');
function monthsBetween(from, to) { // 'YYYY-MM' .. 'YYYY-MM' inclusive
  const ok = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
  if (!ok(from) || !ok(to)) throw new Error('--from / --to must look like 2023-01');
  const out = []; let [y, m] = from.split('-').map(Number); const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${pad(m)}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
const lastCompleteMonth = (now = Date.now()) => { const d = new Date(now); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };

// 'BINANCE:BTCUSDT' -> 'BTCUSDT' (spot pairs only)
function binancePair(symbol) {
  const m = /^BINANCE:([A-Z0-9]{3,20})$/.exec(String(symbol).trim().toUpperCase());
  if (!m) throw new Error(`${symbol}: only Binance spot symbols (BINANCE:BTCUSDT) can be imported here`);
  return m[1];
}

// one month of one pair/timeframe -> { bars, dropped } or null when Binance has no such file
async function downloadMonth(pair, tf, ym, fetchFn) {
  const iv = INTERVAL[tf];
  const url = `${BASE}/data/spot/monthly/klines/${pair}/${iv}/${pair}-${iv}-${ym}.zip`;
  const zip = await get(url, fetchFn);
  if (!zip) return null;
  const sumFile = await get(`${url}.CHECKSUM`, fetchFn).catch(() => null);
  if (sumFile) { // "<sha256>  <file name>"
    const want = sumFile.toString('utf8').trim().split(/\s+/)[0].toLowerCase(), got = crypto.createHash('sha256').update(zip).digest('hex');
    if (/^[0-9a-f]{64}$/.test(want) && want !== got) throw new Error(`${pair} ${ym}: the download does not match its published checksum (damaged)`);
  }
  return parseKlines(readZipFirstFile(zip).data.toString('utf8'));
}

// opts: { symbol, tf, from, to, dry, fetch, onProgress({month, state}) }
async function importSymbol(opts) {
  const tf = String(opts.tf).toUpperCase();
  if (!INTERVAL[tf]) throw new Error(`timeframe ${opts.tf} is not supported (use ${Object.keys(INTERVAL).join(', ')})`);
  const pair = binancePair(opts.symbol), fetchFn = opts.fetch || fetch, step = STEP[tf];
  const months = monthsBetween(opts.from, opts.to || lastCompleteMonth());
  const all = new Map(), missing = [];
  let dropped = 0;
  for (const ym of months) {
    if (opts.onProgress) opts.onProgress({ symbol: opts.symbol, tf, month: ym, state: 'downloading' });
    const r = await downloadMonth(pair, tf, ym, fetchFn);
    if (!r) { missing.push(ym); continue; }
    dropped += r.dropped;
    for (const b of r.bars) all.set(b.time, b);
  }
  const bars = [...all.values()].sort((a, b) => a.time - b.time);
  if (!bars.length) return { symbol: opts.symbol, tf, months: months.length, missingMonths: missing, candles: 0, added: 0, dropped, gaps: { total: 0, list: [] }, overlap: compareOverlap([], []), from: null, to: null, stored: false };
  const overlap = compareOverlap(bars, store.read(opts.symbol, tf));
  const gaps = findGaps(bars, step);
  // never store data that disagrees with what the bot itself saw on the same candles
  const refuse = overlap.suspicious;
  const added = opts.dry || refuse ? 0 : store.backfill(opts.symbol, tf, bars);
  return { symbol: opts.symbol, tf, months: months.length, missingMonths: missing, candles: bars.length, added, dropped, gaps, overlap, from: bars[0].time, to: bars[bars.length - 1].time, stored: !opts.dry && !refuse, refused: refuse };
}

const iso = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—');
function reportText(r) {
  const L = [`${r.symbol} · تایم‌فریم ${r.tf}: ${r.candles} کندل از ${iso(r.from)} تا ${iso(r.to)} (${r.months} ماه درخواست شد)`];
  if (r.refused) L.push(`❌ ذخیره نشد: این داده با کندل‌هایی که ربات قبلاً از TradingView دیده تفاوت دارد (میانه ${r.overlap.medianPct.toFixed(3)}٪، بیشینه ${r.overlap.maxPct.toFixed(2)}٪ روی ${r.overlap.count} کندل مشترک). تا روشن‌شدن علت به آن اعتماد نکنید.`);
  else if (r.stored) L.push(`✅ ${r.added} کندل تازه به آرشیو اضافه شد (کندل‌های قبلی آرشیو دست نخورد).`);
  else L.push('ℹ️ حالت آزمایشی: چیزی ذخیره نشد.');
  if (r.overlap.count) L.push(`هم‌پوشانی با آرشیو فعلی: ${r.overlap.count} کندل، اختلاف میانه ${r.overlap.medianPct.toFixed(4)}٪، بیشینه ${r.overlap.maxPct.toFixed(3)}٪`);
  else L.push('هم‌پوشانی با آرشیو فعلی: ندارد (مقایسه‌ای ممکن نبود؛ بعد از چند روز اجرای ربات یا یک بک‌تست، دوباره با --dry بسنجید).');
  if (r.gaps.total) L.push(`⚠️ ${r.gaps.total} کندل در ${r.gaps.list.length >= 20 ? 'بیش از ' : ''}${r.gaps.list.length} حفره غایب است (نگهداری صرافی یا فایل خراب). اولین‌ها: ${r.gaps.list.slice(0, 3).map((g) => `${iso(g.from)} (${g.missing})`).join('، ')}`);
  if (r.dropped) L.push(`${r.dropped} کندل نامعتبر کنار گذاشته شد.`);
  if (r.missingMonths.length) L.push(`ماه‌های بدون فایل: ${r.missingMonths.join(', ')}`);
  return L.join('\n');
}

// ---------------- command line ----------------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') o.dry = true;
    else if (/^--(symbols|tf|from|to)$/.test(a)) o[a.slice(2)] = argv[++i];
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}
async function main(argv) {
  const o = parseArgs(argv);
  if (!o.symbols || !o.from) { console.log('usage: node history-import.js --symbols BINANCE:BTCUSDT,BINANCE:ETHUSDT --tf 15,60,240,D --from 2023-01 [--to 2026-09] [--dry]'); process.exit(1); }
  const tfs = String(o.tf || '15').split(',').map((x) => x.trim()).filter(Boolean);
  let bad = 0;
  for (const symbol of o.symbols.split(',').map((x) => x.trim()).filter(Boolean)) {
    for (const tf of tfs) {
      try {
        const r = await importSymbol({ symbol, tf, from: o.from, to: o.to, dry: o.dry, onProgress: (p) => process.stdout.write(`\r  ${p.symbol} ${p.tf} ${p.month}   `) });
        process.stdout.write('\r' + ' '.repeat(40) + '\r');
        console.log(reportText(r) + '\n');
        if (r.refused) bad++;
      } catch (e) { bad++; console.error(`\n${symbol} ${tf}: ${e.message}\n`); }
    }
  }
  if (bad) process.exit(2);
}

module.exports = { importSymbol, parseKlines, readZipFirstFile, crc32, findGaps, compareOverlap, monthsBetween, lastCompleteMonth, binancePair, downloadMonth, reportText, INTERVAL, STEP };
if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
