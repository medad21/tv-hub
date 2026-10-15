// Alpaca (US stocks) REST client. Docs: https://docs.alpaca.markets
// ALPACA_PAPER=NO switches to the live money endpoint; default is paper.
const BASE = () => (process.env.ALPACA_PAPER === 'NO' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets');
const enabled = () => !!(process.env.ALPACA_KEY && process.env.ALPACA_SECRET);
const headers = () => ({
  'APCA-API-KEY-ID': process.env.ALPACA_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET,
  'Content-Type': 'application/json',
});

async function call(method, path, body) {
  const r = await fetch(BASE() + path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!r.ok) throw new Error(data.message || `${r.status}`);
  return data;
}

async function waitFilled(id) {
  for (let i = 0; i < 10; i++) {
    const o = await call('GET', `/v2/orders/${id}`);
    if (o.status === 'filled') return o;
    if (['canceled', 'rejected', 'expired'].includes(o.status)) throw new Error(`order ${o.status}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('order not filled in time');
}

// Market entry as a bracket order: Alpaca also places the stop-loss and take-profit as
// working orders at the broker, so the position stays protected even if this bot is offline.
async function buy(ticker, qty, sl, tp) {
  const o = await call('POST', '/v2/orders', {
    symbol: ticker, qty: qty.toFixed(4), side: 'buy', type: 'market', time_in_force: 'day',
    order_class: 'bracket',
    take_profit: { limit_price: tp.toFixed(2) },
    stop_loss: { stop_price: sl.toFixed(2) },
  });
  const filled = await waitFilled(o.id);
  return { qty: Number(filled.filled_qty), fill: Number(filled.filled_avg_price) };
}

// Closes the whole position at market (this also cancels the bracket's SL/TP legs).
// If the position is already gone (the broker's own stop or target already fired),
// returns {closedByBroker:true} instead of throwing.
async function closeAll(ticker) {
  try {
    const o = await call('DELETE', `/v2/positions/${ticker}`);
    if (o && o.id) { const f = await waitFilled(o.id); return { qty: Math.abs(Number(f.filled_qty)), fill: Number(f.filled_avg_price) }; }
    return { qty: null, fill: null };
  } catch (e) {
    if (/position does not exist/i.test(e.message)) return { closedByBroker: true };
    throw e;
  }
}

// Open positions as { TICKER: qty } — used at startup to check that what state.json says we hold really exists at the broker.
async function positions() {
  const list = await call('GET', '/v2/positions');
  const out = {};
  for (const x of Array.isArray(list) ? list : []) out[x.symbol] = Number(x.qty) || 0;
  return out;
}

module.exports = { enabled, buy, closeAll, positions };
