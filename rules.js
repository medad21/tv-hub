// A small, SAFE rule language for strategies described in plain words ("buy when RSI(14) is below 35 and price is above
// EMA(100); close when price falls below EMA(100)"). The AI never writes code: it fills in this structure, and everything
// here is validated against a whitelist (indicators, operators, number ranges) and then interpreted by OUR code. So a rule
// set can only do arithmetic comparisons on indicators — it cannot read files, call the network or loop forever.
//
//   rules = { entry: Cond, exit: Cond | null }
//   Cond  = { all: [Cond|Leaf, ...] }  |  { any: [Cond|Leaf, ...] }  |  Leaf
//   Leaf  = { left: Operand, op: '>' | '<' | '>=' | '<=' | 'crosses_above' | 'crosses_below', right: Operand }
//   Operand = number  |  { ind: 'rsi', period: 14 }  (+ optional "mult": 1.02 to scale it, e.g. EMA(50) x 1.02)
//
// The strategy state each candle: exit true -> 'sell' (exits are checked first), else entry true -> 'buy', else 'hold'.
// A condition that cannot be evaluated yet (not enough candles) is "unknown", never silently true or false.

const INT = (def, min, max) => ({ int: true, def, min, max });
const NUM = (def, min, max) => ({ int: false, def, min, max });
const INDICATORS = {
  close: { label: () => 'قیمت بسته‌شدن', params: {} },
  open: { label: () => 'قیمت باز شدن', params: {} },
  high: { label: () => 'سقف کندل', params: {} },
  low: { label: () => 'کف کندل', params: {} },
  volume: { label: () => 'حجم', params: {} },
  rsi: { label: (o) => `RSI(${o.period ?? 14})`, params: { period: INT(14, 2, 100) } },
  ema: { label: (o) => `EMA(${o.period})`, params: { period: INT(null, 2, 250) } },
  sma: { label: (o) => `SMA(${o.period})`, params: { period: INT(null, 2, 250) } },
  atr: { label: (o) => `ATR(${o.period ?? 14})`, params: { period: INT(14, 2, 100) } },
  macd_line: { label: () => 'خط MACD', params: { fast: INT(12, 2, 100), slow: INT(26, 3, 200), signal: INT(9, 2, 100) } },
  macd_signal: { label: () => 'سیگنال MACD', params: { fast: INT(12, 2, 100), slow: INT(26, 3, 200), signal: INT(9, 2, 100) } },
  macd_hist: { label: () => 'هیستوگرام MACD', params: { fast: INT(12, 2, 100), slow: INT(26, 3, 200), signal: INT(9, 2, 100) } },
  bb_upper: { label: (o) => `باند بالای بولینگر(${o.period ?? 20})`, params: { period: INT(20, 5, 250), k: NUM(2, 0.5, 4) } },
  bb_mid: { label: (o) => `میانه‌ی بولینگر(${o.period ?? 20})`, params: { period: INT(20, 5, 250), k: NUM(2, 0.5, 4) } },
  bb_lower: { label: (o) => `باند پایین بولینگر(${o.period ?? 20})`, params: { period: INT(20, 5, 250), k: NUM(2, 0.5, 4) } },
  highest: { label: (o) => `بالاترین سقف ${o.period} کندل قبل`, params: { period: INT(null, 2, 250) } },
  lowest: { label: (o) => `پایین‌ترین کف ${o.period} کندل قبل`, params: { period: INT(null, 2, 250) } },
  avg_volume: { label: (o) => `میانگین حجم ${o.period ?? 20} کندل`, params: { period: INT(20, 2, 250) } },
  swing_high: { label: (o) => `آخرین سقف تأییدشده (قدرت ${o.strength ?? 3})`, params: { strength: INT(3, 1, 10) } }, // a swing high needs `strength` lower candles after it to be known
  swing_low: { label: (o) => `آخرین کف تأییدشده (قدرت ${o.strength ?? 3})`, params: { strength: INT(3, 1, 10) } },
};
const OPS = {
  '>': 'بیشتر از', '<': 'کمتر از', '>=': 'بیشتر یا مساوی', '<=': 'کمتر یا مساوی',
  crosses_above: 'از پایین به بالا قطع کند', crosses_below: 'از بالا به پایین قطع کند',
};
const MAX_DEPTH = 3, MAX_LEAVES = 12, MAX_CHILDREN = 8, MAX_ABS = 1e9;

