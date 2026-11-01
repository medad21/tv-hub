// /api/mt5/live/* — the live MetaTrader 5 feed (mt5-live.js) and the market structure computed on it (market-structure.js).
// Read-only: nothing here can place, change or close an order. Behind the same dashboard password as everything else.
//   GET /api/mt5/live                       folder + every file: fresh or old, which symbols and timeframes
//   GET /api/mt5/live/:symbol               price, spread, positions, account totals, clock info (add ?candles=N for the newest N closed candles per timeframe)
//   GET /api/mt5/live/:symbol/structure     swings, support/resistance zones, trend structure, break + pullback state (?tf=60&window=300)
// :symbol = the MetaTrader name (XAUUSD, XAUUSD.a) or the TradingView name (OANDA:XAUUSD).
const express = require('express');
const live = require('./mt5-live');
const ms = require('./market-structure');

const int = (v, def, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : def; };

module.exports = function mt5LiveRouter() {
  const r = express.Router();
  r.get('/', (req, res) => res.json(live.status()));

  r.get('/:symbol', (req, res) => {
    const snap = live.read(req.params.symbol);
    if (!snap.ok) return res.status(snap.error === 'NOT_FOUND' ? 404 : 422).json({ error: snap.reason, code: snap.error });
    const k = int(req.query.candles, 0, 0, 500);
    const timeframes = Object.fromEntries(Object.entries(snap.timeframes).map(([tf, t]) => [tf, {
      name: t.name, count: t.bars.length, newest: t.bars[t.bars.length - 1].time, forming: t.forming,
      ...(k ? { bars: t.bars.slice(-k) } : {}),
    }]));
    res.json({ ...snap, timeframes });
  });

  r.get('/:symbol/structure', (req, res) => {
    const tf = req.query.tf || '60';
    const b = live.bars(req.params.symbol, tf);
    if (!b.ok) return res.status(b.error === 'NOT_FOUND' ? 404 : 422).json({ error: b.reason, code: b.error });
    const window = int(req.query.window, 300, 60, 1000);
    const analysis = ms.analyze(b.bars, { window });
    res.json({
      symbol: b.symbol, tvSymbol: b.tvSymbol, tf: b.tf, timeframe: b.name,
      fresh: b.fresh, staleReason: b.staleReason, ageSec: b.ageSec, marketQuiet: b.marketQuiet, clock: b.clock,
      analysis, text: ms.describe(analysis), // text = the same numbers in plain Persian (no AI involved)
    });
  });
  return r;
};
