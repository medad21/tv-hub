// The AI connection: ONE small place that knows about API keys and providers, so the rest of the app just calls complete().
//
// Two providers are enough for almost everything:
//   anthropic  — Claude (api.anthropic.com)
//   openai     — anything that speaks the OpenAI "chat/completions" format: OpenAI, Google Gemini (its OpenAI-compatible URL),
//                DeepSeek, OpenRouter, a local Ollama (http://localhost:11434/v1, no key needed), ...
// The key is entered in the dashboard (Settings of the AI section) or put in .env. A key typed in the dashboard is stored
// ONLY on this server (ai-settings.json, permission 600) and is never sent back to the browser — the page only ever sees
// "a key is saved, ends in ...abcd". With no key at all everything still works; only the AI buttons say "set a key first".
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fsutil');

const DEFAULTS = {
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
};
const TIMEOUT_MS = 60000;
const hits = []; // timestamps of recent calls (a runaway loop or a stuck button must not run up a bill)

class AIError extends Error { constructor(code, message, status) { super(message); this.code = code; this.status = status; } }

const settingsFile = () => process.env.AI_SETTINGS_FILE || path.join(process.env.DATA_DIR || __dirname, 'ai-settings.json');
function readFile() {
  try { const j = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}
const isLoopback = (url) => { try { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(url).hostname); } catch { return false; } };
const envKey = (provider) => process.env.AI_API_KEY || (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) || '';

// what is really used right now: .env wins over the file, the file wins over the defaults
function effective() {
  const f = readFile();
  const provider = [process.env.AI_PROVIDER, f.provider].find((p) => p === 'anthropic' || p === 'openai')
    || (!process.env.ANTHROPIC_API_KEY && !process.env.AI_API_KEY && process.env.OPENAI_API_KEY ? 'openai' : 'anthropic');
  const baseUrl = String(process.env.AI_BASE_URL || f.baseUrl || DEFAULTS[provider].baseUrl).replace(/\/+$/, '');
  const model = process.env.AI_MODEL || f.model || DEFAULTS[provider].model;
  const fromEnv = envKey(provider);
  const apiKey = fromEnv || (typeof f.apiKey === 'string' ? f.apiKey : '');
  return { provider, baseUrl, model, apiKey, keySource: apiKey ? (fromEnv ? 'env' : 'file') : null };
}

// safe to show in the page: never contains the key itself
function view() {
  const e = effective();
  const configured = !!e.model && (!!e.apiKey || isLoopback(e.baseUrl));
  return {
    provider: e.provider, model: e.model, baseUrl: e.baseUrl, hasKey: !!e.apiKey, keySource: e.keySource,
    keyHint: e.apiKey ? `••••${e.apiKey.slice(-4)}` : null, configured,
    needs: configured ? null : !e.apiKey && !isLoopback(e.baseUrl) ? 'key' : 'model',
    defaults: { anthropic: DEFAULTS.anthropic, openai: DEFAULTS.openai },
    maxPerHour: maxPerHour(),
  };
}

function save(input) {
  if (!input || typeof input !== 'object') throw new AIError('BAD_SETTINGS', 'تنظیمات نامعتبر است', 400);
  const f = readFile(), out = { ...f };
  if (input.provider !== undefined) {
    if (input.provider !== 'anthropic' && input.provider !== 'openai') throw new AIError('BAD_SETTINGS', 'ارائه‌دهنده باید anthropic یا openai باشد', 400);
    out.provider = input.provider;
  }
  if (input.model !== undefined) {
    const m = String(input.model).trim();
    if (m.length > 100 || (m && !/^[A-Za-z0-9._:/@+-]+$/.test(m))) throw new AIError('BAD_SETTINGS', 'نام مدل نامعتبر است (فقط حروف انگلیسی، عدد و . _ : / - )', 400);
    out.model = m;
  }
  if (input.baseUrl !== undefined) {
    const u = String(input.baseUrl).trim();
    if (u) {
      let parsed; try { parsed = new URL(u); } catch { throw new AIError('BAD_SETTINGS', 'آدرس سرویس نامعتبر است', 400); }
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || u.length > 200) throw new AIError('BAD_SETTINGS', 'آدرس باید با http:// یا https:// شروع شود و کاربر/رمز نداشته باشد', 400);
    }
    out.baseUrl = u;
  }
  if (input.clearKey) delete out.apiKey;
  else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    const k = input.apiKey.trim();
    if (k.length > 300 || /\s/.test(k)) throw new AIError('BAD_SETTINGS', 'کلید API نامعتبر است (فاصله یا خط جدید نباید داشته باشد)', 400);
    out.apiKey = k;
  }
  atomicWrite(settingsFile(), JSON.stringify(out, null, 2), 0o600);
  try { fs.chmodSync(settingsFile(), 0o600); } catch {}
  return view();
}

