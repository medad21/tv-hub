// Permanent, growing candle archive. The TradingView feed only ever hands out the last few thousand candles, so history cannot be
// bought back later — but every candle the running bot sees (and every backtest download) is kept here, one file per symbol+timeframe,
// so the history that backtests and the evidence check can use gets LONGER the longer the program runs.
//   <DATA_DIR>/candles/<SYMBOL>_<tf>.jsonl   one closed candle per line: [time, open, high, low, close, volume]   (time = seconds)
// It only ever ADDS candles (never rewrites old ones). It stores raw market data only: no learning, no model — see the README.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fsutil');

const dir = () => process.env.CANDLE_DIR || path.join(process.env.DATA_DIR || __dirname, 'candles');
const file = (symbol, tf) => path.join(dir(), `${String(symbol).replace(/[^A-Za-z0-9]/g, '_')}_${tf}.jsonl`);
const lastSeen = new Map(); // file -> time of the newest candle on disk (read once, then kept in memory)

const toRow = (b) => [b.time, b.open, b.max, b.min, b.close, b.volume || 0];
const fromRow = (r) => ({ time: r[0], open: r[1], max: r[2], min: r[3], close: r[4], volume: r[5] });
const valid = (b) => b && Number.isFinite(b.time) && [b.open, b.max, b.min, b.close].every(Number.isFinite) && b.max >= b.min;

function newest(f) {
  if (lastSeen.has(f)) return lastSeen.get(f);
  let t = 0;
  try {
    const size = fs.statSync(f).size, fd = fs.openSync(f, 'r'), len = Math.min(size, 4096), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && !t; i--) { try { const r = JSON.parse(lines[i]); if (Array.isArray(r) && Number.isFinite(r[0])) t = r[0]; } catch {} }
  } catch {}
  lastSeen.set(f, t);
  return t;
}

// Adds the CLOSED candles in `bars` that are newer than what is stored. `bars` = oldest first, closed candles only
// (pass the list without the still-forming last candle). Returns how many were added.
function merge(symbol, tf, bars) {
  try {
    const f = file(symbol, tf), last = newest(f);
    if (bars.length && bars[bars.length - 1].time <= last) return 0; // nothing new (this runs on every price update, so bail out early)
    const fresh = bars.filter((b) => valid(b) && b.time > last).sort((a, b) => a.time - b.time);
    if (!fresh.length) return 0;
    fs.mkdirSync(dir(), { recursive: true });
    fs.appendFileSync(f, fresh.map((b) => JSON.stringify(toRow(b))).join('\n') + '\n');
    lastSeen.set(f, fresh[fresh.length - 1].time);
    return fresh.length;
  } catch (e) { console.error('candle-store:', e.message); return 0; }
}

// Adds OLDER (or any missing) candles from an outside source (history-import.js). merge() above only ever appends candles newer than
// the newest stored one, so it cannot take history that lies before what the bot already archived; this can. Candles already in the
// archive are never changed (what the bot itself saw wins); only times that are missing are added, then the file is replaced
// atomically (the old file stays whole if anything goes wrong). Returns how many candles were added.
// Run the import while the bot is stopped or idle: a candle the bot appends in the few milliseconds of the swap could be lost
// (it would simply be re-added the next time the feed shows it, so nothing permanent is at stake).
function backfill(symbol, tf, bars) {
  const f = file(symbol, tf), have = new Map(read(symbol, tf).map((b) => [b.time, b]));
  let added = 0;
  for (const b of bars) if (valid(b) && !have.has(b.time)) { have.set(b.time, b); added++; }
  if (!added) return 0;
  const all = [...have.values()].sort((a, b) => a.time - b.time);
  fs.mkdirSync(dir(), { recursive: true });
  atomicWrite(f, all.map((b) => JSON.stringify(toRow(b))).join('\n') + '\n');
  lastSeen.set(f, all[all.length - 1].time);
  return added;
}

function read(symbol, tf) {
  try {
    return fs.readFileSync(file(symbol, tf), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => Array.isArray(r) && Number.isFinite(r[0]))
      .map(fromRow).sort((a, b) => a.time - b.time).filter((b, i, a) => i === 0 || b.time !== a[i - 1].time);
  } catch { return []; }
}

// Downloaded candles (newest data, from the feed) combined with the archive: the archive supplies the older part the feed no longer
// offers, the download wins wherever both have the same candle. Returns up to `n` newest candles, oldest first.
function combine(symbol, tf, downloaded, n) {
  const old = read(symbol, tf);
  if (!old.length) return downloaded;
  const m = new Map(old.map((b) => [b.time, b]));
  for (const b of downloaded) m.set(b.time, b);
  const all = [...m.values()].sort((a, b) => a.time - b.time);
  return n ? all.slice(-n) : all;
}

// What is archived, for the dashboard: per file the number of candles and the date range.
function summary() {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((x) => x.endsWith('.jsonl')); } catch {}
  return names.map((name) => {
    const rows = fs.readFileSync(path.join(dir(), name), 'utf8').split('\n').filter(Boolean);
    let first = null, last = null;
    try { first = JSON.parse(rows[0])[0]; last = JSON.parse(rows[rows.length - 1])[0]; } catch {}
    return { file: name.replace(/\.jsonl$/, ''), candles: rows.length, from: first, to: last };
  });
}

const _reset = () => lastSeen.clear(); // tests only
module.exports = { merge, backfill, read, combine, summary, dir, _reset };
