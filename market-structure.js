// Market structure: swing highs/lows, support/resistance ZONES, trend structure (HH/HL/LH/LL, break of structure) and the
// "break a level -> pull back to it -> confirm" setup. Pure functions on candles — no I/O, no network, no AI.
//
// Candles: oldest -> newest, CLOSED candles only: [{ time, open, max, min, close, volume }] (the same shape everywhere in tv-hub).
//
// NO LOOK-AHEAD. A swing high needs `right` candles after it that are all lower, so it is only KNOWN `right` candles later
// (`confirmedBarsAgo`). The newest `right` candles can never be pivots. Everything here uses only the candles it is given, so
// analyze(bars.slice(0, k)) is exactly what you would have known at candle k (backtests can call it candle by candle).
//
// This module decides NOTHING about trading. It measures: where the levels are, what the structure looks like, in which state a
// break/pullback is. A strategy, the signal card or the AI analyst then uses those numbers (the AI must never invent them).

const DEFAULTS = {
  window: 300,        // look at the newest N candles only (the same WINDOW the strategies and the backtester use)
  strength: 3,        // a pivot is the highest high / lowest low of `strength` candles on each side
  atrPeriod: 14,
  minMoveAtr: 1.0,    // a swing counts only if price moved at least this many ATR away from the previous opposite swing (noise filter)
  clusterAtr: 0.5,    // pivots closer than this many ATR belong to the same zone
  minZoneAtr: 0.15,   // a zone is never thinner than this (a one-line level is not tradable)
  minTouches: 2,      // a zone needs at least this many pivots
  maxZones: 8,
  halfLifeBars: 120,  // a zone untouched for this many candles counts half as much
  bufferAtr: 0.1,     // a close must be this far beyond the zone to count as a real break
  touchAtr: 0.15,     // a low/high within this distance of the zone edge counts as "pulled back to the zone"
  maxBreakAge: 40,    // ignore breaks older than this many candles
  approachBars: 10,   // before a break, price must have been on the other side of the zone for this many candles (else it is a bounce)
};
const MIN_BARS = 50;