class RulesError extends Error {}
const fail = (msg) => { throw new RulesError(msg); };
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const keysOnly = (o, allowed, where) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${where}: کلید ناشناخته «${k}»`); };

function cleanOperand(o, where) {
  if (typeof o === 'number') {
    if (!Number.isFinite(o) || Math.abs(o) > MAX_ABS) fail(`${where}: عدد نامعتبر`);
    return o;
  }
  if (!isObj(o)) fail(`${where}: باید عدد یا یک اندیکاتور باشد`);
  const def = INDICATORS[o.ind];
  if (typeof o.ind !== 'string' || !Object.prototype.hasOwnProperty.call(INDICATORS, o.ind)) fail(`${where}: اندیکاتور «${o.ind}» پشتیبانی نمی‌شود (مجاز: ${Object.keys(INDICATORS).join('، ')})`);
  keysOnly(o, ['ind', 'mult', ...Object.keys(def.params)], `${where} (${o.ind})`);
  const out = { ind: o.ind };
  for (const [name, p] of Object.entries(def.params)) {
    let v = o[name];
    if (v === undefined || v === null) { if (p.def === null) fail(`${where}: «${name}» برای ${o.ind} لازم است`); v = p.def; }
    if (typeof v !== 'number' || !Number.isFinite(v) || (p.int && !Number.isInteger(v)) || v < p.min || v > p.max) fail(`${where}: «${name}» برای ${o.ind} باید ${p.int ? 'عدد صحیح' : 'عدد'} بین ${p.min} و ${p.max} باشد`);
    out[name] = v;
  }
  if (out.fast !== undefined && out.fast >= out.slow) fail(`${where}: دوره‌ی سریع MACD باید از کند کمتر باشد`);
  if (o.mult !== undefined && o.mult !== null) {
    if (typeof o.mult !== 'number' || !Number.isFinite(o.mult) || o.mult <= 0 || o.mult > 100) fail(`${where}: «mult» باید عددی بین 0 و 100 باشد`);
    if (o.mult !== 1) out.mult = o.mult;
  }
  return out;
}

function cleanCond(c, depth, where, counter) {
  if (!isObj(c)) fail(`${where}: شرط نامعتبر است`);
  if (depth > MAX_DEPTH) fail(`${where}: شرط‌ها بیش از ${MAX_DEPTH} لایه تو در تو شده‌اند`);
  const group = 'all' in c ? 'all' : 'any' in c ? 'any' : null;
  if (group) {
    keysOnly(c, [group], where);
    const arr = c[group];
    if (!Array.isArray(arr) || arr.length < 1 || arr.length > MAX_CHILDREN) fail(`${where}: «${group}» باید فهرستی از 1 تا ${MAX_CHILDREN} شرط باشد`);
    return { [group]: arr.map((x, i) => cleanCond(x, depth + 1, `${where}.${group}[${i}]`, counter)) };
  }
  keysOnly(c, ['left', 'op', 'right'], where);
  if (!Object.prototype.hasOwnProperty.call(OPS, c.op)) fail(`${where}: عملگر «${c.op}» مجاز نیست (مجاز: ${Object.keys(OPS).join('، ')})`);
  if (++counter.n > MAX_LEAVES) fail(`شرط‌ها بیش از ${MAX_LEAVES} مقایسه دارند؛ ساده‌ترش کن`);
  const left = cleanOperand(c.left, `${where}.left`), right = cleanOperand(c.right, `${where}.right`);
  if (typeof left === 'number' && typeof right === 'number') fail(`${where}: مقایسه‌ی دو عدد ثابت بی‌معناست`);
  return { left, op: c.op, right };
}

// Returns the cleaned rules ({ entry, exit }) or throws RulesError with a readable sentence.
function validateRules(rules) {
  if (!isObj(rules)) fail('قواعد نامعتبر است');
  keysOnly(rules, ['entry', 'exit'], 'rules');
  if (rules.entry === undefined || rules.entry === null) fail('شرط ورود (entry) لازم است');
  const counter = { n: 0 };
  const entry = cleanCond(rules.entry, 1, 'entry', counter);
  const exit = rules.exit === undefined || rules.exit === null ? null : cleanCond(rules.exit, 1, 'exit', counter);
  return { entry, exit };
}

// ---- evaluation ----
function operandValue(ctx, o) {
  if (typeof o === 'number') return o;
  let v = null;
  switch (o.ind) {
    case 'close': v = ctx.close; break;
    case 'open': v = ctx.open; break;
    case 'high': v = ctx.high; break;
    case 'low': v = ctx.low; break;
    case 'volume': v = ctx.volume; break;
    case 'rsi': v = ctx.rsi(o.period); break;
    case 'ema': v = ctx.ema(o.period); break;
    case 'sma': v = ctx.sma(o.period); break;
    case 'atr': v = ctx.atr(o.period); break;
    case 'macd_line': case 'macd_signal': case 'macd_hist': {
      const m = ctx.macd(o.fast, o.slow, o.signal);
      v = m ? (o.ind === 'macd_line' ? m.macd : o.ind === 'macd_signal' ? m.signal : m.hist) : null;
      break;
    }
    case 'bb_upper': case 'bb_mid': case 'bb_lower': {
      const b = ctx.bollinger(o.period, o.k);
      v = b ? (o.ind === 'bb_upper' ? b.upper : o.ind === 'bb_mid' ? b.mid : b.lower) : null;
      break;
    }
    case 'highest': v = ctx.highest(o.period); break;
    case 'lowest': v = ctx.lowest(o.period); break;
    case 'avg_volume': v = ctx.avgVolume(o.period); break;
    case 'swing_high': v = ctx.swingHigh(o.strength); break;
    case 'swing_low': v = ctx.swingLow(o.strength); break;
    default: return null;
  }
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return o.mult !== undefined ? v * o.mult : v;
}

// true / false / null (= cannot be decided yet)
function evalLeaf(ctx, leaf) {
  const cmp = (c) => {
    const a = operandValue(c, leaf.left), b = operandValue(c, leaf.right);
    return a === null || b === null ? null : [a, b];
  };
  if (leaf.op === 'crosses_above' || leaf.op === 'crosses_below') {
    const now = cmp(ctx), pc = ctx.back(1), before = pc ? cmp(pc) : null;
    if (!now || !before) return null;
    return leaf.op === 'crosses_above' ? now[0] > now[1] && before[0] <= before[1] : now[0] < now[1] && before[0] >= before[1];
  }
  const v = cmp(ctx);
  if (!v) return null;
  switch (leaf.op) { case '>': return v[0] > v[1]; case '<': return v[0] < v[1]; case '>=': return v[0] >= v[1]; default: return v[0] <= v[1]; }
}
function evalCond(ctx, c) {
  if (c.all) { const r = c.all.map((x) => evalCond(ctx, x)); return r.includes(false) ? false : r.includes(null) ? null : true; }
  if (c.any) { const r = c.any.map((x) => evalCond(ctx, x)); return r.includes(true) ? true : r.includes(null) ? null : false; }
  return evalLeaf(ctx, c);
}

// The function a registered strategy runs on every closed candle (same contract as a script strategy's signal(ctx)).
function makeSignal(rules) {
  return (ctx) => {
    const ex = rules.exit ? evalCond(ctx, rules.exit) : false;
    if (ex === true) return 'sell';
    const en = evalCond(ctx, rules.entry);
    if (en === true) return 'buy';
    return en === null && (ex === null || !rules.exit) ? 'none' : 'hold';
  };
}

// ---- plain-language description, generated from the VALIDATED rules (never from what the AI claims they do) ----
const opText = (o) => (typeof o === 'number' ? String(o) : INDICATORS[o.ind].label(o) + (o.mult !== undefined ? ` × ${o.mult}` : ''));
function condText(c, nested = false) {
  if (c.all || c.any) {
    const parts = (c.all || c.any).map((x) => condText(x, true)), t = parts.join(c.all ? ' و ' : ' یا ');
    return nested && parts.length > 1 ? `(${t})` : t;
  }
  if (c.op === 'crosses_above' || c.op === 'crosses_below') return `${opText(c.left)} ${opText(c.right)} را ${c.op === 'crosses_above' ? 'از پایین به بالا' : 'از بالا به پایین'} قطع کند`;
  return `${opText(c.left)} ${OPS[c.op]} ${opText(c.right)}`;
}
function describeRules(rules) {
  return {
    entry: `خرید وقتی: ${condText(rules.entry)}`,
    exit: rules.exit ? `خروج وقتی: ${condText(rules.exit)}` : 'خروج فقط با حد ضرر / هدف (قاعده‌ی خروج جداگانه تعریف نشده)',
  };
}

module.exports = { validateRules, makeSignal, describeRules, evalCond, RulesError, INDICATORS, OPS, MAX_LEAVES };
