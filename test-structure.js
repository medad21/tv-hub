// Offline checks for market-structure.js (swings, support/resistance zones, trend structure, break + pullback) and for how it is
// offered to strategies (ctx.structure / ctx.swingHigh / ctx.swingLow) and to plain-words rules (swing_high / swing_low).
// Synthetic candles only: every expected number below comes from a path whose turning points are known. Run: node test-structure.js
const assert = require('assert');
const ms = require('./market-structure');
const { atr, makeCtx } = require('./strategy');
const rules = require('./rules');
let passed = 0;
const ok = (c, msg) => { assert(c, msg); passed++; console.log('  ok  ' + msg); };

// a price path through waypoints [[price, bars], ...] (first entry = start price); small deterministic wicks
function path(wp, t0 = 1700000000, step = 3600) {
  const bars = []; let prev = wp[0][0], t = t0;
  for (const [target, n] of wp.slice(1)) {
    for (let i = 1; i <= n; i++) {
      const c = prev + (target - prev) * (i / n), w = 0.25 + 0.1 * ((bars.length * 7) % 3);
      bars.push({ time: t, open: prev, max: Math.max(prev, c) + w, min: Math.min(prev, c) - w, close: c, volume: 100 });
      prev = c; t += step;
    }
  }
  return bars;
}
const stretch = (wp, k = 2) => wp.map(([p, c], i) => (i ? [p, c * k] : [p, c])); // more candles for the same turning points (analyze() needs 50+)
const RANGE = [[100, 0], [110, 10], [102, 8], [110, 8], [102, 8], [110.1, 8], [102.5, 8]]; // a range 102..110, resistance tested three times
const BREAK = [...RANGE, [112, 6]];                                                         // closes above 110.6 on the way up
const state = (wp) => { const a = ms.analyze(path(wp)); return a.ok ? a.setups.filter((s) => s.dir === 'up').map((s) => s.state) : null; };

// ---- basics ----
const bars = path(BREAK);
ok(Math.abs(ms.atrOf(bars, 14) - atr(bars, 14)) < 1e-12, 'ATR here equals strategy.atr (same numbers everywhere)');
const n = bars.length, p3 = ms.pivots(bars, 3);
ok(p3.length >= 6 && p3.every((q) => q.confirmedAt === q.index + 3 && q.confirmedAt <= n - 1), 'a pivot is only known `strength` candles after it (no look-ahead): confirmedAt <= last candle');
ok(!p3.some((q) => q.index > n - 1 - 3), 'the newest `strength` candles can never be pivots');
const half = bars.slice(0, 40), pHalf = ms.pivots(half, 3), key = (q) => `${q.type}${q.index}${q.price}`;
const fullKeys = new Set(p3.map(key));
ok(pHalf.length > 0 && pHalf.every((q) => fullKeys.has(key(q))), 'pivots known at candle 40 are still the same pivots later (they never move or vanish when new candles arrive)');
const flat = [{ time: 1, open: 5, max: 5, min: 4, close: 4.5 }, { time: 2, open: 4.5, max: 6, min: 4, close: 5 }, { time: 3, open: 5, max: 7, min: 5, close: 6 }, { time: 4, open: 6, max: 9, min: 6, close: 8 }, { time: 5, open: 8, max: 9, min: 6, close: 7 }, { time: 6, open: 7, max: 9, min: 6, close: 7 }, { time: 7, open: 7, max: 8, min: 6, close: 7 }, { time: 8, open: 7, max: 8, min: 6, close: 7 }];
ok(ms.pivots(flat, 2).filter((q) => q.type === 'high').map((q) => q.index).join() === '3', 'of two equal highs the FIRST one is the pivot');
ok(ms.lastPivot(bars, 'high', 3) !== null && ms.lastPivot(bars.slice(0, 5), 'high', 3) === null, 'lastPivot: a price once a swing exists, null before');

// ---- swings ----
const sw = ms.swings(bars, {});
ok(sw.length >= 5 && sw.every((s, i) => i === 0 || s.type !== sw[i - 1].type), 'swings alternate high / low / high ...');
const a0 = ms.atrOf(bars, 14);
ok(sw.every((s, i) => i === 0 || Math.abs(s.price - sw[i - 1].price) >= a0 * 0.999), 'every swing is at least 1 ATR away from the one before (noise is dropped)');