const opt = (o) => ({ ...DEFAULTS, ...(o || {}) });
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const median = (a) => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Wilder ATR — the same numbers as strategy.atr (a test checks that); kept here so this file needs no other file.
function atrOf(bars, n = 14) {
  if (bars.length <= n) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const { max: h, min: l } = bars[i], pc = bars[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

const cleanBars = (bars) => (Array.isArray(bars) ? bars : []).filter((b) => b && finite(b.time) && finite(b.open) && finite(b.max) && finite(b.min) && finite(b.close));

// ---------------------------------------------------------------------------------------------------------------------
// 1. pivots (fractals). Left side strictly lower, right side lower-or-equal: of two equal highs the FIRST one is the pivot.
// Returns [{ type:'high'|'low', index, price, confirmedAt }] sorted by index (a candle that is both, goes in the order it moved).
function pivots(bars, strength = 3) {
  const n = bars.length, out = [];
  for (let i = strength; i < n - strength; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= strength && (hi || lo); j++) {
      if (!(bars[i].max > bars[i - j].max) || !(bars[i].max >= bars[i + j].max)) hi = false;
      if (!(bars[i].min < bars[i - j].min) || !(bars[i].min <= bars[i + j].min)) lo = false;
    }
    const H = hi && { type: 'high', index: i, price: bars[i].max, confirmedAt: i + strength };
    const L = lo && { type: 'low', index: i, price: bars[i].min, confirmedAt: i + strength };
    if (H && L) { if (bars[i].close >= bars[i].open) out.push(L, H); else out.push(H, L); } // bullish candle: low first, then high
    else if (H) out.push(H);
    else if (L) out.push(L);
  }
  return out;
}

// The last CONFIRMED pivot price of one kind (what a rule like "close crosses above the last swing high" needs). null = none yet.
function lastPivot(bars, type, strength = 3) {
  const n = bars.length;
  for (let i = n - 1 - strength; i >= strength; i--) {
    let ok = true;
    for (let j = 1; j <= strength && ok; j++) {
      if (type === 'high') { if (!(bars[i].max > bars[i - j].max) || !(bars[i].max >= bars[i + j].max)) ok = false; }
      else if (!(bars[i].min < bars[i - j].min) || !(bars[i].min <= bars[i + j].min)) ok = false;
    }
    if (ok) return type === 'high' ? bars[i].max : bars[i].min;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. swings = pivots made alternating (high, low, high, ...) and meaningful: two highs in a row -> keep the higher; a move smaller than
// minMoveAtr x ATR away from the previous opposite swing is noise and dropped.
function swings(bars, o) {
  const p = opt(o), a = atrOf(bars, p.atrPeriod);
  if (!a) return [];
  const minMove = p.minMoveAtr * a, out = [];
  for (const q of pivots(bars, p.strength)) {
    const last = out[out.length - 1];
    if (!last) { out.push(q); continue; }
    if (last.type === q.type) { if (q.type === 'high' ? q.price > last.price : q.price < last.price) out[out.length - 1] = q; continue; }
    if (Math.abs(q.price - last.price) < minMove) continue;
    out.push(q);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. structure: HH/HL (up), LH/LL (down), anything else = range; and whether the newest close broke the last swing
// ("bos" = break WITH the trend, "choch" = break AGAINST it, the first sign of a turn).
function structureOf(bars, sw, a, o) {
  const p = opt(o), eps = 0.1 * a, n = bars.length;
  const highs = sw.filter((s) => s.type === 'high'), lows = sw.filter((s) => s.type === 'low');
  const label = (arr, hi) => arr.slice(1).map((s, i) => {
    const d = s.price - arr[i].price;
    return Math.abs(d) <= eps ? (hi ? 'EH' : 'EL') : d > 0 ? (hi ? 'HH' : 'HL') : (hi ? 'LH' : 'LL');
  });
  const hl = label(highs, true), ll = label(lows, false);
  const lh = hl[hl.length - 1], lw = ll[ll.length - 1];
  let trend = 'unknown';
  if (lh && lw) trend = (lh === 'HH' && lw === 'HL') ? 'up' : (lh === 'LH' && lw === 'LL') ? 'down' : 'range';
  const seqAll = sw.map((s, i) => {
    let prev = null;
    for (let j = i - 1; j >= 0 && !prev; j--) if (sw[j].type === s.type) prev = sw[j];
    if (!prev) return s.type === 'high' ? 'H' : 'L';
    const d = s.price - prev.price, hi = s.type === 'high';
    return Math.abs(d) <= eps ? (hi ? 'EH' : 'EL') : d > 0 ? (hi ? 'HH' : 'HL') : (hi ? 'LH' : 'LL');
  });
  const sequence = seqAll.slice(-6);
  const lastHigh = highs[highs.length - 1] || null, lastLow = lows[lows.length - 1] || null;
  const close = bars[n - 1].close;
  let brk = null;
  const firstClose = (from, test) => { for (let i = from; i < n; i++) if (test(bars[i].close)) return i; return -1; };
  if (lastHigh && close > lastHigh.price) {
    const i = firstClose(lastHigh.index + 1, (c) => c > lastHigh.price);
    brk = { type: trend === 'down' ? 'choch_up' : 'bos_up', level: lastHigh.price, barsAgo: n - 1 - i };
  } else if (lastLow && close < lastLow.price) {
    const i = firstClose(lastLow.index + 1, (c) => c < lastLow.price);
    brk = { type: trend === 'up' ? 'choch_down' : 'bos_down', level: lastLow.price, barsAgo: n - 1 - i };
  }
  return { trend, sequence, highs: hl.slice(-3), lows: ll.slice(-3), lastHigh, lastLow, break: brk };
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. zones: pivots (highs AND lows — a level that held as support often later holds as resistance) clustered by price.
// strength 0..100 = 50 (number of touches, 5+ = full) + 30 (how recently it was touched) + 20 (it worked both as support and resistance).
function levels(bars, o, a) {
  const p = opt(o), n = bars.length;
  a = a || atrOf(bars, p.atrPeriod);
  if (!a) return [];
  const pts = pivots(bars, Math.max(2, p.strength - 1)).sort((x, y) => x.price - y.price); // slightly more sensitive than swings: more touches to count
  const tol = p.clusterAtr * a, clusters = [];
  for (const q of pts) {
    const c = clusters[clusters.length - 1];
    if (c && q.price - c.low <= tol) { c.members.push(q); c.high = q.price; } else clusters.push({ low: q.price, high: q.price, members: [q] });
  }
  const close = bars[n - 1].close, minH = p.minZoneAtr * a;
  const zones = [];
  for (const c of clusters) {
    if (c.members.length < p.minTouches) continue;
    const price = median(c.members.map((m) => m.price));
    let low = c.low, high = c.high;
    if (high - low < minH) { low = price - minH / 2; high = price + minH / 2; }
    const lastIndex = Math.max(...c.members.map((m) => m.index));
    const nHigh = c.members.filter((m) => m.type === 'high').length, nLow = c.members.length - nHigh;
    const sinceTouch = n - 1 - lastIndex;
    const strength = Math.round(50 * Math.min(1, c.members.length / 5) + 30 * Math.pow(0.5, sinceTouch / p.halfLifeBars) + (nHigh && nLow ? 20 : 0));
    const kind = high < close ? 'support' : low > close ? 'resistance' : 'inside';
    const dist = kind === 'support' ? (close - high) / a : kind === 'resistance' ? (low - close) / a : 0;
    const firstOf = (t) => { const x = c.members.filter((m) => m.type === t).map((m) => m.index); return x.length ? Math.min(...x) : null; };
    zones.push({ price, low, high, touches: c.members.length, highs: nHigh, lows: nLow, lastIndex, firstHighIndex: firstOf('high'), firstLowIndex: firstOf('low'), barsSinceTouch: sinceTouch, strength, kind, distAtr: dist, flipped: nHigh > 0 && nLow > 0 });
  }
  // the strongest ones, then listed top -> bottom
  return zones.sort((x, y) => y.strength - x.strength).slice(0, p.maxZones).sort((x, y) => y.price - x.price);
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. break + pullback ("شکست و پولبک"), per zone, only the most recent break of it:
//   broke     closed beyond the zone, price has not come back to it yet (extendedAtr = how far it already ran: big = late to chase)
//   pullback  came back to touch the zone, no confirmation candle yet
//   confirmed came back AND a candle closed back on the breakout side, in the breakout direction (rejection of the zone)
//   failed    closed back through the zone (false break)  -> invalidation level was hit
// dir 'up' = a resistance zone broken upward; 'down' = a support zone broken downward (tv-hub's bot is long-only: 'down' is information).
function breakRetest(bars, zones, a, o) {
  const p = opt(o), n = bars.length, buf = p.bufferAtr * a, touch = p.touchAtr * a, out = [];
  const from = Math.max(1, n - p.maxBreakAge);
  for (const z of zones) {
    for (const dir of ['up', 'down']) {
      // a zone can only be BROKEN UPWARD if it acted as resistance (a swing high sits in it, before the break); downward needs a swing low
      const first = dir === 'up' ? z.firstHighIndex : z.firstLowIndex;
      if (first === null || first === undefined) continue;
      const beyond = (c) => (dir === 'up' ? c > z.high + buf : c < z.low - buf);
      const wentBack = (c) => (dir === 'up' ? c < z.low - buf : c > z.high + buf);
      let ep = null, newest = null;
      for (let k = from; k < n; k++) {
        const bar = bars[k];
        if (!ep) {
          if (!beyond(bar.close) || beyond(bars[k - 1].close) || k <= first) continue;
          let cameFromOtherSide = true; // the closes just before the break must not already be on the far side (that would be a bounce, not a break)
          for (let j = Math.max(0, k - p.approachBars); j < k; j++) if (beyond(bars[j].close)) { cameFromOtherSide = false; break; }
          if (!cameFromOtherSide) continue;
          ep = { b: k, state: 'broke', pb: null, conf: null };
          newest = ep;
          continue;
        }
        if (wentBack(bar.close)) { ep.state = 'failed'; ep = null; continue; } // a later re-break starts a new episode
        const touched = dir === 'up' ? bar.min <= z.high + touch : bar.max >= z.low - touch;
        if (touched && ep.pb === null) { ep.pb = k; if (ep.state === 'broke') ep.state = 'pullback'; }
        if (ep.pb !== null && ep.conf === null && touched) {
          const bullish = bar.close > bar.open;
          if (dir === 'up' ? bar.close > z.high && bullish : bar.close < z.low && !bullish) { ep.conf = k; ep.state = 'confirmed'; }
        }
      }
      if (!newest) continue;
      const last = bars[n - 1].close, e = newest;
      out.push({
        dir, state: e.state, zone: { price: z.price, low: z.low, high: z.high, touches: z.touches, strength: z.strength },
        breakBarsAgo: n - 1 - e.b, pullbackBarsAgo: e.pb === null ? null : n - 1 - e.pb, confirmedBarsAgo: e.conf === null ? null : n - 1 - e.conf,
        extendedAtr: dir === 'up' ? (last - z.high) / a : (z.low - last) / a, // how far price already ran from the zone (big = late to chase)
        invalidation: dir === 'up' ? z.low - buf : z.high + buf, // closing beyond this = the idea is wrong
      });
    }
  }
  return out.sort((x, y) => x.breakBarsAgo - y.breakBarsAgo);
}

// ---------------------------------------------------------------------------------------------------------------------
// The one call everything else uses. Never throws for bad data: { ok:false, reason } instead.
function analyze(input, o) {
  const p = opt(o);
  const all = cleanBars(input), bars = all.slice(-p.window);
  if (bars.length < MIN_BARS) return { ok: false, reason: `کندل کافی نیست (${bars.length} از حداقل ${MIN_BARS})`, n: bars.length };
  const a = atrOf(bars, p.atrPeriod);
  if (!a || !(a > 0)) return { ok: false, reason: 'ATR قابل محاسبه نیست (قیمت‌ها ثابت‌اند یا داده کم است)', n: bars.length };
  const n = bars.length, price = bars[n - 1].close;
  const sw = swings(bars, p), st = structureOf(bars, sw, a, p), zones = levels(bars, p, a), setups = breakRetest(bars, zones, a, p);
  const pub = ({ lastIndex, firstHighIndex, firstLowIndex, ...z }) => z; // candle numbers inside the window are internal; times and barsAgo are the public face
  const ago = (s) => (s ? { type: s.type, price: s.price, time: bars[s.index].time, barsAgo: n - 1 - s.index, confirmedBarsAgo: n - 1 - s.confirmedAt } : null);
  const above = zones.filter((z) => z.kind === 'resistance').sort((x, y) => x.price - y.price)[0] || null;
  const below = zones.filter((z) => z.kind === 'support').sort((x, y) => y.price - x.price)[0] || null;
  const inside = zones.find((z) => z.kind === 'inside') || null;
  return {
    ok: true, n, price, time: bars[n - 1].time, atr: a, atrPct: (a / price) * 100,
    swings: sw.slice(-10).map(ago),
    structure: { trend: st.trend, sequence: st.sequence, highs: st.highs, lows: st.lows, lastHigh: ago(st.lastHigh), lastLow: ago(st.lastLow), break: st.break },
    zones: zones.map(pub), nearest: { resistance: above && pub(above), support: below && pub(below), inside: inside && pub(inside) },
    setups,
    params: { strength: p.strength, minMoveAtr: p.minMoveAtr, clusterAtr: p.clusterAtr, minTouches: p.minTouches, window: p.window },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Plain Persian lines from the numbers above — the "no AI" version of the analysis (an AI may rephrase these, never change them).
const TREND_FA = { up: 'صعودی (سقف و کف بالاتر)', down: 'نزولی (سقف و کف پایین‌تر)', range: 'بدون روند مشخص (رنج)', unknown: 'نامشخص (سقف/کف کافی نیست)' };
const STATE_FA = { broke: 'شکسته شد، هنوز پولبک نشده', pullback: 'پولبک زده، هنوز تأییدی نیامده', confirmed: 'پولبک تأیید شد', failed: 'شکست جعلی بود (برگشت داخل محدوده)' };
const fmt = (x) => { if (!finite(x)) return '—'; const v = Math.abs(x); return Number(x.toFixed(v >= 1000 ? 2 : v >= 10 ? 3 : v >= 1 ? 4 : 5)).toString(); };
const zoneText = (z) => `${fmt(z.low)} تا ${fmt(z.high)} (${z.touches} برخورد، قدرت ${z.strength}٪${z.flipped ? '، هم حمایت هم مقاومت بوده' : ''})`;
function describe(a) {
  if (!a || !a.ok) return [a && a.reason ? a.reason : 'تحلیل ساختار ممکن نشد'];
  const L = [`روند ساختاری: ${TREND_FA[a.structure.trend]}`];
  const br = a.structure.break;
  if (br) L.push(`${br.type.startsWith('choch') ? 'نشانه‌ی تغییر روند' : a.structure.trend === 'range' || a.structure.trend === 'unknown' ? 'شکست محدوده' : 'ادامه‌ی روند'}: قیمت ${br.type.endsWith('up') ? 'بالاتر از آخرین سقف' : 'پایین‌تر از آخرین کف'} (${fmt(br.level)}) بسته شده، ${br.barsAgo} کندل پیش`);
  const r = a.nearest.resistance, s = a.nearest.support;
  if (a.nearest.inside) L.push(`قیمت داخل یک محدوده است: ${zoneText(a.nearest.inside)}`);
  if (r) L.push(`نزدیک‌ترین مقاومت: ${zoneText(r)} — ${r.distAtr.toFixed(1)} ATR بالاتر`);
  if (s) L.push(`نزدیک‌ترین حمایت: ${zoneText(s)} — ${s.distAtr.toFixed(1)} ATR پایین‌تر`);
  for (const t of a.setups.slice(0, 3)) {
    L.push(`${t.dir === 'up' ? 'شکست مقاومت' : 'شکست حمایت'} ${fmt(t.zone.low)}–${fmt(t.zone.high)}: ${STATE_FA[t.state]} (${t.breakBarsAgo} کندل پیش)${t.state !== 'failed' ? `؛ ابطال با بسته شدن ${t.dir === 'up' ? 'زیر' : 'بالای'} ${fmt(t.invalidation)}` : ''}${t.state === 'broke' && t.extendedAtr > 3 ? `؛ قیمت ${t.extendedAtr.toFixed(1)} ATR از محدوده دور شده (تعقیب قیمت پرریسک است)` : ''}`);
  }
  return L;
}

module.exports = { analyze, describe, pivots, lastPivot, swings, structureOf, levels, breakRetest, atrOf, DEFAULTS, MIN_BARS };
