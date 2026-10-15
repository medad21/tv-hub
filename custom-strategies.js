// User-made strategies, two kinds:
//  1) SCRIPT strategies: JavaScript you write in custom-strategies.user.js (see custom-strategies.example.js). Their ids get the prefix js_
//  2) COMBINATIONS: built in the dashboard from existing strategies (a vote: "buy when 2 of these 3 agree"), saved in
//     custom-combos.json. Their ids get the prefix combo_
//  3) RULE strategies: a validated rule set (see rules.js) — written by hand or proposed by the AI from a plain-words description,
//     saved in custom-rules.json. Their ids get the prefix rules_
// All are registered into strategy.js's STRATEGIES, so the Backtest tab, the timeframe comparison, Sweep and the live bot all
// see them like the built-in ones. load() is safe to call again at any time (it forgets what it registered before) — the
// backtest worker thread calls it before every job, so a change made in the dashboard is honoured by the very next run.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fsutil');
const S = require('./strategy');
const rulesLib = require('./rules');

const ID_RE = /^[a-z][a-z0-9_]{1,30}$/;
const MAX_COMBOS = 20;
const registered = new Set();
let lastStatus = null;

const dataDir = () => process.env.DATA_DIR || __dirname;
const rulesFile = () => process.env.CUSTOM_RULES_FILE || path.join(dataDir(), 'custom-rules.json');
const MAX_RULES = 30;
const combosFile = () => process.env.CUSTOM_COMBOS_FILE || path.join(dataDir(), 'custom-combos.json');
// your own file lives next to state.json (a Docker volume when DATA_DIR is set); a copy next to the code works too
const scriptCandidates = () => [process.env.CUSTOM_STRATEGIES_FILE, path.join(dataDir(), 'custom-strategies.user.js'), path.join(__dirname, 'custom-strategies.user.js')].filter(Boolean);

const isBuiltin = (id) => S.STRATEGIES[id] && !S.STRATEGIES[id].custom;

function readCombosRaw() {
  const f = combosFile();
  if (!fs.existsSync(f)) return { list: [], error: null };
  try {
    const list = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(list)) throw new Error('محتوای فایل باید یک آرایه باشد');
    return { list, error: null };
  } catch (e) { return { list: [], error: `فایل ترکیب‌ها خراب است (${f}): ${e.message}` }; }
}

function readRulesRaw() {
  const f = rulesFile();
  if (!fs.existsSync(f)) return { list: [], error: null };
  try {
    const list = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(list)) throw new Error('محتوای فایل باید یک آرایه باشد');
    return { list, error: null };
  } catch (e) { return { list: [], error: `فایل قواعد خراب است (${f}): ${e.message}` }; }
}

// Checks a combination definition. Returns { combo } (cleaned) or { error } (a sentence for the user).
function cleanCombo(c) {
  if (!c || typeof c !== 'object') return { error: 'تعریف ترکیب نامعتبر است' };
  const name = typeof c.name === 'string' ? c.name.trim() : '';
  if (!name || name.length > 60) return { error: 'یک نام (حداکثر ۶۰ حرف) برای ترکیب بنویس' };
  const comps = Array.isArray(c.components) ? [...new Set(c.components.map(String))] : [];
  if (comps.length < 2 || comps.length > 6) return { error: 'برای ترکیب، بین ۲ تا ۶ استراتژی انتخاب کن' };
  for (const id of comps) {
    const d = S.STRATEGIES[id];
    if (!d) return { error: `استراتژی «${id}» پیدا نشد` };
    if (d.components) return { error: `«${d.name}» خودش ترکیب است؛ ترکیب را داخل ترکیب نمی‌شود گذاشت` };
  }
  const n = comps.length, whole = (x) => Number.isInteger(Number(x)) && String(x).trim() !== '';
  if (!whole(c.entryVotes) || c.entryVotes < 1 || c.entryVotes > n) return { error: `حداقل رأی خرید باید عددی بین ۱ تا ${n} باشد` };
  if (!whole(c.exitVotes) || c.exitVotes < 1 || c.exitVotes > n) return { error: `حداقل رأی خروج باید عددی بین ۱ تا ${n} باشد` };
  const opt = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  const rsiBuy = opt(c.rsiBuy), rsiSell = opt(c.rsiSell);
  for (const [label, v] of [['RSI خرید', rsiBuy], ['RSI فروش', rsiSell]]) if (v !== null && !(v >= 1 && v <= 99)) return { error: `${label} باید بین ۱ تا ۹۹ باشد` };
  if (rsiBuy !== null && rsiSell !== null && rsiBuy >= rsiSell) return { error: 'سطح RSI خرید باید از سطح RSI فروش کمتر باشد' };
  const names = comps.map((id) => S.STRATEGIES[id].name);
  const rsiTxt = [rsiBuy !== null && `خرید وقتی RSI زیر ${rsiBuy}`, rsiSell !== null && `فروش وقتی RSI بالای ${rsiSell}`].filter(Boolean).join('؛ ');
  const description = typeof c.description === 'string' && c.description.trim() ? c.description.trim().slice(0, 400)
    : `ترکیب دلخواه: ${names.join(' + ')}. خرید وقتی حداقل ${c.entryVotes} از ${n} هم‌نظر صعودی باشند؛ بستن وقتی حداقل ${c.exitVotes} از ${n} نزولی شوند.${rsiTxt ? ` (${rsiTxt})` : ''}`;
  return { combo: { name, components: comps, entryVotes: Number(c.entryVotes), exitVotes: Number(c.exitVotes), rsiBuy, rsiSell, description } };
}