// ---- zones ----
const aR = ms.analyze(path(RANGE));
ok(aR.ok && aR.n === 50 && aR.price > 102 && aR.price < 103.5, 'analyze() on a range: ok, last close read correctly');
const zr = aR.zones.find((z) => Math.abs(z.price - 110.4) < 0.5), zs = aR.zones.find((z) => Math.abs(z.price - 101.8) < 0.6);
ok(zr && zr.kind === 'resistance' && zr.touches === 3 && !zr.flipped, 'resistance zone found near 110 with 3 touches (never worked as support)');
ok(zs && zs.kind === 'support' && zs.touches === 2, 'support zone found near 102 with 2 confirmed touches (the third low is the last candle: not confirmed yet)');
const zs3 = ms.analyze(bars).zones.find((z) => Math.abs(z.price - 101.8) < 0.6);
ok(zs3 && zs3.touches === 3, 'one candle-run later the third low is confirmed: 3 touches');
ok(zr.low < zr.price && zr.price < zr.high && zr.high - zr.low >= 0.15 * aR.atr - 1e-9, 'a zone has height (never a one-line level) and contains its own price');
ok(aR.nearest.resistance === aR.zones.find((z) => z.price === zr.price) || (aR.nearest.resistance && Math.abs(aR.nearest.resistance.price - zr.price) < 1e-9), 'nearest resistance = the zone above price');
ok(aR.zones.every((z) => z.strength >= 0 && z.strength <= 100) && aR.zones.every((z, i) => i === 0 || z.price <= aR.zones[i - 1].price), 'strength is 0..100 and zones are listed top -> bottom');
ok(aR.zones.every((z) => !('lastIndex' in z) && !('firstHighIndex' in z)), 'internal candle numbers are not part of the public result');
ok(aR.nearest.resistance.distAtr > 3 && aR.nearest.support.distAtr >= 0, 'distance to the zones is given in ATR');

// ---- structure ----
const up = ms.analyze(path(stretch([[100, 0], [105, 6], [102, 5], [110, 8], [106, 5], [115, 8], [111, 5], [120, 8], [118, 3]])));
const down = ms.analyze(path(stretch([[120, 0], [115, 6], [118, 5], [110, 8], [114, 5], [105, 8], [109, 5], [100, 8], [102, 3]])));
ok(up.structure.trend === 'up' && up.structure.highs.every((l) => l === 'HH') && up.structure.lows.every((l) => l === 'HL'), 'higher highs + higher lows = up');
ok(down.structure.trend === 'down' && down.structure.highs.every((l) => l === 'LH') && down.structure.lows.every((l) => l === 'LL'), 'lower highs + lower lows = down');
ok(aR.structure.trend === 'range', 'equal highs and equal lows = range');
const bosUp = ms.analyze(path(stretch([[100, 0], [105, 6], [102, 5], [110, 8], [106, 5], [115, 8], [111, 5], [118, 6]])));
ok(bosUp.structure.trend === 'up' && bosUp.structure.break && bosUp.structure.break.type === 'bos_up', 'close above the last swing high in an uptrend = break of structure (continuation)');
const choch = ms.analyze(path(stretch([[120, 0], [115, 6], [118, 5], [110, 8], [114, 5], [105, 8], [109, 5], [116, 8]])));
ok(choch.structure.trend === 'down' && choch.structure.break && choch.structure.break.type === 'choch_up', 'close above the last lower high in a downtrend = change of character (first sign of a turn)');

// ---- break + pullback ----
ok(JSON.stringify(state(BREAK)) === '["broke"]', 'closed above resistance, no pullback yet -> broke');
ok(JSON.stringify(state([...BREAK, [110.3, 3]])) === '["pullback"]', 'came back to the zone, no confirmation candle -> pullback');
ok(JSON.stringify(state([...BREAK, [110.3, 3], [116, 5]])) === '["confirmed"]', 'came back and bounced with a bullish close above the zone -> confirmed (the bounce is NOT counted as a second break)');
ok(JSON.stringify(state([...BREAK, [107, 4]])) === '["failed"]', 'closed back below the zone -> failed (false break)');
const conf = ms.analyze(path([...BREAK, [110.3, 3], [116, 5]])).setups[0];
ok(conf.pullbackBarsAgo > conf.confirmedBarsAgo && conf.breakBarsAgo > conf.pullbackBarsAgo, 'order in time: break, then pullback, then confirmation');
ok(conf.invalidation < conf.zone.low && conf.extendedAtr > 2, 'invalidation sits just below the zone; extendedAtr tells how far price already ran');
ok(!ms.analyze(path(BREAK)).setups.some((s) => Math.abs(s.zone.price - 101.8) < 0.6), 'a bounce off support is not reported as a resistance break');
ok(ms.analyze(path(BREAK)).setups.every((s) => s.dir === 'up'), 'only real breaks are reported (no invented breakdowns)');
const brkDown = ms.analyze(path([[120, 0], [110, 10], [118, 8], [110.1, 8], [118, 8], [110, 8], [118, 8], [108, 5], [109.7, 3], [105, 5]]));
ok(brkDown.setups.some((s) => s.dir === 'down' && s.state === 'confirmed'), 'mirror case: support broken downward, pullback up to it, bearish close -> confirmed (dir down; the bot is long-only so this is information)');
const stale = ms.analyze(path([...BREAK, [114, 20], [114.5, 30]]));
ok(stale.ok && stale.setups.length === 0, 'a break that is more than maxBreakAge (40) candles old is no longer reported');
const young = ms.analyze(path([...BREAK, [114, 20]]));
ok(young.setups.length === 1 && young.setups[0].breakBarsAgo <= ms.DEFAULTS.maxBreakAge, 'a break younger than that still is');

