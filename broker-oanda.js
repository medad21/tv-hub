// OANDA v20 (forex / metals) REST client. Docs: https://developer.oanda.com/rest-live-v20
// OANDA_PRACTICE=NO switches to the live money endpoint; default is the practice (demo) account.
const BASE = () => (process.env.OANDA_PRACTICE === 'NO' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com');
const enabled = () => !!(process.env.OANDA_TOKEN && process.env.OANDA_ACCOUNT_ID);
const headers = () => ({ Authorization: `Bearer ${process.env.OANDA_TOKEN}`, 'Content-Type': 'application/json' });

async function call(method, path, body) {
  const r = await fetch(BASE() + path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.errorMessage || `${r.status}`);
  return data;
}

// Market order with stop-loss and take-profit attached at the broker (protects the position
// even if this bot goes offline). `units` must be a whole number of the base currency.
async function buy(instrument, units, sl, tp) {
  const acc = process.env.OANDA_ACCOUNT_ID;
  const data = await call('POST', `/v3/accounts/${acc}/orders`, {
    order: {
      type: 'MARKET', instrument, units: String(Math.max(1, Math.round(units))), timeInForce: 'FOK', positionFill: 'DEFAULT',
      stopLossOnFill: { price: sl.toFixed(5) }, takeProfitOnFill: { price: tp.toFixed(5) },
    },
  });
  const fill = data.orderFillTransaction;
  if (!fill) throw new Error(data.orderCancelTransaction ? `order rejected: ${data.orderCancelTransaction.reason}` : 'order not filled');
  return { qty: Number(fill.units), fill: Number(fill.price) };
}

// Closes the whole long position at market. If it is already gone (the broker's own
// stop or target already fired), returns {closedByBroker:true} instead of throwing.
async function closeLong(instrument) {
  try {
    const acc = process.env.OANDA_ACCOUNT_ID;
    const data = await call('PUT', `/v3/accounts/${acc}/positions/${instrument}/close`, { longUnits: 'ALL' });
    const fill = data.longOrderFillTransaction;
    if (!fill) throw new Error('close not filled');
    return { qty: Math.abs(Number(fill.units)), fill: Number(fill.price) };
  } catch (e) {
    if (/CLOSEOUT_POSITION_DOESNT_EXIST/i.test(e.message)) return { closedByBroker: true };
    throw e;
  }
}

// Open long units as { EUR_USD: units } — used at startup to check state.json against the broker.
async function positions() {
  const data = await call('GET', `/v3/accounts/${process.env.OANDA_ACCOUNT_ID}/openPositions`);
  const out = {};
  for (const x of data.positions || []) out[x.instrument] = Number(x.long && x.long.units) || 0;
  return out;
}

module.exports = { enabled, buy, closeLong, positions };
