// Telegram connection kept INSIDE the program (dashboard panel) instead of only in .env:
//   <DATA_DIR>/telegram.local.json  { token, chatId, proxy }
// Order of precedence for each value: saved from the dashboard > .env (TELEGRAM_TOKEN / TELEGRAM_CHAT_ID / TELEGRAM_PROXY).
// The bot token is a password: it is stored here in plain text exactly like it would be in .env, and the dashboard never gets it back
// (it only sees "a token is saved, ends in ...abcd").
// proxy = an HTTP(S) proxy URL such as http://127.0.0.1:10809, used for Telegram ONLY (not for the market feed or the exchanges).
// SOCKS proxies are not supported; if your VPN app has no HTTP port, turn the VPN on for the whole computer instead.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fsutil');

const file = () => process.env.TELEGRAM_SETTINGS_FILE || path.join(process.env.DATA_DIR || __dirname, 'telegram.local.json');
const readSaved = () => { try { const o = JSON.parse(fs.readFileSync(file(), 'utf8')); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };

function get() {
  const s = readSaved();
  return {
    token: String(s.token || process.env.TELEGRAM_TOKEN || '').trim(),
    chatId: String(s.chatId || process.env.TELEGRAM_CHAT_ID || '').trim(),
    proxy: String(s.proxy || process.env.TELEGRAM_PROXY || '').trim(),
  };
}

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/, CHAT_RE = /^-?\d{3,}$/;
const validProxy = (p) => { try { const u = new URL(p); return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname; } catch { return false; } };

// patch: any of { token, chatId, proxy }. A key that is missing (undefined) is left alone; an empty string clears a saved value
// (so a value from .env, if any, applies again). Returns { ok } or { ok:false, error }.
function set(patch = {}) {
  const s = readSaved(), next = { ...s };
  if (patch.token !== undefined) {
    const t = String(patch.token).replace(/\s+/g, ''); // a token copied from Telegram may carry spaces or a line break in the middle
    if (t && !TOKEN_RE.test(t)) {
      if (/^[A-Za-z0-9_-]{30,}$/.test(t)) return { ok: false, error: 'توکن کامل نیست: قسمت عددی قبل از «:» را هم بگذارید. توکن کامل شکلش این است: 123456789:AAH-xxxxxxxx (عدد، دو نقطه، حروف؛ همه با هم).' };
      return { ok: false, error: 'توکن درست به نظر نمی‌رسد. شکلش مثل 123456789:AAH-xxxxxxxx است (عدد، دو نقطه، حروف). از @BotFather کپی کنید.' };
    }
    if (t) next.token = t; else delete next.token;
  }
  if (patch.chatId !== undefined) {
    const c = String(patch.chatId).trim();
    if (c && !CHAT_RE.test(c)) return { ok: false, error: 'شناسه‌ی چت باید یک عدد باشد (نه نام کاربری @...). با دکمه‌ی «پیدا کردن خودکار» پیدایش کنید.' };
    if (c) next.chatId = c; else delete next.chatId;
  }
  if (patch.proxy !== undefined) {
    const p = String(patch.proxy).trim();
    if (p && !validProxy(p)) return { ok: false, error: 'آدرس پروکسی باید http://آدرس:پورت باشد (مثل http://127.0.0.1:10809). SOCKS پشتیبانی نمی‌شود.' };
    if (p) next.proxy = p; else delete next.proxy;
  }
  if (Object.keys(next).length) { atomicWrite(file(), JSON.stringify(next, null, 2)); try { fs.chmodSync(file(), 0o600); } catch {} }
  else { try { fs.unlinkSync(file()); } catch {} }
  return { ok: true };
}
function clearSaved() { try { fs.unlinkSync(file()); } catch {} }

// what the dashboard may see: never the token itself
function view() {
  const e = get(), s = readSaved();
  return {
    hasToken: !!e.token, tokenHint: e.token ? e.token.slice(-4) : '', chatId: e.chatId, proxy: e.proxy,
    configured: !!(e.token && e.chatId), fromDashboard: { token: !!s.token, chatId: !!s.chatId, proxy: !!s.proxy },
  };
}

// fetch that goes through the proxy when one is set; plain global fetch (looked up at call time) otherwise
const agents = new Map();
function fetchFn() {
  const { proxy } = get();
  if (!proxy) return (...a) => global.fetch(...a);
  const undici = require('undici');
  if (!agents.has(proxy)) agents.set(proxy, new undici.ProxyAgent(proxy));
  const dispatcher = agents.get(proxy);
  return (url, opts = {}) => undici.fetch(url, { ...opts, dispatcher });
}

// "fetch failed" tells nothing; the real reason is in e.cause. Turn it into a sentence the person can act on.
const HINT = ' توجه: برنامه‌ی Node از تنظیم پروکسی مرورگر/ویندوز استفاده نمی‌کند؛ حتی اگر تلگرام در مرورگر باز می‌شود، باید «پیدا کردن خودکار پروکسی» را بزنید (یا آدرس پروکسی را خودتان بدهید)، یا VPN را در حالت «کل سیستم / TUN» روشن کنید.';
function describeError(e) {
  if (e && e.name === 'AbortError') return 'پاسخی از تلگرام نیامد (زمان تمام شد).' + HINT;
  const c = (e && e.cause) || {}, code = c.code || e.code || '', msg = String(c.message || e.message || '');
  const using = !!get().proxy;
  if (using && (/proxy/i.test(msg) || code === 'ECONNREFUSED')) return `به پروکسی ذخیره‌شده وصل نشد (${code || msg}). برنامه‌ی VPN/پروکسی روشن است و آدرس و پورت درست است؟ «پیدا کردن خودکار پروکسی» را امتحان کنید.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'آدرس api.telegram.org پیدا نشد (DNS یا اینترنت قطع/فیلتر است).' + HINT;
  if (code === 'ETIMEDOUT' || /TIMEOUT/i.test(code)) return 'اتصال به تلگرام زمان‌بر شد و قطع شد (احتمالاً فیلتر).' + HINT;
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'اتصال به تلگرام قطع شد (احتمالاً فیلتر).' + HINT;
  if (code === 'ECONNREFUSED') return 'اتصال به تلگرام رد شد (احتمالاً فیلتر).' + HINT;
  if (/CERT|SSL|TLS/i.test(code + msg)) return `خطای گواهی امنیتی (${code || msg}). ساعت کامپیوتر درست است؟ یا برنامه‌ی فیلترشکن اتصال را دستکاری می‌کند.`;
  return `اتصال به تلگرام ممکن نشد: ${msg}${code ? ` (${code})` : ''}.` + HINT;
}

// ---- finding a working proxy by itself ----
// Windows: the proxy the browser uses is in the registry (ProxyEnable / ProxyServer). Pure parsing, so it can be tested anywhere.
function parseWinProxy(enableOut, serverOut) {
  if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(String(enableOut || ''))) return [];
  const m = String(serverOut || '').match(/ProxyServer\s+REG_SZ\s+(.+)/i);
  if (!m) return [];
  const out = [];
  for (const part of m[1].trim().split(';')) {
    const kv = part.match(/^(?:(\w+)=)?(?:\w+:\/\/)?([^\s=]+:\d+)$/);
    if (!kv) continue;
    const scheme = (kv[1] || 'http').toLowerCase();
    if (scheme === 'http' || scheme === 'https') out.push(`http://${kv[2]}`); // socks=... entries are skipped: not supported
  }
  return [...new Set(out)];
}
function systemProxyCandidates() {
  const out = [];
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) { const v = process.env[k]; if (v && validProxy(v)) out.push(v); }
  if (process.platform === 'win32') {
    try {
      const { spawnSync } = require('child_process');
      const q = (name) => spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', name], { encoding: 'utf8', timeout: 5000, windowsHide: true }).stdout;
      out.push(...parseWinProxy(q('ProxyEnable'), q('ProxyServer')));
    } catch {}
  }
  return out;
}
const COMMON_PROXY_PORTS = [10809, 7890, 7897, 8080, 8118, 2081, 1087, 20171, 8888, 3128]; // v2rayN, Clash, Clash Verge, ...