// ---- what it knew at the time ----
const full = path([...BREAK, [110.3, 3], [116, 5]]), k = 58;
const early = ms.analyze(full.slice(0, k));
ok(early.setups[0].state === 'broke' || early.setups[0].state === 'pullback', 'at candle 58 the setup is not yet "confirmed" (it did not know the future)');

// ---- bad data never throws ----
ok(ms.analyze([]).ok === false && ms.analyze(null).ok === false && ms.analyze(undefined).ok === false, 'nothing / null / undefined -> ok:false with a reason, no exception');
ok(/کافی نیست/.test(ms.analyze(bars.slice(0, 30)).reason), 'too few candles -> a clear reason');
const dirty = bars.slice(); dirty[10] = { time: NaN, open: 1, max: 1, min: 1, close: 1 }; dirty[20] = null; dirty[30] = { time: 1, open: 'x', max: 1, min: 1, close: 1 };
ok(ms.analyze(dirty).ok === true, 'broken candles are skipped, the rest is analysed');
ok(ms.analyze(Array.from({ length: 80 }, (_, i) => ({ time: i, open: 5, max: 5, min: 5, close: 5, volume: 0 }))).ok === false, 'a dead flat price (ATR 0) -> ok:false, no division by zero');

// ---- plain Persian text ----
const text = ms.describe(ms.analyze(path([...BREAK, [110.3, 3]])));
ok(Array.isArray(text) && text.length >= 3 && text.every((l) => typeof l === 'string' && !/undefined|NaN|null/.test(l)), 'describe(): plain Persian lines, no undefined/NaN');
ok(text.some((l) => l.includes('پولبک')) && text.some((l) => l.includes('ابطال')), 'describe(): mentions the pullback state and the invalidation level');
ok(ms.describe({ ok: false, reason: 'x' })[0] === 'x' && ms.describe(null).length === 1, 'describe(): handles a failed analysis');

// ---- strategies (ctx) ----
const ctx = makeCtx(bars), sIn = ctx.structure();
ok(sIn.ok && sIn.zones.length === ms.analyze(bars).zones.length, 'ctx.structure() = analyze() on the candles the strategy can see');
ok(ctx.swingHigh(3) === ms.lastPivot(bars, 'high', 3) && ctx.swingLow(3) === ms.lastPivot(bars, 'low', 3), 'ctx.swingHigh / swingLow = last confirmed swing price');
ok(ctx.structure() === ctx.structure(), 'ctx.structure() is computed once per candle (memoized)');
const early2 = makeCtx(bars, 30);
ok(ms.analyze(bars.slice(0, 31)).ok === false && early2.structure().ok === false, 'ctx at candle 30 only sees candles up to 30 (too few -> ok:false)');
let threw = false; try { ctx.swingHigh(0); } catch { threw = true; }
ok(threw, 'ctx.swingHigh(0) is rejected like any bad period');

// ---- plain-words rules: swing_high / swing_low ----
const rl = rules.validateRules({ entry: { left: { ind: 'close' }, op: 'crosses_above', right: { ind: 'swing_high', strength: 3 } }, exit: { left: { ind: 'close' }, op: 'crosses_below', right: { ind: 'swing_low' } } });
ok(rl.entry.right.strength === 3 && rl.exit.right.strength === 3, 'rules accept swing_high / swing_low (strength defaults to 3)');
ok(rules.describeRules(rl).entry.includes('آخرین سقف') && rules.describeRules(rl).exit.includes('آخرین کف'), 'rules describe them in plain Persian');
let bad = ''; try { rules.validateRules({ entry: { left: { ind: 'close' }, op: '>', right: { ind: 'swing_high', strength: 0 } } }); } catch (e) { bad = e.message; }
ok(bad.includes('strength'), 'rules reject strength 0');
const sig = rules.makeSignal(rl), buys = [];
for (let i = 0; i < bars.length; i++) if (sig(makeCtx(bars, i)) === 'buy') buys.push(i);
ok(buys.length >= 1 && buys[0] >= 50 && buys[0] <= 55, 'the rule "close crosses above the last swing high" fires on the breakout candle, not during the range');
const bi = buys[0], hiBefore = ms.lastPivot(bars.slice(0, bi), 'high', 3), hiNow = ms.lastPivot(bars.slice(0, bi + 1), 'high', 3);
ok(bars[bi].close > hiNow && bars[bi - 1].close <= hiBefore, 'that candle is the first close above the swing high that was known before it');

// ---- speed (the backtester calls this once per candle) ----
const big = path([[100, 0], ...Array.from({ length: 60 }, (_, i) => [100 + ((i * 37) % 17) - 8, 5])]), t0 = Date.now();
for (let i = 0; i < 100; i++) ms.analyze(big.slice(0, 300 - (i % 3)));
const per = (Date.now() - t0) / 100;
ok(per < 25, `analyze() on 300 candles takes ${per.toFixed(2)} ms (< 25 ms)`);

console.log(`\n${passed} checks passed`);