function load() {
  for (const id of registered) S.unregisterStrategy(id);
  registered.clear();
  const status = { script: { file: null, exists: false, loaded: [], skipped: [], error: null }, rules: [], rulesError: null, combos: [], combosError: null };

  // ---- 1) script strategies
  const file = scriptCandidates().find((f) => fs.existsSync(f));
  if (!file) status.script.file = scriptCandidates().find((f) => f && f.endsWith('custom-strategies.user.js')) || null;
  else {
    status.script.file = file; status.script.exists = true;
    try {
      const resolved = require.resolve(path.resolve(file));
      delete require.cache[resolved]; // pick up edits without restarting
      const mod = require(resolved);
      const list = Array.isArray(mod) ? mod : mod && Array.isArray(mod.strategies) ? mod.strategies : null;
      if (!list) throw new Error('فایل باید یک آرایه از استراتژی‌ها را export کند: module.exports = [ { id, name, signal(ctx) { ... } } ]');
      const seen = new Set();
      for (const d of list) {
        const label = d && typeof d.id === 'string' ? d.id : '(بدون id)';
        const skip = (reason) => status.script.skipped.push({ id: label, reason });
        if (!d || typeof d !== 'object') { skip('تعریف نامعتبر'); continue; }
        if (d.enabled === false) { skip('خاموش (enabled: false)'); continue; }
        if (typeof d.id !== 'string' || !ID_RE.test(d.id)) { skip('id باید با حرف انگلیسی کوچک شروع شود و فقط حروف کوچک، عدد و _ داشته باشد (۲ تا ۳۱ نویسه)'); continue; }
        if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 80) { skip('name لازم است (حداکثر ۸۰ حرف)'); continue; }
        if (typeof d.signal !== 'function') { skip('تابع signal(ctx) وجود ندارد'); continue; }
        const id = `js_${d.id}`;
        if (seen.has(id)) { skip('id تکراری'); continue; }
        seen.add(id);
        S.registerStrategy(id, { name: d.name.trim(), description: typeof d.description === 'string' && d.description.trim() ? d.description.trim() : 'استراتژی شخصی (بدون توضیح)', usesRsiThreshold: false, custom: true, kind: 'script', fn: d.signal });
        registered.add(id);
        status.script.loaded.push({ id, name: d.name.trim() });
      }
    } catch (e) {
      // a typo in YOUR file must never take the dashboard down: report it and carry on with whatever else exists
      for (const id of status.script.loaded.map((x) => x.id)) { S.unregisterStrategy(id); registered.delete(id); }
      status.script.loaded = [];
      status.script.error = e && e.message ? e.message : String(e);
    }
  }

  // ---- 2) rule strategies (validated rule sets; the description is generated from the rules themselves)
  const rr = readRulesRaw();
  status.rulesError = rr.error;
  for (const raw of rr.list) {
    const entry = { id: raw && raw.id, name: raw && raw.name, source: raw && typeof raw.source === 'string' ? raw.source : '', valid: false, reason: null };
    try {
      if (!raw || typeof raw.id !== 'string' || !/^rules_[a-z0-9]+$/.test(raw.id)) throw new Error('id نامعتبر');
      if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('نام لازم است');
      const rules = rulesLib.validateRules(raw.rules), text = rulesLib.describeRules(rules);
      S.registerStrategy(raw.id, { name: raw.name.trim(), description: `${text.entry}. ${text.exit}.`, usesRsiThreshold: false, custom: true, kind: 'rules', fn: rulesLib.makeSignal(rules), rules });
      registered.add(raw.id);
      Object.assign(entry, { valid: true, rules, text });
    } catch (e) { entry.reason = e.message; }
    status.rules.push(entry);
  }

  // ---- 3) combinations (after the scripts, because a combination may use a script strategy as a part)
  const { list, error } = readCombosRaw();
  status.combosError = error;
  for (const raw of list) {
    const entry = { id: raw && raw.id, name: raw && raw.name, valid: false, reason: null };
    const { combo, error: err } = cleanCombo(raw);
    if (err || typeof raw.id !== 'string' || !/^combo_[a-z0-9]+$/.test(raw.id)) { entry.reason = err || 'id نامعتبر'; status.combos.push(entry); continue; }
    S.registerStrategy(raw.id, { name: combo.name, description: combo.description, usesRsiThreshold: combo.components.includes('rsi_dip') && combo.rsiBuy === null && combo.rsiSell === null, custom: true, kind: 'combo', components: combo.components, entryVotes: combo.entryVotes, exitVotes: combo.exitVotes, rsiBuy: combo.rsiBuy, rsiSell: combo.rsiSell });
    registered.add(raw.id);
    Object.assign(entry, { valid: true, ...combo });
    status.combos.push(entry);
  }
  lastStatus = status;
  return status;
}