// Opens a tunnel to api.telegram.org:443 through the proxy: HTTP 200 on CONNECT = this proxy can really reach Telegram.
function probeProxy(proxyUrl, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let u; try { u = new URL(proxyUrl); } catch { return resolve(false); }
    const sock = require('net').connect({ host: u.hostname, port: Number(u.port) || 80 });
    let done = false, buf = '';
    const end = (ok) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); resolve(ok); };
    const timer = setTimeout(() => end(false), timeoutMs);
    sock.on('error', () => end(false));
    sock.on('connect', () => sock.write('CONNECT api.telegram.org:443 HTTP/1.1\r\nHost: api.telegram.org:443\r\n\r\n'));
    sock.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n')) end(/^HTTP\/1\.[01] 200/.test(buf)); });
    sock.on('close', () => end(false));
  });
}
// Tries the system proxy first, then the usual local ports, all at once. Returns { ok, proxy, tried } .
async function findProxy(extra = []) {
  const list = [...new Set([...systemProxyCandidates(), ...extra, ...COMMON_PROXY_PORTS.map((p) => `http://127.0.0.1:${p}`)])];
  const results = await Promise.all(list.map(async (url) => ({ url, ok: await probeProxy(url) })));
  const hit = results.find((r) => r.ok);
  return hit ? { ok: true, proxy: hit.url, tried: list.length } : { ok: false, tried: list.length };
}

// Telegram API call with a time limit (for the test button and chat detection). Returns the parsed answer or { ok:false, description }.
async function api(method, body, timeoutMs = 15000) {
  const { token } = get();
  if (!token) return { ok: false, description: 'توکن ذخیره نشده' };
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchFn()(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: ac.signal });
    return await r.json();
  } catch (e) { return { ok: false, description: describeError(e) }; }
  finally { clearTimeout(timer); }
}

// Finds the chat id by itself: the person sends the bot any message (e.g. /start), then this reads the newest one.
async function detectChat() {
  const r = await api('getUpdates', { timeout: 0, limit: 20, allowed_updates: ['message'] });
  if (!r.ok) return { ok: false, error: r.description || 'خطا از تلگرام' };
  const msgs = (r.result || []).map((u) => u.message).filter((m) => m && m.chat && m.chat.type === 'private');
  if (!msgs.length) return { ok: false, error: 'پیامی پیدا نشد. اول در تلگرام به ربات خودتان یک پیام بدهید (مثلاً /start) و دوباره امتحان کنید.' };
  const m = msgs[msgs.length - 1];
  return { ok: true, chatId: String(m.chat.id), name: [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.username || '' };
}

module.exports = { get, set, clearSaved, view, fetchFn, api, detectChat, findProxy, probeProxy, parseWinProxy, describeError, file, TOKEN_RE, CHAT_RE };
