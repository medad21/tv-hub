// Offline checks for the historical-data import (history-import.js) and the archive backfill (candle-store.js), with a fake
// download server: zip reading, checksums, both timestamp styles, damaged files, gaps, comparison with what the bot already saw,
// "existing candles are never changed", and running it twice. Run: node test-history.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), crypto = require('crypto'), cp = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-hist-'));
process.env.CANDLE_DIR = path.join(tmp, 'candles');
const h = require('./history-import');
const store = require('./candle-store');
let passed = 0;
const ok = (c, m) => { assert(c, m); passed++; console.log('  ok  ' + m); };
const throwsWith = async (fn, re, m) => { let err = null; try { await fn(); } catch (e) { err = e; } ok(err && re.test(err.message), m + (err ? ` (${err.message})` : ' (nothing thrown)')); };
let sym = 0; const nextSym = () => `BINANCE:TEST${++sym}USDT`; // a fresh archive file for every scenario

// ---- a small zip writer, only for building test files ----
function makeZip(name, data, method = 8) {
  const raw = method === 8 ? zlib.deflateRawSync(data) : data, nm = Buffer.from(name), crc = h.crc32(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nm.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(method, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(raw.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(0, 42);
  const cdOff = 30 + nm.length + raw.length, eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + nm.length, 12); eocd.writeUInt32LE(cdOff, 16);
  return Buffer.concat([local, nm, raw, cd, nm, eocd]);
}

// ---- 1) the zip reader ----
ok(h.crc32(Buffer.from('123456789')) === 0xCBF43926, 'crc32: the standard check value');
const text = Buffer.from('1,2,3\n4,5,6\n'.repeat(500));
for (const method of [8, 0]) { const r = h.readZipFirstFile(makeZip('x.csv', text, method)); ok(r.name === 'x.csv' && r.data.equals(text), `zip: ${method === 8 ? 'deflate' : 'stored'} file is read back exactly`); }
const zbad = makeZip('x.csv', text); zbad[40] ^= 0xFF;
await_(() => h.readZipFirstFile(zbad), /damaged|incorrect|invalid|CRC|unexpected/i, 'zip: a flipped byte is rejected (never silently wrong data)');
await_(() => h.readZipFirstFile(makeZip('x.csv', text).subarray(0, 60)), /not a zip|damaged|truncated/i, 'zip: a truncated download is rejected');
await_(() => h.readZipFirstFile(Buffer.from('<html>blocked</html>')), /not a zip/, 'zip: an HTML error page instead of a zip is rejected');
function await_(fn, re, m) { let err = null; try { fn(); } catch (e) { err = e; } ok(err && re.test(err.message), m + (err ? '' : ' (nothing thrown)')); }
try { // real zip programs too (including one that streams, with a data descriptor), when the `zip` tool exists
  cp.execFileSync('zip', ['-v'], { stdio: 'ignore' });
  const f = path.join(tmp, 'real.csv'); fs.writeFileSync(f, text);
  cp.execFileSync('zip', ['-q', path.join(tmp, 'real1.zip'), 'real.csv'], { cwd: tmp });
  cp.execSync(`cat real.csv | zip -q real2.zip -`, { cwd: tmp });
  ok(h.readZipFirstFile(fs.readFileSync(path.join(tmp, 'real1.zip'))).data.equals(text) && h.readZipFirstFile(fs.readFileSync(path.join(tmp, 'real2.zip'))).data.equals(text), 'zip: files made by the real `zip` program (normal and streaming) are read back exactly');
} catch { console.log('  --  (no `zip` program here: the real-zip check was skipped)'); }

// ---- 2) the CSV ----
const row = (t, o, hi, lo, c, v = 10) => `${t},${o},${hi},${lo},${c},${v},0,0,0,0,0,0`;
const ms = h.parseKlines([row(1735689600000, 100, 101, 99, 100.5), row(1735693200000, 100.5, 102, 100, 101)].join('\n'));
const us = h.parseKlines([row(1735689600000000, 100, 101, 99, 100.5), row(1735693200000000, 100.5, 102, 100, 101)].join('\n'));
ok(ms.bars[0].time === 1735689600 && JSON.stringify(ms.bars) === JSON.stringify(us.bars), 'csv: millisecond and microsecond timestamps (Binance spot from 2025) give the same candle times');
const messy = h.parseKlines(['open_time,open,high,low,close,volume,x,x,x,x,x,x', row(1735689600000, 100, 101, 99, 100.5), row(1735693200000, 100, 99, 101, 100), row(1735696800000, 'NaN', 1, 1, 1), row(1735700400000, 100, 101, 99, 105), row(1735704000000, 0, 0, 0, 0), 'garbage'].join('\n'));
ok(messy.bars.length === 1 && messy.dropped === 4, 'csv: the header is skipped; high<low, NaN, close above high and zero prices are dropped and counted');

// ---- 3) checks ----
const hourly = (n, t0 = 1735689600) => Array.from({ length: n }, (_, i) => ({ time: t0 + i * 3600, open: 100, max: 101, min: 99, close: 100 + (i % 7) * 0.1, volume: 5 }));
const withHole = hourly(10).filter((b, i) => i !== 4 && i !== 5 && i !== 8);
const g = h.findGaps(withHole, 3600);
ok(g.total === 3 && g.list.length === 2 && g.list[0].missing === 2, 'findGaps: counts the missing candles and where');
ok(h.findGaps(hourly(50), 3600).total === 0, 'findGaps: a complete series has none');
const same = h.compareOverlap(hourly(20), hourly(20)), shifted = h.compareOverlap(hourly(20), hourly(20).map((b) => ({ ...b, close: b.close * 1.03 })));
ok(same.count === 20 && same.maxPct === 0 && !same.suspicious && shifted.suspicious && shifted.maxPct > 2.9, 'compareOverlap: identical closes are fine; 3% apart is flagged');
ok(!h.compareOverlap(hourly(5), []).suspicious && h.compareOverlap(hourly(5), []).count === 0, 'compareOverlap: nothing in common -> no comparison, no false alarm');
ok(h.monthsBetween('2024-11', '2025-02').join() === '2024-11,2024-12,2025-01,2025-02' && h.lastCompleteMonth(Date.UTC(2026, 9, 12)) === '2026-09' && h.lastCompleteMonth(Date.UTC(2026, 0, 3)) === '2025-12', 'months: ranges cross the year; the default end is the last COMPLETE month');
await_(() => h.monthsBetween('2024-13', '2025-01'), /2023-01/, 'months: a bad month is rejected with an example');
ok(h.binancePair('BINANCE:btcusdt') === 'BTCUSDT', 'binancePair: BINANCE:BTCUSDT -> BTCUSDT');
await_(() => h.binancePair('OANDA:XAUUSD'), /only Binance spot/, 'binancePair: other markets are refused clearly');

// ---- 4) a fake download server ----
const monthStart = (ym) => Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1, 1) / 1000;
const nextMonth = (ym) => { let [y, m] = ym.split('-').map(Number); m++; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}`; };
function monthCsv(ym, { micro = false, hole = [], priceBias = 1 } = {}) {
  const a = monthStart(ym), z = monthStart(nextMonth(ym)), lines = [];
  for (let t = a, i = 0; t < z; t += 3600, i++) { if (hole.includes(i)) continue; const c = (100 + (t / 3600) % 17) * priceBias; lines.push(row(micro ? t * 1e6 : t * 1e3, c, c + 1, c - 1, c)); }
  return lines.join('\n') + '\n';
}
function server(files, opts = {}) {
  const calls = []; let failOnce = opts.failOnce;
  const fetchFn = async (url) => {
    calls.push(url);
    const isSum = url.endsWith('.CHECKSUM'), zipUrl = isSum ? url.slice(0, -9) : url, ym = /-(\d{4}-\d{2})\.zip/.exec(zipUrl);
    const f = ym && files[ym[1]];
    if (failOnce && !isSum) { failOnce = false; return { ok: false, status: 503 }; }
    if (!f) return { ok: false, status: 404 };
    const zip = f.zip || makeZip('k.csv', Buffer.from(f.csv));
    if (isSum) { if (opts.noChecksum) return { ok: false, status: 404 }; const sum = f.badSum ? '0'.repeat(64) : crypto.createHash('sha256').update(zip).digest('hex'); return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(`${sum}  file.zip\n`) }; }
    return { ok: true, status: 200, arrayBuffer: async () => zip };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

(async () => {
  // ---- 5) a normal import across the 2025 timestamp change, with a month Binance does not have ----
  const S1 = nextSym();
  const files = { '2024-12': { csv: monthCsv('2024-12') }, '2025-01': { csv: monthCsv('2025-01', { micro: true }) } };
  const f1 = server(files);
  const r1 = await h.importSymbol({ symbol: S1, tf: '60', from: '2024-12', to: '2025-02', fetch: f1 });
  ok(r1.candles === 744 * 2 && r1.added === 744 * 2 && r1.stored && !r1.refused && r1.dropped === 0, 'import: two months (one with millisecond, one with microsecond timestamps) -> 1488 candles stored');
  ok(JSON.stringify(r1.missingMonths) === '["2025-02"]' && r1.gaps.total === 0, 'import: a month Binance has no file for is reported, not an error; no false gaps across the timestamp change');
  const arch = store.read(S1, '60');
  ok(arch.length === 1488 && arch.every((b, i) => i === 0 || b.time - arch[i - 1].time === 3600) && arch[0].time === monthStart('2024-12'), 'archive: sorted, one candle per hour, nothing missing, starts where the history starts');
  ok(f1.calls.some((u) => /\/data\/spot\/monthly\/klines\/TEST\d+USDT\/1h\/TEST\d+USDT-1h-2024-12\.zip$/.test(u)), 'import: the URL follows Binance\'s public archive layout (pair, interval, month)');

  // ---- 6) running it again changes nothing ----
  const r2 = await h.importSymbol({ symbol: S1, tf: '60', from: '2024-12', to: '2025-01', fetch: server(files) });
  ok(r2.added === 0 && store.read(S1, '60').length === 1488, 'import: a second run adds nothing (safe to repeat)');
  ok(r2.overlap.count === 1488 && r2.overlap.maxPct === 0 && !r2.overlap.suspicious, 'import: the second run compared against what is now stored: identical');

  // ---- 7) dry run ----
  const S2 = nextSym();
  const rd = await h.importSymbol({ symbol: S2, tf: '60', from: '2024-12', to: '2024-12', fetch: server(files), dry: true });
  ok(rd.candles === 744 && rd.added === 0 && !rd.stored && store.read(S2, '60').length === 0, 'dry run: downloads and checks, stores nothing');

  // ---- 8) a damaged download is never stored ----
  const S3 = nextSym();
  await throwsWith(() => h.importSymbol({ symbol: S3, tf: '60', from: '2024-12', to: '2024-12', fetch: server({ '2024-12': { csv: monthCsv('2024-12'), badSum: true } }) }), /checksum/, 'checksum: a download that does not match Binance\'s published checksum is rejected');
  ok(store.read(S3, '60').length === 0, 'checksum: ...and nothing reached the archive');
  const zc = makeZip('k.csv', Buffer.from(monthCsv('2024-12'))); zc[100] ^= 0x55;
  await throwsWith(() => h.importSymbol({ symbol: S3, tf: '60', from: '2024-12', to: '2024-12', fetch: server({ '2024-12': { zip: zc } }, { noChecksum: true }) }), /damaged|incorrect|invalid|CRC|unexpected/i, 'zip: with no checksum file available, the zip\'s own CRC still catches a damaged file');
  ok(store.read(S3, '60').length === 0, 'zip: ...and nothing reached the archive');

  // ---- 9) a flaky network ----
  const S4 = nextSym();
  const rf = await h.importSymbol({ symbol: S4, tf: '60', from: '2024-12', to: '2024-12', fetch: server(files, { failOnce: true }) });
  ok(rf.candles === 744 && rf.stored, 'network: one temporary server error (HTTP 503) is retried and the import succeeds');

  // ---- 10) gaps are reported ----
  const S5 = nextSym();
  const rg = await h.importSymbol({ symbol: S5, tf: '60', from: '2024-12', to: '2024-12', fetch: server({ '2024-12': { csv: monthCsv('2024-12', { hole: [10, 11, 12, 300] }) } }) });
  ok(rg.gaps.total === 4 && rg.gaps.list.length === 2 && /حفره/.test(h.reportText(rg)), 'gaps: four missing candles in two places are reported (and still stored; nothing is invented to fill them)');

  // ---- 11) what the bot already saw is never changed, and a source that disagrees is refused ----
  const S6 = nextSym();
  const t0 = monthStart('2024-12');
  const seen = Array.from({ length: 24 }, (_, i) => { const t = t0 + 100 * 3600 + i * 3600, c = 100 + (t / 3600) % 17; return { time: t, open: c, max: c + 1, min: c - 1, close: c, volume: 777 }; });
  store.merge(S6, '60', seen);
  const r6 = await h.importSymbol({ symbol: S6, tf: '60', from: '2024-12', to: '2024-12', fetch: server(files) });
  const after = store.read(S6, '60');
  ok(r6.stored && r6.overlap.count === 24 && !r6.overlap.suspicious && r6.added === 744 - 24 && after.length === 744, 'archive: candles the bot already stored are not added again (744 total, 720 new)');
  ok(after.filter((b) => b.volume === 777).length === 24, 'archive: ...and those 24 keep exactly what the bot saw (the import never rewrites them)');
  const S7 = nextSym();
  store.merge(S7, '60', seen.map((b) => ({ ...b, close: b.close * 1.05, max: b.max * 1.05, min: b.min * 1.05, open: b.open * 1.05 })));
  const r7 = await h.importSymbol({ symbol: S7, tf: '60', from: '2024-12', to: '2024-12', fetch: server(files) });
  ok(r7.refused && !r7.stored && r7.added === 0 && store.read(S7, '60').length === 24 && /ذخیره نشد/.test(h.reportText(r7)), 'safety: history that is 5% off the candles the bot itself saw is refused, nothing is stored, and the report says why');

  // ---- 12) backfill + the live append keep working together, and backtests see the longer history ----
  const S8 = nextSym();
  const recent = hourly(20, monthStart('2025-03')), older = hourly(30, monthStart('2025-03') - 30 * 3600);
  store.merge(S8, '60', recent);
  ok(store.backfill(S8, '60', older) === 30 && store.read(S8, '60').length === 50 && store.read(S8, '60')[0].time === older[0].time, 'backfill: older candles go in front of what the archive already had');
  const next = hourly(5, recent[19].time + 3600);
  ok(store.merge(S8, '60', next) === 5 && store.read(S8, '60').length === 55, 'merge: the bot\'s normal appending still works after a backfill');
  ok(store.backfill(S8, '60', [...older, ...recent]) === 0, 'backfill: candles already there are ignored');
  const combined = store.combine(S8, '60', recent.slice(-5), 100);
  ok(combined.length === 55 && combined[0].time === older[0].time, 'combine: a backtest that downloads only recent candles still gets the longer archived history in front');

  // ---- 13) input checks ----
  await throwsWith(() => h.importSymbol({ symbol: 'OANDA:XAUUSD', tf: '60', from: '2024-12', fetch: server(files) }), /only Binance spot/, 'input: a non-Binance symbol is refused with a clear message');
  await throwsWith(() => h.importSymbol({ symbol: S1, tf: '7', from: '2024-12', fetch: server(files) }), /not supported/, 'input: an unsupported timeframe is refused');

  console.log(`\n${passed} history-import checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