function addCombo(input) {
  const { combo, error } = cleanCombo(input);
  if (error) throw new Error(error);
  const { list, error: fileErr } = readCombosRaw();
  if (fileErr) throw new Error(fileErr);
  if (list.length >= MAX_COMBOS) throw new Error(`حداکثر ${MAX_COMBOS} ترکیب ذخیره می‌شود؛ یکی را پاک کن`);
  if (list.some((x) => x && x.name === combo.name)) throw new Error('ترکیبی با همین نام وجود دارد');
  let id; do { id = `combo_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; } while (list.some((x) => x && x.id === id));
  atomicWrite(combosFile(), JSON.stringify([...list, { id, ...combo }], null, 2));
  return { id, status: load() };
}

function removeCombo(id) {
  if (typeof id !== 'string' || !/^combo_[a-z0-9]+$/.test(id)) return null;
  const { list, error } = readCombosRaw();
  if (error) throw new Error(error);
  if (!list.some((x) => x && x.id === id)) return null;
  atomicWrite(combosFile(), JSON.stringify(list.filter((x) => !x || x.id !== id), null, 2));
  return load();
}

// Saves a rule strategy. input: { name, rules, source? } — rules are validated here, so nothing unchecked is ever stored.
function addRules(input) {
  const name = input && typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 60) throw new Error('یک نام (حداکثر ۶۰ حرف) برای استراتژی بنویس');
  let rules;
  try { rules = rulesLib.validateRules(input.rules); } catch (e) { throw new Error(e.message); }
  const { list, error } = readRulesRaw();
  if (error) throw new Error(error);
  if (list.length >= MAX_RULES) throw new Error(`حداکثر ${MAX_RULES} استراتژی از این نوع ذخیره می‌شود؛ یکی را پاک کن`);
  if (list.some((x) => x && x.name === name)) throw new Error('استراتژی‌ای با همین نام وجود دارد');
  let id; do { id = `rules_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; } while (list.some((x) => x && x.id === id));
  const source = typeof input.source === 'string' ? input.source.slice(0, 1000) : '';
  atomicWrite(rulesFile(), JSON.stringify([...list, { id, name, source, rules, created: new Date().toISOString() }], null, 2));
  return { id, status: load() };
}

function removeRules(id) {
  if (typeof id !== 'string' || !/^rules_[a-z0-9]+$/.test(id)) return null;
  const { list, error } = readRulesRaw();
  if (error) throw new Error(error);
  if (!list.some((x) => x && x.id === id)) return null;
  atomicWrite(rulesFile(), JSON.stringify(list.filter((x) => !x || x.id !== id), null, 2));
  return load();
}

// combos that still use `id` as a part (so deleting / disabling it would break them)
const combosUsing = (id) => (lastStatus ? lastStatus.combos : []).filter((c) => c.valid && c.components.includes(id)).map((c) => c.name);

module.exports = { load, addCombo, removeCombo, addRules, removeRules, getStatus: () => lastStatus || load(), combosUsing, cleanCombo, isBuiltin, MAX_COMBOS };