const maxPerHour = () => Math.max(1, Number(process.env.AI_MAX_PER_HOUR) || 30);
function checkRate() {
  const now = Date.now();
  while (hits.length && now - hits[0] > 3600 * 1000) hits.shift();
  if (hits.length >= maxPerHour()) throw new AIError('RATE_LIMIT', `سقف ${maxPerHour()} درخواست در ساعت به AI پر شده؛ کمی بعد دوباره امتحان کن (برای تغییر: AI_MAX_PER_HOUR در .env)`, 429);
  hits.push(now);
}
const resetRate = () => { hits.length = 0; };

function clean(text, key) {
  let t = String(text || '');
  if (key) t = t.split(key).join('••••');
  return t.replace(/\s+/g, ' ').slice(0, 240);
}

// system: instructions; user: the content. Returns the model's text. Throws AIError with a message fit to show the user.
async function complete({ system, user, maxTokens = 1500 }) {
  const e = effective();
  if (!e.model) throw new AIError('NEEDS_KEY', 'نام مدل تنظیم نشده است (تنظیمات هوش مصنوعی را کامل کن)', 412);
  if (!e.apiKey && !isLoopback(e.baseUrl)) throw new AIError('NEEDS_KEY', 'کلید API هوش مصنوعی تنظیم نشده؛ از «تنظیمات هوش مصنوعی» یا فایل .env اضافه کن', 412);
  checkRate();
  let url, headers, body;
  if (e.provider === 'anthropic') {
    url = `${e.baseUrl}/v1/messages`;
    headers = { 'content-type': 'application/json', 'x-api-key': e.apiKey, 'anthropic-version': '2023-06-01' };
    body = { model: e.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
  } else {
    url = `${e.baseUrl}/chat/completions`;
    headers = { 'content-type': 'application/json', ...(e.apiKey ? { authorization: `Bearer ${e.apiKey}` } : {}) };
    body = { model: e.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }; // no token cap: newer models reject the old parameter name
  }
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res, raw;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    raw = await res.text();
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw new AIError('TIMEOUT', 'سرویس هوش مصنوعی بیش از ۶۰ ثانیه جواب نداد', 504);
    throw new AIError('NETWORK', `اتصال به سرویس هوش مصنوعی برقرار نشد (${clean(err && err.cause && err.cause.code || err && err.message, e.apiKey)}). آدرس سرویس و اینترنت سرور را بررسی کن`, 502);
  }
  clearTimeout(timer);
  let json = null; try { json = JSON.parse(raw); } catch {}
  if (!res.ok) {
    const detail = clean(json && (json.error && (json.error.message || json.error) || json.message) || raw, e.apiKey);
    const why = res.status === 401 || res.status === 403 ? 'کلید API رد شد (اشتباه است یا دسترسی ندارد)'
      : res.status === 404 ? 'مدل یا آدرس سرویس پیدا نشد (نام مدل و آدرس را بررسی کن)'
      : res.status === 429 ? 'سرویس محدودیت درخواست یا اعتبار را اعلام کرد (۴۲۹)'
      : `سرویس هوش مصنوعی خطا داد (${res.status})`;
    throw new AIError(res.status === 401 || res.status === 403 ? 'AUTH' : 'PROVIDER', `${why}: ${detail}`, 502);
  }
  const text = e.provider === 'anthropic'
    ? (json && Array.isArray(json.content) ? json.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('') : '')
    : (json && json.choices && json.choices[0] && json.choices[0].message ? String(json.choices[0].message.content || '') : '');
  if (!text.trim()) throw new AIError('BAD_RESPONSE', 'سرویس هوش مصنوعی جواب خالی یا نامعتبر داد', 502);
  return text;
}

module.exports = { complete, view, save, effective, AIError, resetRate, maxPerHour };
