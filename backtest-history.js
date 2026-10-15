// Local, append-only log of past backtest/sweep runs — so changing a setting in config.js
// (e.g. minConfirm, a new symbol) can be compared against what you got before, without
// having to remember numbers or re-run everything.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fsutil');

const FILE = process.env.BT_HISTORY_FILE || path.join(process.env.DATA_DIR || __dirname, 'backtest-history.log'); // DATA_DIR = Docker volume
const MAX_KEEP = 200; // oldest runs beyond this are dropped on the next save, to keep the file small

function readAll() {
  try {
    return fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function save({ kind, opts, report }) {
  const all = readAll();
  const rec = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, time: Date.now(), kind, opts, report };
  all.push(rec);
  atomicWrite(FILE, all.slice(-MAX_KEEP).map((r) => JSON.stringify(r)).join('\n') + '\n');
  return rec;
}

// Lightweight rows for the history table (full report only fetched when one is opened).
function list() {
  return readAll().map((r) => ({
    id: r.id, time: r.time, kind: r.kind, opts: r.opts,
    summary: r.kind === 'backtest' ? r.report.summary : null,
    top1: r.kind === 'sweep' ? r.report.top[0] : null,
  })).sort((a, b) => b.time - a.time);
}

function get(id) {
  return readAll().find((r) => r.id === id) || null;
}

function clear() {
  try { fs.unlinkSync(FILE); } catch {}
}

module.exports = { save, list, get, clear };
