// Shared risk math, used by both the live bot and the backtester so a backtest
// report actually reflects what the live bot would have done.
const { group } = require('./symbols');

// Fee/slippage (per side, %) for ONE symbol: the market's own numbers from risk.costs, else the flat feePct/slippagePct.
function costsFor(symbol, R) {
  const g = group(symbol), c = g && R.costs && R.costs[g];
  return { feePct: c && c.feePct != null ? c.feePct : R.feePct, slippagePct: c && c.slippagePct != null ? c.slippagePct : R.slippagePct };
}

// Position size for a new entry.
//   - base size: risk a fixed % of equity, sized by distance to the stop (ATR x mult)
//   - volAdaptive: when a symbol's own volatility (ATR as % of price) is unusually
//     high, the stop is far away, so the ATR-based size is already smaller — but on
//     genuinely violent symbols we additionally shrink the risked % itself, since a
//     single ATR reading understates how choppy the stop-to-stop path can get.
//   - still capped by maxPositionPct of equity and by available cash.
function sizePosition({ equity, cash, price, atrVal, R }) {
  const dist = atrVal * R.atrMult;
  let riskPct = R.riskPerTradePct;
  let volAdapted = false;
  if (R.volAdaptive && price > 0) {
    const atrPct = (atrVal / price) * 100;
    if (atrPct > R.volAdaptiveAtrPct) { riskPct *= R.volAdaptiveFactor; volAdapted = true; }
  }
  const cost = 1 + (R.feePct + R.slippagePct) / 100;
  const qty = Math.min(
    (equity * riskPct / 100) / dist,
    (equity * R.maxPositionPct / 100) / price,
    cash / (price * cost),
  );
  return { qty, dist, riskPct, volAdapted };
}

// Total equity currently committed to positions in the same correlation group
// (crypto / stock / forex) as `symbol`, as a % of equity. Positions in the same
// group tend to rise and fall together, so this is a truer risk measure than
// looking at each symbol in isolation.
function groupExposurePct(positions, prices, symbol, equity) {
  const g = group(symbol);
  if (!g || !equity) return { group: g, pct: 0 };
  let sum = 0;
  for (const [s, p] of Object.entries(positions)) {
    if (group(s) === g) sum += p.qty * (prices[s] ?? p.entry);
  }
  return { group: g, pct: (sum / equity) * 100 };
}

// Would adding `addUsd` of new exposure in `symbol`'s group breach the cap?
// Returns a reason string if blocked, else null.
function groupBlockReason(positions, prices, symbol, equity, addUsd, R) {
  const caps = R.groupExposure;
  if (!caps) return null;
  const { group: g, pct } = groupExposurePct(positions, prices, symbol, equity);
  if (!g) return null;
  const cap = caps[g];
  if (cap == null) return null;
  const afterPct = pct + (addUsd / equity) * 100;
  if (afterPct > cap) return `${g} exposure cap (${pct.toFixed(1)}% -> ${afterPct.toFixed(1)}% > ${cap}%)`;
  return null;
}

module.exports = { costsFor, sizePosition, groupExposurePct, groupBlockReason };
